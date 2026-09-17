import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import {
  randomToken,
  tokenHash,
} from "../../../../shared/modules/auth/auth.crypto.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  );
const ipv4Address = z
  .string()
  .trim()
  .refine((value) => isIP(value) === 4, "Invalid IPv4 address");
const ipv6Address = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => isIP(value) === 6, "Invalid IPv6 address");
const nodeNetworkFields = z.object({
  publicFqdn: hostname,
  publicIpv4: ipv4Address.optional(),
  publicIpv6: ipv6Address.optional(),
  privateFqdn: hostname.optional(),
  privateIpv4: ipv4Address.optional(),
  privateIpv6: ipv6Address.optional(),
  cnameTarget: hostname,
  region: z.string().trim().max(80).optional(),
});
export const createNodeBody = nodeNetworkFields
  .extend({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  })
  .refine((value) => value.publicIpv4 || value.publicIpv6, {
    message: "At least one public IP address is required",
    path: ["publicIpv4"],
  });
const nodeParams = z.object({ nodeId: z.string().uuid() });
const updateNodeBody = nodeNetworkFields
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

function userFrom(request: FastifyRequest) {
  return (request as FastifyRequest & { sessionUser: SessionUser }).sessionUser;
}

function canManageNodes(role: string) {
  return role === "owner" || role === "administrator";
}

function setup(nodeId: string, token: string) {
  return {
    nodeId,
    token,
    environment: {
      LH_API_URL: "https://api.legacyhosting.xyz/api/v1",
      LH_NODE_ID: nodeId,
      LH_AGENT_TOKEN: token,
      LH_HEARTBEAT_INTERVAL_MS: "30000",
    },
    warning:
      "The node token is shown once and cannot be recovered. Store it only in the agent environment file.",
  };
}

