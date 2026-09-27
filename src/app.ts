import Fastify, { LogController } from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import rateLimit from "@fastify/rate-limit";
import { env } from "./core/config/env.js";
import { databaseStatus } from "./core/database/mysql.js";
import { billingProduct } from "./products/billing/index.js";
import { panelProduct } from "./products/panel/index.js";
import { agentRoutes } from "./products/panel/modules/agent/agent.routes.js";
import { authRoutes, type AuthRouteOptions } from "./shared/modules/auth/auth.routes.js";
import { teamRoutes } from "./shared/modules/teams/team.routes.js";
import { integrationRoutes } from "./shared/modules/integrations/integration.routes.js";
import { githubWebhookRoutes } from "./shared/modules/integrations/github-webhook.routes.js";
import { enforceBrowserRequestSecurity } from "./shared/security/csrf.js";
import {
  auditRoutes,
  type AuditEventReader,
  type HubAuditTokenVerifier,
} from "./shared/modules/audit/audit.routes.js";
import {
  operationsRoutes,
  type OperationsReader,
} from "./shared/modules/operations/operations.routes.js";
import { API_VERSION } from "./version.js";
import { publicAssets } from "./public-assets.js";
import { renderServicePage, servicePageCss } from "./service-page.js";

type BuildAppOptions = {
  health?: {
    databaseStatus?: typeof databaseStatus;
  };
  auth?: AuthRouteOptions;
  audit?: {
    tokenVerifier?: HubAuditTokenVerifier;
    reader?: AuditEventReader;
  };
  operations?: {
    tokenVerifier?: HubAuditTokenVerifier;
    reader?: OperationsReader;
  };
};

export async function buildApp(options: BuildAppOptions = {}) {
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
  await app.register(formbody);
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

  app.get("/", async (_request, reply) => reply
    .header("Cache-Control", "public, max-age=300")
    .type("text/html; charset=utf-8")
    .send(renderServicePage()));
  app.get("/assets/service.css", async (_request, reply) => reply
    .header("Cache-Control", "public, max-age=300")
    .type("text/css; charset=utf-8")
    .send(servicePageCss));
  for (const [path, contentType, body] of [
    ["/favicon.svg", "image/svg+xml", publicAssets.favicon],
    ["/favicon.ico", "image/x-icon", publicAssets.faviconIco],
    ["/apple-touch-icon.png", "image/png", publicAssets.appleTouchIcon],
    ["/favicon-192.png", "image/png", publicAssets.favicon192],
    ["/favicon-512.png", "image/png", publicAssets.favicon512],
    ["/fonts/fonts.css", "text/css; charset=utf-8", publicAssets.fontsCss],
    ["/fonts/dm-sans-latin.woff2", "font/woff2", publicAssets.dmSans],
    ["/fonts/space-grotesk-latin.woff2", "font/woff2", publicAssets.spaceGrotesk],
    ["/social-card.png", "image/png", publicAssets.socialCard],
    ["/social-card.svg", "image/svg+xml", publicAssets.socialCardSource],
    ["/site.webmanifest", "application/manifest+json", publicAssets.manifest],
    ["/robots.txt", "text/plain; charset=utf-8", publicAssets.robots],
  ] as const) {
    app.get(path, async (_request, reply) => reply
      .header("Cache-Control", "public, max-age=86400")
      .type(contentType)
      .send(body));
  }

  app.get("/health", async (_request, reply) => {
    const database = await (options.health?.databaseStatus ?? databaseStatus)();
    const healthy = database === "connected";
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      database,
      version: API_VERSION,
    });
  });
  app.get("/api/v1", async () => ({
    name: "Legacy Hosting API",
    version: "v1",
    products: ["panel", "billing"],
  }));

  await app.register(panelProduct, { prefix: "/api/v1/panel" });
  await app.register(agentRoutes, { prefix: "/api/v1/agent" });
  await app.register(authRoutes, { prefix: "/api/v1/auth", ...options.auth });
  await app.register(teamRoutes, { prefix: "/api/v1/teams" });
  await app.register(integrationRoutes, { prefix: "/api/v1/integrations" });
  await app.register(githubWebhookRoutes, { prefix: "/api/v1/integrations" });
  await app.register(auditRoutes, { prefix: "/api/v1/hub", ...options.audit });
  await app.register(operationsRoutes, { prefix: "/api/v1/hub", ...options.operations });
  await app.register(billingProduct, { prefix: "/api/v1/billing" });

  return app;
}
