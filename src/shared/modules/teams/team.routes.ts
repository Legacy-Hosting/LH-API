import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";
import { randomToken, tokenHash } from "../auth/auth.crypto.js";
import { requireSession } from "../auth/auth.guard.js";
import type { SessionUser } from "../auth/auth.types.js";
import {
  applySupportContext,
  effectiveUserId,
} from "../auth/support-context.js";

type MembershipRole = "owner" | "administrator" | "developer" | "viewer";
type MembershipRow = RowDataPacket & { role: MembershipRole };

const teamParams = z.object({ teamId: z.string().uuid() });
const invitationParams = teamParams.extend({ invitationId: z.string().uuid() });
const createInvitationBody = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(["administrator", "developer", "viewer"]).default("viewer"),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
const updateTeamBody = z.object({
  name: z.string().trim().min(2).max(120),
});
export const createTeamBody = updateTeamBody;
const acceptInvitationBody = z.object({ token: z.string().min(20) });

export function createTeamSlug(name: string, suffix = randomUUID().slice(0, 8)) {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 71);
  return `${base || "team"}-${suffix}`;
}

function userFrom(request: FastifyRequest): SessionUser {
  return (request as FastifyRequest & { sessionUser: SessionUser }).sessionUser;
}

async function membership(userId: string, teamId: string) {
  const [rows] = await database().query<MembershipRow[]>(
    "SELECT role FROM team_members WHERE user_id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) LIMIT 1",
    [userId, teamId],
  );
  return rows[0];
}