export const nodeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/nodes", async (request) => {
    const team = teamFrom(request);
    const [nodes] = await database().query<
      (RowDataPacket & {
        id: string;
        name: string;
        publicFqdn: string;
        publicIpv4: string | null;
        publicIpv6: string | null;
        privateFqdn: string | null;
        privateIpv4: string | null;
        privateIpv6: string | null;
        publicIp: string | null;
        privateIp: string | null;
        cnameTarget: string;
        region: string | null;
        status: string;
        agentVersion: string | null;
        lastHeartbeatAt: Date | null;
        load1: number | null;
        memory: number | null;
        disk: number | null;
      })[]
    >(
      `SELECT BIN_TO_UUID(n.id) AS id,n.name,n.public_fqdn AS publicFqdn,
              n.public_ip AS publicIpv4,n.public_ipv6 AS publicIpv6,
              n.private_fqdn AS privateFqdn,n.private_ip AS privateIpv4,n.private_ipv6 AS privateIpv6,
              n.public_ip AS publicIp,n.private_ip AS privateIp,n.cname_target AS cnameTarget,
              n.region,n.status,n.agent_version AS agentVersion,
              n.last_heartbeat_at AS lastHeartbeatAt,m.load_1 AS load1,
              m.memory_used_percent AS memory,m.disk_used_percent AS disk
       FROM nodes n
       LEFT JOIN node_metrics m ON m.id=(SELECT nm.id FROM node_metrics nm WHERE nm.node_id=n.id ORDER BY nm.recorded_at DESC LIMIT 1)
       WHERE n.team_id=UUID_TO_BIN(?) ORDER BY n.name`,
      [team.id],
    );
    return { data: nodes, meta: { team } };
  });

  app.post("/nodes", async (request, reply) => {
    const body = createNodeBody.safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });
    const team = teamFrom(request);
    if (!canManageNodes(team.role))
      return reply.status(403).send({ error: "team_admin_required" });

    const user = userFrom(request);
    const nodeId = randomUUID();
    const token = randomToken(32);
    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO nodes
         (id,team_id,name,public_fqdn,public_ip,public_ipv6,private_fqdn,private_ip,private_ipv6,cname_target,region,status)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,'pending')`,
        [
          nodeId,
          team.id,
          body.data.name,
          body.data.publicFqdn,
          body.data.publicIpv4 ?? null,
          body.data.publicIpv6 ?? null,
          body.data.privateFqdn ?? null,
          body.data.privateIpv4 ?? null,
          body.data.privateIpv6 ?? null,
          body.data.cnameTarget,
          body.data.region ?? null,
        ],
      );
      await connection.execute(
        "INSERT INTO node_agent_credentials (node_id,authentication_key) VALUES (UUID_TO_BIN(?),?)",
        [nodeId, tokenHash(token)],
      );
      await connection.execute(
        `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','node.created','node',?,?)`,
        [
          team.id,
          user.id,
          nodeId,
          JSON.stringify({
            name: body.data.name,
            publicFqdn: body.data.publicFqdn,
            publicIpv4: body.data.publicIpv4,
            publicIpv6: body.data.publicIpv6,
            cnameTarget: body.data.cnameTarget,
          }),
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        return reply.status(409).send({ error: "node_name_exists" });
      }
      throw error;
    } finally {
      connection.release();
    }
    return reply
      .status(201)
      .send({
        data: {
          id: nodeId,
          ...body.data,
          status: "pending",
          agent: setup(nodeId, token),
        },
      });
  });

  app.patch("/nodes/:nodeId", async (request, reply) => {
    const params = nodeParams.safeParse(request.params);
    const body = updateNodeBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: "validation_error" });
    const team = teamFrom(request);
    if (!canManageNodes(team.role))
      return reply.status(403).send({ error: "team_admin_required" });

    const fields: string[] = [];
    const values: (string | null)[] = [];
    const columns = {
      publicFqdn: "public_fqdn",
      publicIpv4: "public_ip",
      publicIpv6: "public_ipv6",
      privateFqdn: "private_fqdn",
      privateIpv4: "private_ip",
      privateIpv6: "private_ipv6",
      cnameTarget: "cname_target",
      region: "region",
    } as const;
    for (const [key, column] of Object.entries(columns) as [
      keyof typeof columns,
      string,
    ][]) {
      if (body.data[key] !== undefined) {
        fields.push(`${column}=?`);
        values.push(body.data[key]);
      }
    }
    const [result] = await database().execute(
      `UPDATE nodes SET ${fields.join(",")} WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?)`,
      [...values, params.data.nodeId, team.id],
    );
    if (!(result as ResultSetHeader).affectedRows)
      return reply.status(404).send({ error: "node_not_found" });
    return { data: { id: params.data.nodeId, ...body.data } };
  });

  app.post("/nodes/:nodeId/rotate-token", async (request, reply) => {
    const params = nodeParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const team = teamFrom(request);
    if (!canManageNodes(team.role))
      return reply.status(403).send({ error: "team_admin_required" });
    const token = randomToken(32);
    const [result] = await database().execute(
      `UPDATE node_agent_credentials c JOIN nodes n ON n.id=c.node_id
       SET c.authentication_key=?,c.created_at=CURRENT_TIMESTAMP(3),c.last_used_at=NULL,c.revoked_at=NULL
       WHERE c.node_id=UUID_TO_BIN(?) AND n.team_id=UUID_TO_BIN(?)`,
      [tokenHash(token), params.data.nodeId, team.id],
    );
    if (!(result as ResultSetHeader).affectedRows)
      return reply.status(404).send({ error: "node_not_found" });
    return { data: setup(params.data.nodeId, token) };
  });

  app.delete("/nodes/:nodeId", async (request, reply) => {
    const params = nodeParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const team = teamFrom(request);
    if (!canManageNodes(team.role))
      return reply.status(403).send({ error: "team_admin_required" });
    const [applications] = await database().query<RowDataPacket[]>(
      "SELECT 1 FROM applications WHERE node_id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) LIMIT 1",
      [params.data.nodeId, team.id],
    );
    if (applications[0])
      return reply.status(409).send({ error: "node_has_applications" });
    const [result] = await database().execute(
      "DELETE FROM nodes WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?)",
      [params.data.nodeId, team.id],
    );
    if (!(result as ResultSetHeader).affectedRows)
      return reply.status(404).send({ error: "node_not_found" });
    return reply.status(204).send();
  });
};
