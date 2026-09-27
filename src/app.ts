import Fastify, { LogController } from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import rateLimit from "@fastify/rate-limit";
import { env } from "./core/config/env.js";
import { databaseStatus } from "./core/database/mysql.js";
import { billingProduct } from "./products/billing/index.js";
import { panelProduct } from "./products/panel/index.js";
import { agentRoutes } from "./products/panel/modules/agent/agent.routes.js";
import { authRoutes } from "./shared/modules/auth/auth.routes.js";
import { teamRoutes } from "./shared/modules/teams/team.routes.js";
import { integrationRoutes } from "./shared/modules/integrations/integration.routes.js";
import { githubWebhookRoutes } from "./shared/modules/integrations/github-webhook.routes.js";
import { enforceBrowserRequestSecurity } from "./shared/security/csrf.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
    logController: new LogController({
      disableRequestLogging: env.NODE_ENV === "production",
    }),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    hook: "onRequest",
    errorResponseBuilder: (_request, context) => ({
      error: "rate_limit_exceeded",
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
    }),
  });
  await app.register(rawBody, {
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(cors, {
    origin: env.PANEL_ORIGIN,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.addHook("preHandler", enforceBrowserRequestSecurity);
  app.addHook("onResponse", async (request, reply) => {
    if (env.NODE_ENV === "production" && reply.elapsedTime >= 1_000) {
      request.log.warn(
        {
          method: request.method,
          route: request.routeOptions.url,
          statusCode: reply.statusCode,
          elapsedMs: Math.round(reply.elapsedTime),
        },
        "Slow request",
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const possibleRateLimitError = error as unknown;
    if (
      typeof possibleRateLimitError === "object" &&
      possibleRateLimitError !== null &&
      "error" in possibleRateLimitError &&
      possibleRateLimitError.error === "rate_limit_exceeded"
    ) {
      const retryAfterSeconds =
        "retryAfterSeconds" in possibleRateLimitError &&
        typeof possibleRateLimitError.retryAfterSeconds === "number"
          ? possibleRateLimitError.retryAfterSeconds
          : Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000);

      request.log.warn({ requestId: request.id }, "Request rate limited");
      return reply.status(429).send({
        error: "rate_limit_exceeded",
        retryAfterSeconds,
        requestId: request.id,
      });
    }

    request.log.error({ err: error, requestId: request.id }, "Request failed");
    const status =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const statusCode = status < 500 ? status : 500;
    return reply.status(statusCode).send({
      error:
        statusCode === 500
          ? "internal_server_error"
          : error instanceof Error
            ? error.name
            : "request_failed",
      requestId: request.id,
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    database: await databaseStatus(),
    version: "1.0.33",
  }));
  app.get("/api/v1", async () => ({
    name: "Legacy Hosting API",
    version: "v1",
    products: ["panel", "billing"],
  }));

  await app.register(panelProduct, { prefix: "/api/v1/panel" });
  await app.register(agentRoutes, { prefix: "/api/v1/agent" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(teamRoutes, { prefix: "/api/v1/teams" });
  await app.register(integrationRoutes, { prefix: "/api/v1/integrations" });
  await app.register(githubWebhookRoutes, { prefix: "/api/v1/integrations" });
  await app.register(billingProduct, { prefix: "/api/v1/billing" });

  return app;
}