function canManageTeam(role: MembershipRole) {
  return role === "owner" || role === "administrator";
}

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireSession);
  app.addHook("preHandler", applySupportContext);

  app.get("/", async (request) => {
    const user = userFrom(request);
    const [teams] = await database().query<
      (RowDataPacket & {
        id: string;
        name: string;
        slug: string;
        role: MembershipRole;
      })[]
    >(
      `SELECT BIN_TO_UUID(t.id) AS id,t.name,t.slug,tm.role
       FROM team_members tm JOIN teams t ON t.id=tm.team_id
       WHERE tm.user_id=UUID_TO_BIN(?) ORDER BY t.name`,
      [effectiveUserId(user)],
    );
    return { data: teams };
  });

  app.post("/", async (request, reply) => {
    const body = createTeamBody.safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });

    const user = userFrom(request);
    if (user.supportUserId)
      return reply.status(403).send({ error: "support_action_not_allowed" });
    const teamId = randomUUID();
    const slug = createTeamSlug(body.data.name);
    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "INSERT INTO teams (id,name,slug) VALUES (UUID_TO_BIN(?),?,?)",
        [teamId, body.data.name, slug],
      );
      await connection.execute(
        "INSERT INTO team_members (team_id,user_id,role) VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'owner')",
        [teamId, user.id],
      );
      await connection.execute(
        `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','team.created','team',?,?)`,
        [
          teamId,
          user.id,
          teamId,
          JSON.stringify({ name: body.data.name, slug }),
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return reply.status(201).send({
      data: {
        id: teamId,
        name: body.data.name,
        slug,
        role: "owner" as const,
      },
    });
  });

  app.patch("/:teamId", async (request, reply) => {
    const params = teamParams.safeParse(request.params);
    const body = updateTeamBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: "validation_error" });

    const user = userFrom(request);
    const access = await membership(effectiveUserId(user), params.data.teamId);
    if (!access || !canManageTeam(access.role))
      return reply.status(403).send({ error: "team_admin_required" });

    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE teams SET name=? WHERE id=UUID_TO_BIN(?)",
        [body.data.name, params.data.teamId],
      );
      if (!result.affectedRows) {
        await connection.rollback();
        return reply.status(404).send({ error: "team_not_found" });
      }
      await connection.execute(
        `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','team.updated','team',?,?)`,
        [
          params.data.teamId,
          user.id,
          params.data.teamId,
          JSON.stringify({ name: body.data.name }),
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return {
      data: { id: params.data.teamId, name: body.data.name },
    };
  });

  app.get("/:teamId/members", async (request, reply) => {
    const params = teamParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const user = userFrom(request);
    const access = await membership(
      effectiveUserId(user),
      params.data.teamId,
    );
    if (!access)
      return reply.status(403).send({ error: "team_access_required" });

    const [members] = await database().query<
      (RowDataPacket & {
        id: string;
        email: string;
        displayName: string;
        role: MembershipRole;
        joinedAt: Date;
      })[]
    >(
      `SELECT BIN_TO_UUID(u.id) AS id,u.email,u.display_name AS displayName,tm.role,tm.created_at AS joinedAt
       FROM team_members tm JOIN users u ON u.id=tm.user_id
       WHERE tm.team_id=UUID_TO_BIN(?) ORDER BY tm.created_at`,
      [params.data.teamId],
    );
    return { data: members };
  });

  app.get("/:teamId/invitations", async (request, reply) => {
    const params = teamParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const user = userFrom(request);
    const access = await membership(
      effectiveUserId(user),
      params.data.teamId,
    );
    if (!access || !canManageTeam(access.role))
      return reply.status(403).send({ error: "team_admin_required" });

    const [invitations] = await database().query<
      (RowDataPacket & {
        id: string;
        email: string;
        role: MembershipRole;
        expiresAt: Date;
        createdAt: Date;
      })[]
    >(
      `SELECT BIN_TO_UUID(id) AS id,email,role,expires_at AS expiresAt,created_at AS createdAt
       FROM invitations WHERE team_id=UUID_TO_BIN(?) AND accepted_at IS NULL
         AND expires_at>CURRENT_TIMESTAMP(3) ORDER BY created_at DESC`,
      [params.data.teamId],
    );
    return { data: invitations };
  });

  app.post("/:teamId/invitations", async (request, reply) => {
    const params = teamParams.safeParse(request.params);
    const body = createInvitationBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: "validation_error" });
    const user = userFrom(request);
    const access = await membership(effectiveUserId(user), params.data.teamId);
    if (!access || !canManageTeam(access.role))
      return reply.status(403).send({ error: "team_admin_required" });

    const email = body.data.email.toLowerCase();
    const [existingMembers] = await database().query<RowDataPacket[]>(
      `SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id
       WHERE tm.team_id=UUID_TO_BIN(?) AND u.email=? LIMIT 1`,
      [params.data.teamId, email],
    );
    if (existingMembers[0])
      return reply.status(409).send({ error: "already_a_team_member" });

    const token = randomToken(32);
    const invitationId = randomUUID();
    const expiresAt = new Date(
      Date.now() + body.data.expiresInDays * 86_400_000,
    );
    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE invitations SET expires_at=CURRENT_TIMESTAMP(3)
         WHERE team_id=UUID_TO_BIN(?) AND email=? AND accepted_at IS NULL`,
        [params.data.teamId, email],
      );
      await connection.execute(
        `INSERT INTO invitations (id,team_id,email,role,token_hash,invited_by,expires_at)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,UUID_TO_BIN(?),?)`,
        [
          invitationId,
          params.data.teamId,
          email,
          body.data.role,
          tokenHash(token),
          user.id,
          expiresAt,
        ],
      );
      await connection.execute(
        `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','team.invitation.created','invitation',?,?)`,
        [
          params.data.teamId,
          user.id,
          invitationId,
          JSON.stringify({ email, role: body.data.role }),
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return reply.status(201).send({
      data: {
        id: invitationId,
        email,
        role: body.data.role,
        expiresAt,
        invitationUrl: `${env.PANEL_ORIGIN.replace(/\/$/, "")}/?invite=${encodeURIComponent(token)}`,
      },
    });
  });

  app.delete("/:teamId/invitations/:invitationId", async (request, reply) => {
    const params = invitationParams.safeParse(request.params);
    if (!params.success)
      return reply.status(400).send({ error: "validation_error" });
    const user = userFrom(request);
    const access = await membership(
      effectiveUserId(user),
      params.data.teamId,
    );
    if (!access || !canManageTeam(access.role))
      return reply.status(403).send({ error: "team_admin_required" });
    await database().execute(
      `UPDATE invitations SET expires_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND accepted_at IS NULL`,
      [params.data.invitationId, params.data.teamId],
    );
    return reply.status(204).send();
  });

  app.post("/invitations/accept", async (request, reply) => {
    const body = acceptInvitationBody.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: "validation_error" });
    const user = userFrom(request);
    if (user.supportUserId)
      return reply.status(403).send({ error: "support_action_not_allowed" });
    const [rows] = await database().query<
      (RowDataPacket & { id: string; teamId: string; role: MembershipRole })[]
    >(
      `SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(team_id) AS teamId,role FROM invitations
       WHERE token_hash=? AND email=? AND accepted_at IS NULL
         AND expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
      [tokenHash(body.data.token), user.email.toLowerCase()],
    );
    const invitation = rows[0];
    if (!invitation)
      return reply.status(404).send({ error: "invalid_invitation" });

    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO team_members (team_id,user_id,role) VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?)
         ON DUPLICATE KEY UPDATE role=VALUES(role)`,
        [invitation.teamId, user.id, invitation.role],
      );
      await connection.execute(
        "UPDATE invitations SET accepted_at=CURRENT_TIMESTAMP(3) WHERE id=UUID_TO_BIN(?)",
        [invitation.id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return { data: { teamId: invitation.teamId, role: invitation.role } };
  });
};
