import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";
import {
  listGlobalFirewallBans,
  normalizePublicIpAddress,
  removeGlobalFirewallBan,
} from "./firewall.service.js";

const unbanBody = z.object({
  ipAddress: z
    .string()
    .max(45)
    .refine((value) => normalizePublicIpAddress(value) !== null),
  reason: z.string().trim().min(3).max(255).default("Removed by administrator"),
});

function userFrom(request: FastifyRequest) {
  return (request as FastifyRequest & { sessionUser: SessionUser }).sessionUser;
}

export const firewallRoutes: FastifyPluginAsync = async (app) => {
  app.get("/firewall/bans", async (request, reply) => {
    if (!userFrom(request).isPlatformAdmin)
      return reply.status(403).send({ error: "platform_admin_required" });
    reply.header("Cache-Control", "no-store");
    return { data: await listGlobalFirewallBans() };
  });

  app.post("/firewall/bans/unban", async (request, reply) => {
    const user = userFrom(request);
    if (!user.isPlatformAdmin)
      return reply.status(403).send({ error: "platform_admin_required" });
    const body = unbanBody.safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });
    const removed = await removeGlobalFirewallBan({
      ...body.data,
      userId: user.id,
      teamId: teamFrom(request).id,
    });
    if (!removed)
      return reply.status(404).send({ error: "active_firewall_ban_not_found" });
    return {
      data: {
        ipAddress: normalizePublicIpAddress(body.data.ipAddress),
        active: false,
      },
    };
  });
};
