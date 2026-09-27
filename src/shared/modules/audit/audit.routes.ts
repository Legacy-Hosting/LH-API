import type { FastifyPluginAsync } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { env } from "../../../core/config/env.js";
import {
  decodeAuditCursor,
  readAuditEvents,
  type AuditQuery,
} from "./audit.service.js";

const allowedRoles = new Set(["founder", "management", "platform_admin", "support"]);
const claimsSchema = z.object({
  sub: z.string().min(1),
  roles: z.array(z.string()).default([]),
});
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1_024).optional(),
});

export type HubAuditTokenVerifier = (token: string) => Promise<unknown>;
export type AuditEventReader = (query: AuditQuery) => ReturnType<typeof readAuditEvents>;

export function createHubAuditTokenVerifier(options: {
  issuer: string;
  audience: string;
  jwksUrl: string;
}): HubAuditTokenVerifier {
  const keySet = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["ES256"],
      maxTokenAge: "6 minutes",
      clockTolerance: 5,
    });
    return payload;
  };
}

function configuredVerifier() {
  if (!env.SSO_ISSUER || !env.SSO_JWKS_URL) return undefined;
  return createHubAuditTokenVerifier({
    issuer: env.SSO_ISSUER,
    audience: env.HUB_SSO_AUDIENCE,
    jwksUrl: env.SSO_JWKS_URL,
  });
}

export const auditRoutes: FastifyPluginAsync<{
  tokenVerifier?: HubAuditTokenVerifier;
  reader?: AuditEventReader;
}> = async (app, options) => {
  const verifyToken = options.tokenVerifier ?? configuredVerifier();
  const reader = options.reader ?? readAuditEvents;

  app.get("/audit-events", async (request, reply) => {
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
      return reply.status(403).send({ error: "audit_access_required" });
    }
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "validation_error" });
    }
    const cursor = query.data.cursor
      ? decodeAuditCursor(query.data.cursor)
      : undefined;
    if (query.data.cursor && !cursor) {
      return reply.status(400).send({ error: "invalid_audit_cursor" });
    }
    return {
      data: await reader({
        limit: query.data.limit,
        ...(cursor ? { cursor } : {}),
      }),
    };
  });
};
