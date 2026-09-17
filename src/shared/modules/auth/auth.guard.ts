import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveSession } from "./session.service.js";

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = await resolveSession(request);
  if (!user)
    return reply.status(401).send({ error: "authentication_required" });
  Object.assign(request, { sessionUser: user });
}

export async function requirePlatformAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = await resolveSession(request);
  if (!user)
    return reply.status(401).send({ error: "authentication_required" });
  if (!user.isPlatformAdmin)
    return reply.status(403).send({ error: "platform_admin_required" });
  Object.assign(request, { sessionUser: user });
}
