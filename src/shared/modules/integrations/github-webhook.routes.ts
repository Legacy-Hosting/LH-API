import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";

const pushPayload = z.object({
  ref: z.string(),
  after: z.string().regex(/^[a-f0-9]{40}$/i),
  deleted: z.boolean().default(false),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().min(3).max(255) }),
});

type ApplicationRow = RowDataPacket & {
  id: string;
  nodeId: string;
  status: string;
};

function verifySignature(rawBody: Buffer, signature: string) {
  if (!env.GITHUB_WEBHOOK_SECRET)
    throw new Error("GitHub webhook secret is not configured");
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest();
  const received = Buffer.from(signature.slice(7), "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export const githubWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/github/webhook",
    { config: { rawBody: true } },
    async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"];
      const event = request.headers["x-github-event"];
      const delivery = request.headers["x-github-delivery"];
      const rawBody = (request as FastifyRequest & { rawBody?: Buffer })
        .rawBody;
      if (
        typeof signature !== "string" ||
        typeof event !== "string" ||
        typeof delivery !== "string" ||
        !rawBody
      ) {
        return reply
          .status(401)
          .send({ error: "github_webhook_authentication_required" });
      }
      if (
        !/^[A-Za-z0-9-]{1,64}$/.test(delivery) ||
        !verifySignature(rawBody, signature)
      ) {
        return reply
          .status(401)
          .send({ error: "invalid_github_webhook_signature" });
      }

      const body = request.body as Record<string, unknown>;
      const action =
        typeof body.action === "string" ? body.action.slice(0, 80) : null;
      const installationId =
        typeof (body.installation as { id?: unknown } | undefined)?.id ===
        "number"
          ? (body.installation as { id: number }).id
          : null;
      const connection = await database().getConnection();
      try {
        await connection.beginTransaction();
        try {
          await connection.execute(
            `INSERT INTO github_webhook_deliveries (delivery_id,event_name,action_name,installation_id,payload)
           VALUES (?,?,?,?,?)`,
            [
              delivery,
              event.slice(0, 80),
              action,
              installationId,
              JSON.stringify(body),
            ],
          );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ER_DUP_ENTRY"
          ) {
            await connection.rollback();
            return reply.status(202).send({ accepted: true, duplicate: true });
          }
          throw error;
        }

        let queued = 0;
        if (event === "push") {
          const parsed = pushPayload.safeParse(body);
          if (!parsed.success) {
            await connection.rollback();
            return reply
              .status(400)
              .send({ error: "invalid_github_push_payload" });
          }
          if (
            !parsed.data.deleted &&
            parsed.data.ref.startsWith("refs/heads/")
          ) {
            const branch = parsed.data.ref.slice("refs/heads/".length);
            const [applications] = await connection.query<ApplicationRow[]>(
              `SELECT DISTINCT BIN_TO_UUID(a.id) AS id,BIN_TO_UUID(a.node_id) AS nodeId,a.status
             FROM applications a JOIN integrations i ON i.team_id=a.team_id
             WHERE i.provider='github' AND i.disconnected_at IS NULL AND i.external_account_id=?
               AND a.repository_full_name=? AND a.repository_branch=? AND a.auto_deploy=TRUE`,
              [
                String(parsed.data.installation.id),
                parsed.data.repository.full_name,
                branch,
              ],
            );
            for (const application of applications) {
              const deploymentId = randomUUID();
              const commandId = randomUUID();
              await connection.execute(
                `INSERT INTO deployments (id,application_id,commit_sha,source,status)
               VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,'github_push','queued')`,
                [deploymentId, application.id, parsed.data.after],
              );
              await connection.execute(
                `INSERT INTO node_commands (id,node_id,application_id,deployment_id,command_type,payload)
               VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'deploy',?)`,
                [
                  commandId,
                  application.nodeId,
                  application.id,
                  deploymentId,
                  JSON.stringify({
                    deploymentId,
                    commitSha: parsed.data.after,
                    previousApplicationStatus:
                      application.status === "deploying"
                        ? "running"
                        : application.status,
                  }),
                ],
              );
              await connection.execute(
                "UPDATE applications SET status='deploying' WHERE id=UUID_TO_BIN(?)",
                [application.id],
              );
              queued += 1;
            }
          }
        }
        await connection.execute(
          "UPDATE github_webhook_deliveries SET processed_at=CURRENT_TIMESTAMP(3) WHERE delivery_id=?",
          [delivery],
        );
        await connection.commit();
        return reply.status(202).send({ accepted: true, queued });
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
  );
};
