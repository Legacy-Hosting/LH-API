import { z } from 'zod'

const hostname = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)

export const createApplicationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  domain: hostname,
  rootDomain: hostname,
  nodeId: z.string().uuid(),
  repository: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).default('main'),
  autoDeploy: z.boolean().default(true),
  environment: z.record(z.string(), z.string()).default({}),
})
