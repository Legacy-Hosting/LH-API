import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createApplicationSchema } from "./application.schema.js";
import {
  createApplication,
  deleteApplicationEnvironmentVariable,
  listApplications,
  queueApplicationCommand,
  replaceApplicationEnvironment,
  upsertApplicationEnvironmentVariable,
} from "./application.service.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { z } from "zod";
import {
  getApplicationCommand,
  getApplicationDetails,
  queueApplicationLogSnapshot,
  queueRollback,
} from "./application-operations.service.js";

const applicationParams = z.object({ applicationId: z.string().uuid() });
const actionParams = applicationParams.extend({
  action: z.enum(["deploy", "start", "stop", "restart"]),
});
const environmentBody = z
  .object({
    environment: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z.string().max(65535),
    ),
  })
  .refine((value) => !("PORT" in value.environment), {
    path: ["environment", "PORT"],
    message: "PORT is managed by Legacy Hosting",
  });
const commandParams = applicationParams.extend({
  commandId: z.string().uuid(),
});
const rollbackParams = applicationParams.extend({
  deploymentId: z.string().uuid(),
});
const logsBody = z
  .object({ lines: z.number().int().min(10).max(500).default(200) });
const environmentVariableParams = applicationParams.extend({
  key: z
    .string()
    .max(191)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .refine((key) => key !== "PORT"),
});
const environmentVariableBody = z.object({ value: z.string().max(65535) });

function canMutate(role: string) {
  return role === "owner" || role === "administrator" || role === "developer";
}

