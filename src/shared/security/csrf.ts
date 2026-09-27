import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../core/config/env.js";
import { SESSION_COOKIE_NAME } from "../modules/auth/session.service.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const unauthenticatedAuthRoutes = new Set([
  "/api/v1/auth/register/options",
  "/api/v1/auth/register/verify",
  "/api/v1/auth/login/options",
  "/api/v1/auth/login/verify",
]);

function secret() {
  return (
    env.CSRF_SECRET ??
    env.CREDENTIAL_ENCRYPTION_KEY ??
    "legacy-hosting-development-csrf-secret"
  );
}

export function createCsrfToken(sessionToken: string, key = secret()) {
  return createHmac("sha256", key)
    .update(`lh-csrf-v1.${sessionToken}`)
    .digest("hex");
}

export function verifyCsrfToken(
  sessionToken: string,
  received: string | undefined,
  key = secret(),
) {
  if (!received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = Buffer.from(createCsrfToken(sessionToken, key), "hex");
  const actual = Buffer.from(received, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function enforceBrowserRequestSecurity(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (safeMethods.has(request.method)) return;
  if (
    request.url.startsWith("/api/v1/agent/") ||
    request.url === "/api/v1/auth/oidc/backchannel-logout" ||
    request.url === "/api/v1/integrations/github/webhook"
  )
    return;

  const origin = request.headers.origin;
  const allowedOrigins = new Set([env.PANEL_ORIGIN, env.WEBAUTHN_ORIGIN]);
  if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
    return reply.status(403).send({ error: "invalid_request_origin" });
  }

  if (unauthenticatedAuthRoutes.has(request.url.split("?")[0]!)) return;
  const sessionToken = request.cookies[SESSION_COOKIE_NAME];
  if (!sessionToken) return;
  const csrfToken = request.headers["x-csrf-token"];
  if (
    typeof csrfToken !== "string" ||
    !verifyCsrfToken(sessionToken, csrfToken)
  ) {
    return reply.status(403).send({ error: "invalid_csrf_token" });
  }
}
