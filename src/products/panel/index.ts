import type { FastifyPluginAsync } from 'fastify'
import { applicationRoutes } from './modules/applications/application.routes.js'
import { deploymentRoutes } from './modules/deployments/deployment.routes.js'
import { domainRoutes } from './modules/domains/domain.routes.js'
import { nodeRoutes } from './modules/nodes/node.routes.js'
import { overviewRoutes } from './modules/overview/overview.routes.js'

export const panelProduct: FastifyPluginAsync = async (app) => {
  await app.register(overviewRoutes)
  await app.register(applicationRoutes)
  await app.register(nodeRoutes)
  await app.register(domainRoutes)
  await app.register(deploymentRoutes)
}
