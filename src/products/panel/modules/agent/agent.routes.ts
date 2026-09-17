import { constants, createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import { authenticateAgentRequest } from "./agent-auth.js";
import {
  appendAgentCommandOutput,
  claimAgentCommand,
  completeAgentCommand,
} from "./agent-command.service.js";

const processSchema = z.object({
  pm2Id: z.number().int().nullable(),
  name: z.string().min(1).max(120),
  pid: z.number().int().nullable(),
  status: z.string().max(30),
  cpuPercent: z.number().min(0),
  memoryBytes: z.number().int().min(0),
  storageBytes: z.number().int().min(0).nullable().default(null),
  restartCount: z.number().int().min(0),
  startedAt: z.string().datetime().nullable(),
  revision: z.string().max(64).nullable(),
});

const heartbeatSchema = z.object({
  agentVersion: z.string().min(1).max(30),
  sentAt: z.string().datetime(),
  system: z.object({
    hostname: z.string().min(1).max(253),
    uptimeSeconds: z.number().int().min(0),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
    memoryTotalBytes: z.number().int().min(0),
    memoryUsedBytes: z.number().int().min(0),
    memoryUsedPercent: z.number().min(0).max(100),
    diskUsedPercent: z.number().min(0).max(100).nullable(),
    networkReceivedBytes: z.number().int().min(0).default(0),
    networkSentBytes: z.number().int().min(0).default(0),
  }),
  processes: z.array(processSchema).max(500),
  applicationTraffic: z
    .array(
      z.object({
        hostname: z.string().min(1).max(253),
        bytesSent: z.number().int().min(0),
      }),
    )
    .max(1000)
    .default([]),
});

const commandResultSchema = z.object({
  commandId: z.string().uuid(),
  leaseToken: z.string().min(32),
  succeeded: z.boolean(),
  cancelled: z.boolean().default(false),
  output: z.string().max(200_000).optional(),
  metadata: z
    .object({
      certificateExpiresAt: z.string().datetime().optional(),
      deploymentCommitSha: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
    })
    .optional(),
});

const commandProgressSchema = z.object({
  commandId: z.string().uuid(),
  leaseToken: z.string().min(32),
  chunk: z.string().max(65_536),
});

const releaseRoot = resolve(process.cwd(), "..");
const installerFiles = {
  script: resolve(releaseRoot, "ops", "scripts", "install-node-agent.sh"),
  runtime: resolve(
    releaseRoot,
    "artifacts",
    "lh-agent-runtime.tar.gz",
  ),
  checksum: resolve(
    releaseRoot,
    "artifacts",
    "lh-agent-runtime.tar.gz.sha256",
  ),
};

async function sendInstallerFile(
  reply: FastifyReply,
  path: string,
  contentType: string,
  filename: string,
) {
  try {
    await access(path, constants.R_OK);
  } catch {
    return reply.status(503).send({ error: "agent_installer_unavailable" });
  }
  reply
    .type(contentType)
    .header("Cache-Control", "no-store")
    .header("Content-Disposition", `attachment; filename="${filename}"`);
  return reply.send(createReadStream(path));
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/install.sh", async (_request, reply) =>
    sendInstallerFile(
      reply,
      installerFiles.script,
      "text/x-shellscript; charset=utf-8",
      "install-node-agent.sh",
    ),
  );

  app.get("/runtime.tar.gz", async (_request, reply) =>
    sendInstallerFile(
      reply,
      installerFiles.runtime,
      "application/gzip",
      "lh-agent-runtime.tar.gz",
    ),
  );

  app.get("/runtime.tar.gz.sha256", async (_request, reply) =>
    sendInstallerFile(
      reply,
      installerFiles.checksum,
      "text/plain; charset=utf-8",
      "lh-agent-runtime.tar.gz.sha256",
    ),
  );

  app.post("/heartbeat", async (request, reply) => {
    const nodeId = await authenticateAgentRequest(request);
    if (!nodeId)
      return reply.status(401).send({ error: "invalid_agent_credentials" });

    const payload = heartbeatSchema.safeParse(request.body);
    if (!payload.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: payload.error.flatten() });

    const pool = database();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE nodes SET status='online', agent_version=?, last_heartbeat_at=CURRENT_TIMESTAMP(3)
         WHERE id=UUID_TO_BIN(?)`,
        [payload.data.agentVersion, nodeId],
      );
      await connection.execute(
        `UPDATE node_agent_credentials SET last_used_at=CURRENT_TIMESTAMP(3)
         WHERE node_id=UUID_TO_BIN(?)`,
        [nodeId],
      );
      await connection.execute(
        `INSERT INTO node_metrics
         (node_id, load_1, load_5, load_15, memory_total_bytes, memory_used_bytes, memory_used_percent,
          disk_used_percent, network_received_bytes, network_sent_bytes, uptime_seconds)
         VALUES (UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nodeId,
          ...payload.data.system.loadAverage,
          payload.data.system.memoryTotalBytes,
          payload.data.system.memoryUsedBytes,
          payload.data.system.memoryUsedPercent,
          payload.data.system.diskUsedPercent,
          payload.data.system.networkReceivedBytes,
          payload.data.system.networkSentBytes,
          payload.data.system.uptimeSeconds,
        ],
      );

      for (const process of payload.data.processes) {
        await connection.execute(
          `INSERT INTO pm2_process_snapshots
           (node_id, pm2_id, process_name, process_status, pid, cpu_percent, memory_bytes, storage_bytes,
            restart_count, started_at, revision)
           VALUES (UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nodeId,
            process.pm2Id,
            process.name,
            process.status,
            process.pid,
            process.cpuPercent,
            process.memoryBytes,
            process.storageBytes,
            process.restartCount,
            process.startedAt,
            process.revision,
          ],
        );
      }

      const [applications] = await connection.query<
        (RowDataPacket & {
          id: string;
          processName: string;
          hostname: string;
        })[]
      >(
        `SELECT BIN_TO_UUID(a.id) AS id,a.pm2_process_name AS processName,d.hostname
         FROM applications a JOIN domains d ON d.id=a.domain_id
         WHERE a.node_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL`,
        [nodeId],
      );
      const processes = new Map(
        payload.data.processes.map((process) => [process.name, process]),
      );
      const traffic = new Map<string, number>();
      for (const item of payload.data.applicationTraffic) {
        traffic.set(
          item.hostname,
          (traffic.get(item.hostname) ?? 0) + item.bytesSent,
        );
      }
      for (const application of applications) {
        const process = processes.get(application.processName);
        await connection.execute(
          `INSERT INTO application_metrics
           (application_id,node_id,process_status,cpu_percent,memory_bytes,storage_bytes,traffic_bytes)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?)`,
          [
            application.id,
            nodeId,
            process?.status ?? "missing",
            process?.cpuPercent ?? 0,
            process?.memoryBytes ?? 0,
            process?.storageBytes ?? null,
            traffic.get(application.hostname) ?? 0,
          ],
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return reply.send({
      accepted: true,
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/commands/claim", async (request, reply) => {
    const nodeId = await authenticateAgentRequest(request);
    if (!nodeId)
      return reply.status(401).send({ error: "invalid_agent_credentials" });
    return {
      command: await claimAgentCommand(nodeId),
      serverTime: new Date().toISOString(),
    };
  });

  app.post("/commands/progress", async (request, reply) => {
    const nodeId = await authenticateAgentRequest(request);
    if (!nodeId)
      return reply.status(401).send({ error: "invalid_agent_credentials" });
    const progress = commandProgressSchema.safeParse(request.body);
    if (!progress.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: progress.error.flatten() });
    try {
      return {
        accepted: true,
        ...(await appendAgentCommandOutput(nodeId, progress.data)),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "invalid_or_expired_command_lease"
      )
        return reply.status(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/commands/result", async (request, reply) => {
    const nodeId = await authenticateAgentRequest(request);
    if (!nodeId)
      return reply.status(401).send({ error: "invalid_agent_credentials" });
    const result = commandResultSchema.safeParse(request.body);
    if (!result.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: result.error.flatten() });
    try {
      await completeAgentCommand(nodeId, result.data);
      return { accepted: true };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "invalid_or_expired_command_lease"
      ) {
        return reply.status(409).send({ error: error.message });
      }
      throw error;
    }
  });
};
