import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";
import { cancelDeployment } from "./deployment.service.js";

const deploymentParams = z.object({ deploymentId: z.string().uuid() });

function canMutate(role: string) {
  return role === "owner" || role === "administrator" || role === "developer";
}

export const deploymentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/deployments", async (request) => {
    const team = teamFrom(request);
    const [deployments] = await database().query<
      (RowDataPacket & {
        id: string;
        applicationId: string;
        applicationName: string;
        commandId: string | null;
        rollbackOfDeploymentId: string | null;
        commitSha: string | null;
        source: string;
        status: string;
        releasePath: string | null;
        startedAt: Date | null;
        finishedAt: Date | null;
        createdAt: Date;
      })[]
    >(
      `SELECT BIN_TO_UUID(d.id) AS id,BIN_TO_UUID(a.id) AS applicationId,a.name AS applicationName,
              BIN_TO_UUID(c.id) AS commandId,
              BIN_TO_UUID(d.rollback_of_deployment_id) AS rollbackOfDeploymentId,
              d.commit_sha AS commitSha,d.source,d.status,d.release_path AS releasePath,
              d.started_at AS startedAt,d.finished_at AS finishedAt,d.created_at AS createdAt
       FROM deployments d JOIN applications a ON a.id=d.application_id
       LEFT JOIN node_commands c ON c.deployment_id=d.id
       WHERE a.team_id=UUID_TO_BIN(?) ORDER BY d.created_at DESC LIMIT 200`,
      [team.id],
    );
    return { data: deployments, meta: { team } };
  });

  app.post("/deployments/:deploymentId/cancel", async (request, reply) => {
    const params = deploymentParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const team = teamFrom(request);
    if (!canMutate(team.role))
      return reply.status(403).send({ error: "team_write_required" });
    const user = (request as FastifyRequest & { sessionUser: SessionUser })
      .sessionUser;
    try {
      return reply.status(202).send({
        data: await cancelDeployment(params.data.deploymentId, team.id, user),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "deployment_cancel_failed";
      if (message === "deployment_not_found")
        return reply.status(404).send({ error: message });
      if (message === "deployment_not_cancellable")
        return reply.status(409).send({ error: message });
      throw error;
    }
  });
};
