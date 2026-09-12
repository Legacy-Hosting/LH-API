import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  PANEL_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1).optional(),
  CLOUDFLARE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  CLOUDFLARE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  CLOUDFLARE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  CLOUDFLARE_OAUTH_SCOPES: z.string().default('dns.read dns.write zone.read user-details.read offline_access'),
})

export const env = schema.parse(process.env)
