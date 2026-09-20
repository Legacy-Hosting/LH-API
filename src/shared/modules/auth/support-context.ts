import type { FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../core/database/mysql.js";
import type { SessionUser } from "./auth.types.js";

export const SUPPORT_USER_HEADER = "x-support-user-id";

export async function applySupportContext(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = (request as FastifyRequest & { sessionUser?: SessionUser })
    .sessionUser;
  if (!user) return reply.status(401).send({ error: "authentication_required" });

  const requestedUser = request.headers[SUPPORT_USER_HEADER];
  if (requestedUser === undefined) return;
  if (
    typeof requestedUser !== "string" ||
    !z.string().uuid().safeParse(requestedUser).success
  ) {
    return reply.status(400).send({ error: "invalid_support_user_id" });
  }

  const actorIsPlatformAdmin =
    user.actorIsPlatformAdmin ?? user.isPlatformAdmin;
  if (!actorIsPlatformAdmin)
    return reply.status(403).send({ error: "platform_admin_required" });

  const [rows] = await database().query<
    (RowDataPacket & { id: string; email: string; displayName: string })[]
  >(
    `SELECT BIN_TO_UUID(id) AS id,email,display_name AS displayName
     FROM users WHERE id=UUID_TO_BIN(?) AND status='active' LIMIT 1`,
    [requestedUser],
  );
  const supportUser = rows[0];
  if (!supportUser)
    return reply.status(404).send({ error: "support_user_not_found" });

  Object.assign(user, {
    actorIsPlatformAdmin: true,
    isPlatformAdmin: false,
    supportUserId: supportUser.id,
    supportUserEmail: supportUser.email,
    supportUserDisplayName: supportUser.displayName,
  });
}

export function effectiveUserId(user: SessionUser) {
  return user.supportUserId ?? user.id;
}
