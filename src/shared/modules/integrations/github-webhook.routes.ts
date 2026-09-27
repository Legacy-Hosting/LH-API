import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";

const githubIdentity = z.object({
  name: z.string().max(255).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  username: z.string().max(255).nullable().optional(),
});

const githubCommit = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/i),
  message: z.string().max(20_000),
  timestamp: z.string(),
  url: z.string().url(),
  author: githubIdentity.nullable().optional(),
  committer: githubIdentity.nullable().optional(),
  distinct: z.boolean().optional(),
});

const pushPayload = z.object({
  ref: z.string(),
  before: z.string().regex(/^[a-f0-9]{40}$/i),
  after: z.string().regex(/^[a-f0-9]{40}$/i),
  created: z.boolean().default(false),
  deleted: z.boolean().default(false),
  forced: z.boolean().default(false),
  compare: z.string().url().optional(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({
    full_name: z.string().min(3).max(255),
    html_url: z.string().url(),
    private: z.boolean().default(false),
    default_branch: z.string().min(1).max(255).optional(),
  }),
  pusher: githubIdentity,
  sender: z.object({
    login: z.string().min(1).max(255),
    avatar_url: z.string().url().optional(),
    html_url: z.string().url().optional(),
  }),
  head_commit: githubCommit.nullable().optional(),
  commits: z.array(githubCommit).max(100).default([]),
});

type PushPayload = z.infer<typeof pushPayload>;
type ApplicationRow = RowDataPacket & { id: string; nodeId: string; status: string };
type DeliveryRow = RowDataPacket & { hubForwardedAt: Date | null };

function safeEqual(value: string | string[] | undefined, expected: string | undefined) {
  if (!expected || typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function verifySignature(rawBody: Buffer, signature: string) {
  if (!env.GITHUB_WEBHOOK_SECRET) throw new Error("GitHub webhook secret is not configured");
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(rawBody).digest();
  const received = Buffer.from(signature.slice(7), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sanitizedPush(deliveryId: string, push: PushPayload) {
  const cleanCommit = (commit: PushPayload["commits"][number]) => ({
    ...commit,
    message: commit.message.slice(0, 1_000),
  });
  return {
    deliveryId,
    repository: {
      fullName: push.repository.full_name,
      url: push.repository.html_url,
      private: push.repository.private,
      defaultBranch: push.repository.default_branch ?? "main",
    },
    ref: push.ref,
    branch: push.ref.startsWith("refs/heads/") ? push.ref.slice("refs/heads/".length) : push.ref,
    before: push.before,
    after: push.after,
    compareUrl: push.compare ?? push.repository.html_url,
    created: push.created,
    deleted: push.deleted,
    forced: push.forced,
    pusher: { name: push.pusher.name ?? push.sender.login, email: push.pusher.email ?? null },
    sender: push.sender,
    headCommit: push.head_commit ? cleanCommit(push.head_commit) : null,
    commits: push.commits.slice(0, 50).map(cleanCommit),
    receivedAt: new Date().toISOString(),
  };
}

async function forwardPushToHub(deliveryId: string, push: PushPayload) {
  if (!env.HUB_INTERNAL_TOKEN) throw new Error("Hub internal token is not configured");
  const response = await fetch(new URL("/api/v1/internal/github/push", env.HUB_INTERNAL_URL), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-lh-hub-token": env.HUB_INTERNAL_TOKEN,
    },
    body: JSON.stringify(sanitizedPush(deliveryId, push)),
    redirect: "error",
    signal: AbortSignal.timeout(env.GITHUB_HUB_FORWARD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Hub rejected GitHub push delivery with ${response.status}`);
  await database().execute(
    "UPDATE github_webhook_deliveries SET hub_forwarded_at=CURRENT_TIMESTAMP(3) WHERE delivery_id=?",
    [deliveryId],
  );
}

export const githubWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.get("/internal/hub/github/repositories", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!safeEqual(request.headers["x-lh-hub-token"], env.HUB_INTERNAL_TOKEN)) {
      return reply.status(401).send({ error: "invalid_hub_token" });
    }
    const [rows] = await database().query<
      (RowDataPacket & {
        fullName: string;
        url: string | null;
        defaultBranch: string | null;
        privateRepository: string | null;
      })[]
    >(
      `SELECT DISTINCT r.display_name AS fullName,
         JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.htmlUrl')) AS url,
         JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.defaultBranch')) AS defaultBranch,
         JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.private')) AS privateRepository
       FROM integration_resources r
       JOIN integrations i ON i.id=r.integration_id
       WHERE i.provider='github' AND i.disconnected_at IS NULL
         AND r.resource_type='repository' AND r.enabled=TRUE
       ORDER BY r.display_name`,
    );
    return {
      repositories: rows.map((row) => ({
        fullName: row.fullName,
        url: row.url ?? `https://github.com/${row.fullName}`,
        defaultBranch: row.defaultBranch ?? "main",
        private: row.privateRepository === "true",
      })),
    };
  });

  app.post("/github/webhook", { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"];
    const event = request.headers["x-github-event"];
    const delivery = request.headers["x-github-delivery"];
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (
      typeof signature !== "string" || typeof event !== "string" ||
      typeof delivery !== "string" || !rawBody
    ) {
      return reply.status(401).send({ error: "github_webhook_authentication_required" });
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(delivery) || !verifySignature(rawBody, signature)) {
      return reply.status(401).send({ error: "invalid_github_webhook_signature" });
    }

    const body = request.body as Record<string, unknown>;
    const push = event === "push" ? pushPayload.safeParse(body) : null;
    if (push && !push.success) return reply.status(400).send({ error: "invalid_github_push_payload" });
    const action = typeof body.action === "string" ? body.action.slice(0, 80) : null;
    const installationId = typeof (body.installation as { id?: unknown } | undefined)?.id === "number"
      ? (body.installation as { id: number }).id
      : null;
    const connection = await database().getConnection();
    let duplicate = false;
    try {
      await connection.beginTransaction();
      try {
        await connection.execute(
          `INSERT INTO github_webhook_deliveries (delivery_id,event_name,action_name,installation_id,payload)
           VALUES (?,?,?,?,?)`,
          [delivery, event.slice(0, 80), action, installationId, JSON.stringify(body)],
        );
      } catch (error) {
        if (
          typeof error === "object" && error !== null && "code" in error &&
          error.code === "ER_DUP_ENTRY"
        ) {
          duplicate = true;
          await connection.rollback();
        } else {
          throw error;
        }
      }

      if (!duplicate) {
        let queued = 0;
        if (
          push?.success && push.data.installation && !push.data.deleted &&
          push.data.ref.startsWith("refs/heads/")
        ) {
          const branch = push.data.ref.slice("refs/heads/".length);
          const [applications] = await connection.query<ApplicationRow[]>(
            `SELECT DISTINCT BIN_TO_UUID(a.id) AS id,BIN_TO_UUID(a.node_id) AS nodeId,a.status
             FROM applications a JOIN integrations i ON i.team_id=a.team_id
             WHERE i.provider='github' AND i.disconnected_at IS NULL AND i.external_account_id=?
               AND a.repository_full_name=? AND a.repository_branch=? AND a.auto_deploy=TRUE`,
            [String(push.data.installation.id), push.data.repository.full_name, branch],
          );
          for (const application of applications) {
            const deploymentId = randomUUID();
            const commandId = randomUUID();
            await connection.execute(
              `INSERT INTO deployments (id,application_id,commit_sha,source,status)
               VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,'github_push','queued')`,
              [deploymentId, application.id, push.data.after],
            );
            await connection.execute(
              `INSERT INTO node_commands (id,node_id,application_id,deployment_id,command_type,payload)
               VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'deploy',?)`,
              [commandId, application.nodeId, application.id, deploymentId, JSON.stringify({
                deploymentId,
                commitSha: push.data.after,
                previousApplicationStatus: application.status === "deploying" ? "running" : application.status,
              })],
            );
            await connection.execute(
              "UPDATE applications SET status='deploying' WHERE id=UUID_TO_BIN(?)",
              [application.id],
            );
            queued += 1;
          }
        }
        await connection.execute(
          "UPDATE github_webhook_deliveries SET processed_at=CURRENT_TIMESTAMP(3) WHERE delivery_id=?",
          [delivery],
        );
        await connection.commit();
        if (push?.success) {
          try {
            await forwardPushToHub(delivery, push.data);
          } catch (error) {
            request.log.error({ err: error, delivery }, "GitHub push could not be forwarded to Hub");
            return reply.status(503).send({ accepted: false, retryable: true, queued });
          }
        }
        return reply.status(202).send({ accepted: true, queued });
      }
    } catch (error) {
      if (!duplicate) await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const [deliveries] = await database().query<DeliveryRow[]>(
      "SELECT hub_forwarded_at AS hubForwardedAt FROM github_webhook_deliveries WHERE delivery_id=? LIMIT 1",
      [delivery],
    );
    if (push?.success && !deliveries[0]?.hubForwardedAt) {
      try {
        await forwardPushToHub(delivery, push.data);
      } catch (error) {
        request.log.error({ err: error, delivery }, "Duplicate GitHub push could not be forwarded to Hub");
        return reply.status(503).send({ accepted: false, retryable: true, duplicate: true });
      }
    }
    return reply.status(202).send({ accepted: true, duplicate: true });
  });
};
