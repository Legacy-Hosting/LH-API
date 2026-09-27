import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../../../core/config/env.js";
import {
  createHubAuditTokenVerifier,
  type HubAuditTokenVerifier,
} from "../audit/audit.routes.js";
import {
  readOperationsSummary,
  type OperationsSummary,
} from "./operations.service.js";

const allowedRoles = new Set([
  "founder",
  "management",
  "platform_admin",
  "developer",
  "infrastructure",
]);
const claimsSchema = z.object({
  sub: z.string().min(1),
  roles: z.array(z.string()).default([]),
});

export type OperationsReader = () => Promise<OperationsSummary>;

function configuredVerifier() {
  if (!env.SSO_ISSUER || !env.SSO_JWKS_URL) return undefined;
  return createHubAuditTokenVerifier({
    issuer: env.SSO_ISSUER,
    audience: env.HUB_SSO_AUDIENCE,
    jwksUrl: env.SSO_JWKS_URL,
  });
}

export const operationsRoutes: FastifyPluginAsync<{
  tokenVerifier?: HubAuditTokenVerifier;
  reader?: OperationsReader;
}> = async (app, options) => {
  const verifyToken = options.tokenVerifier ?? configuredVerifier();
  const reader = options.reader ?? readOperationsSummary;

  app.get("/operations", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "authentication_required" });
    }
    if (!verifyToken) {
      return reply.status(503).send({ error: "sso_not_configured" });
    }
    let claims: z.infer<typeof claimsSchema>;
    try {
      claims = claimsSchema.parse(
        await verifyToken(authorization.slice("Bearer ".length).trim()),
      );
    } catch {
      return reply.status(401).send({ error: "invalid_access_token" });
    }
    if (!claims.roles.some((role) => allowedRoles.has(role))) {
      return reply.status(403).send({ error: "operations_access_required" });
    }
    return { data: await reader() };
  });
};