export const applicationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/applications", async (request) => {
    const team = teamFrom(request);
    return { data: await listApplications(team.id), meta: { team } };
  });

  app.get("/applications/:applicationId", async (request, reply) => {
    const params = applicationParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    try {
      const team = teamFrom(request);
      return {
        data: await getApplicationDetails(params.data.applicationId, team.id),
        meta: { team },
      };
    } catch (error) {
      if (error instanceof Error && error.message === "application_not_found")
        return reply.status(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/applications", async (request, reply) => {
    const result = createApplicationSchema.safeParse(request.body);
    if (!result.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: result.error.flatten() });

    try {
      const team = teamFrom(request);
      if (!canMutate(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      const user = (request as FastifyRequest & { sessionUser: SessionUser })
        .sessionUser;
      return reply
        .status(201)
        .send({ data: await createApplication(result.data, team, user) });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "application_creation_failed";
      const conflict =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY";
      return reply
        .status(conflict ? 409 : 400)
        .send({ error: conflict ? "application_or_domain_exists" : message });
    }
  });

  app.put(
    "/applications/:applicationId/environment",
    async (request, reply) => {
      const params = applicationParams.safeParse(request.params);
      const body = environmentBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canMutate(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      try {
        await replaceApplicationEnvironment(
          params.data.applicationId,
          team.id,
          body.data.environment,
        );
        return {
          data: {
            updated: true,
            keys: Object.keys(body.data.environment).sort(),
          },
        };
      } catch (error) {
        if (error instanceof Error && error.message === "application_not_found")
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.put(
    "/applications/:applicationId/environment/:key",
    async (request, reply) => {
      const params = environmentVariableParams.safeParse(request.params);
      const body = environmentVariableBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canMutate(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      try {
        await upsertApplicationEnvironmentVariable(
          params.data.applicationId,
          team.id,
          params.data.key,
          body.data.value,
        );
        return { data: { updated: true, key: params.data.key } };
      } catch (error) {
        if (error instanceof Error && error.message === "application_not_found")
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.delete(
    "/applications/:applicationId/environment/:key",
    async (request, reply) => {
      const params = environmentVariableParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canMutate(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      const removed = await deleteApplicationEnvironmentVariable(
        params.data.applicationId,
        team.id,
        params.data.key,
      );
      if (!removed)
        return reply.status(404).send({ error: "environment_variable_not_found" });
      return reply.status(204).send();
    },
  );

  app.post(
    "/applications/:applicationId/actions/:action",
    async (request, reply) => {
      const params = actionParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canMutate(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      try {
        return reply
          .status(202)
          .send({
            data: await queueApplicationCommand(
              params.data.applicationId,
              team.id,
              params.data.action,
            ),
          });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "application_not_found")
            return reply.status(404).send({ error: error.message });
          if (error.message === "deployment_already_in_progress")
            return reply.status(409).send({ error: error.message });
          if (error.message === "application_not_deployable")
            return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    "/applications/:applicationId/logs",
    async (request, reply) => {
      const params = applicationParams.safeParse(request.params);
      const body = logsBody.safeParse(request.body ?? {});
      if (!params.success || !body.success)
        return reply.status(400).send({ error: "validation_error" });
      try {
        const team = teamFrom(request);
        return reply.status(202).send({
          data: await queueApplicationLogSnapshot(
            params.data.applicationId,
            team.id,
            body.data.lines,
          ),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "application_not_found"
        )
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get(
    "/applications/:applicationId/commands/:commandId",
    async (request, reply) => {
      const params = commandParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      try {
        const team = teamFrom(request);
        return {
          data: await getApplicationCommand(
            params.data.applicationId,
            params.data.commandId,
            team.id,
          ),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "command_not_found")
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get(
    "/applications/:applicationId/commands/:commandId/events",
    async (request, reply) => {
      const params = commandParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      let command;
      try {
        command = await getApplicationCommand(
          params.data.applicationId,
          params.data.commandId,
          team.id,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "command_not_found")
          return reply.status(404).send({ error: error.message });
        throw error;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write("retry: 1500\n\n");
      let closed = false;
      let lastSnapshot = "";
      let iteration = 0;
      request.raw.on("close", () => {
        closed = true;
      });

      while (!closed) {
        const snapshot = JSON.stringify({
          status: command.status,
          output: command.output ?? "",
          startedAt: command.startedAt,
          finishedAt: command.finishedAt,
          cancelRequestedAt: command.cancelRequestedAt,
        });
        if (snapshot !== lastSnapshot) {
          reply.raw.write(`event: command\ndata: ${snapshot}\n\n`);
          lastSnapshot = snapshot;
        } else if (iteration % 15 === 0) {
          reply.raw.write(": keepalive\n\n");
        }
        if (["succeeded", "failed", "cancelled"].includes(command.status))
          break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (closed) break;
        try {
          command = await getApplicationCommand(
            params.data.applicationId,
            params.data.commandId,
            team.id,
          );
        } catch {
          break;
        }
        iteration += 1;
      }
      if (!closed) reply.raw.end();
    },
  );

  app.post(
    "/applications/:applicationId/deployments/:deploymentId/rollback",
    async (request, reply) => {
      const params = rollbackParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canMutate(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      const user = (request as FastifyRequest & { sessionUser: SessionUser })
        .sessionUser;
      try {
        return reply.status(202).send({
          data: await queueRollback(
            params.data.applicationId,
            params.data.deploymentId,
            team.id,
            user,
          ),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "rollback_queue_failed";
        if (message === "rollback_target_not_found")
          return reply.status(404).send({ error: message });
        if (message === "deployment_already_in_progress")
          return reply.status(409).send({ error: message });
        return reply.status(400).send({ error: message });
      }
    },
  );

  app.delete("/applications/:applicationId", async (request, reply) => {
    const params = applicationParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const team = teamFrom(request);
    if (!canMutate(team.role))
      return reply.status(403).send({ error: "team_write_required" });
    try {
      return reply
        .status(202)
        .send({
          data: await queueApplicationCommand(
            params.data.applicationId,
            team.id,
            "delete",
          ),
        });
    } catch (error) {
      if (error instanceof Error && error.message === "application_not_found")
        return reply.status(404).send({ error: error.message });
      throw error;
    }
  });
};
