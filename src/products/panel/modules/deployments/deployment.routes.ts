import type { FastifyPluginAsync } from 'fastify'

export const deploymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/deployments', async () => ({ data: [] }))
}
