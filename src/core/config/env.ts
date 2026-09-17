import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z
  .object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  PANEL_ORIGIN: z.string().default("http://localhost:5173"),
  TRUST_PROXY: booleanFromString,
  BODY_LIMIT_BYTES: z.coerce.number().int().min(65536).max(10485760).default(1048576),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(10000).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  ALLOW_LEGACY_AGENT_SIGNATURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL_CA: z.string().min(1).optional(),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  WEBAUTHN_RP_NAME: z.string().default("Legacy Hosting"),
  WEBAUTHN_RP_ID: z.string().default("localhost"),
  WEBAUTHN_ORIGIN: z.string().url().default("http://localhost:5173"),
  INITIAL_ADMIN_TOKEN: z.string().min(32).optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1).optional(),
  CSRF_SECRET: z.string().min(32).optional(),
  CLOUDFLARE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  CLOUDFLARE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  CLOUDFLARE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  CLOUDFLARE_OAUTH_API_ORIGIN: z
    .string()
    .url()
    .default("https://api.cloudflare.com"),
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD: z
    .enum(["client_secret_basic", "client_secret_post"])
    .default("client_secret_basic"),
  CLOUDFLARE_OAUTH_SCOPES: z
    .string()
    .default("dns.read dns.write zone.read user-details.read offline_access"),
  ACME_EMAIL: z.string().email().optional(),
  CERTIFICATE_RENEWAL_DAYS: z.coerce.number().int().min(7).max(60).default(30),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(32).optional(),
  GITHUB_API_VERSION: z.string().default("2026-03-10"),
  MONITORING_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(300_000)
    .default(30_000),
  RESEND_API_KEY: z.string().min(1).optional(),
  ALERT_EMAIL_FROM: z.string().email().optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.CSRF_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["CSRF_SECRET"],
        message: "CSRF_SECRET is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.CREDENTIAL_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        path: ["CREDENTIAL_ENCRYPTION_KEY"],
        message: "CREDENTIAL_ENCRYPTION_KEY is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.DATABASE_SSL_CA) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_SSL_CA"],
        message: "DATABASE_SSL_CA is required in production",
      });
    }
  });

export const env = schema.parse(process.env);
