import type { FastifyReply, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../core/database/mysql.js";
import type { SessionUser } from "../auth/auth.types.js";
import {
  applySupportContext,
  effectiveUserId,
} from "../auth/support-context.js";

export type TeamContext = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "administrator" | "developer" | "viewer";
};

type TeamRow = RowDataPacket & TeamContext;
type RequestContext = FastifyRequest & {
  sessionUser: SessionUser;
  teamContext: TeamContext;
};

export async function requireTeam(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = (request as FastifyRequest & { sessionUser?: SessionUser })
    .sessionUser;
  if (!user)
    return reply.status(401).send({ error: "authentication_required" });
  const supportResult = await applySupportContext(request, reply);
  if (supportResult) return supportResult;

  const requestedTeam = request.headers["x-team-id"];
  if (
    requestedTeam !== undefined &&
    (typeof requestedTeam !== "string" ||
      !z.string().uuid().safeParse(requestedTeam).success)
  ) {
    return reply.status(400).send({ error: "invalid_team_id" });
  }

  const [rows] = await database().query<TeamRow[]>(
    `SELECT BIN_TO_UUID(t.id) AS id,t.name,t.slug,tm.role
     FROM team_members tm JOIN teams t ON t.id=tm.team_id
     WHERE tm.user_id=UUID_TO_BIN(?) AND (? IS NULL OR t.id=UUID_TO_BIN(?))
     ORDER BY t.created_at LIMIT 1`,
    [effectiveUserId(user), requestedTeam ?? null, requestedTeam ?? null],
  );
  const team = rows[0];
  if (!team) return reply.status(403).send({ error: "team_access_required" });
  Object.assign(request, { teamContext: team });
}

export function teamFrom(request: FastifyRequest): TeamContext {
  return (request as RequestContext).teamContext;
}
