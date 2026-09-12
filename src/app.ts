import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import { env } from './core/config/env.js'
import { databaseStatus } from './core/database/mysql.js'
import { billingProduct } from './products/billing/index.js'
import { panelProduct } from './products/panel/index.js'
import { agentRoutes } from './products/panel/modules/agent/agent.routes.js'

export async function buildApp() {
  const app = Fastify({ logger: true })

  await app.register(helmet)
  await app.register(cors, { origin: env.PANEL_ORIGIN, credentials: true })

  app.get('/health', async () => ({ status: 'ok', database: await databaseStatus(), version: '0.1.0' }))
  app.get('/api/v1', async () => ({ name: 'Legacy Hosting API', version: 'v1', products: ['panel', 'billing'] }))

  await app.register(panelProduct, { prefix: '/api/v1/panel' })
  await app.register(agentRoutes, { prefix: '/api/v1/agent' })
  await app.register(billingProduct, { prefix: '/api/v1/billing' })

  return app
}
