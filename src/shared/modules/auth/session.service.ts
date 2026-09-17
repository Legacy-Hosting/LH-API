import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";
import { randomToken, tokenHash } from "./auth.crypto.js";
import type { SessionUser } from "./auth.types.js";

export const SESSION_COOKIE_NAME = "lh_session";

type SessionRow = RowDataPacket & {
  id: string;
  email: string;
  display_name: string;
  is_platform_admin: number;
};

export async function createSession(
  userId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);
  await database().execute(
    `INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, ?)`,
    [
      randomUUID(),
      userId,
      tokenHash(token),
      request.ip,
      request.headers["user-agent"]?.slice(0, 512) ?? null,
      expiresAt,
    ],
  );
  await database().execute(
    `DELETE FROM user_sessions WHERE user_id=UUID_TO_BIN(?)
     AND (expires_at<=CURRENT_TIMESTAMP(3) OR revoked_at IS NOT NULL)`,
    [userId],
  );
  await database().execute(
    `UPDATE user_sessions SET revoked_at=CURRENT_TIMESTAMP(3)
     WHERE user_id=UUID_TO_BIN(?) AND revoked_at IS NULL AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM user_sessions WHERE user_id=UUID_TO_BIN(?) AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 10
       ) newest_sessions
     )`,
    [userId, userId],
  );

  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    priority: "high",
    path: "/",
    domain: env.SESSION_COOKIE_DOMAIN || undefined,
    expires: expiresAt,
  });
}

export async function resolveSession(
  request: FastifyRequest,
): Promise<SessionUser | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const [rows] = await database().query<SessionRow[]>(
    `SELECT BIN_TO_UUID(u.id) AS id, u.email, u.display_name, u.is_platform_admin
     FROM user_sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP(3)
       AND u.status='active'
     LIMIT 1`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) return null;

  await database().execute(
    `UPDATE user_sessions SET last_seen_at=CURRENT_TIMESTAMP(3)
     WHERE token_hash=? AND last_seen_at<CURRENT_TIMESTAMP(3)-INTERVAL 5 MINUTE`,
    [tokenHash(token)],
  );
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isPlatformAdmin: Boolean(row.is_platform_admin),
  };
}

export async function revokeSession(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (token)
    await database().execute(
      "UPDATE user_sessions SET revoked_at=CURRENT_TIMESTAMP(3) WHERE token_hash=?",
      [tokenHash(token)],
    );
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    domain: env.SESSION_COOKIE_DOMAIN || undefined,
  });
}
