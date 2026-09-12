import type { FastifyPluginAsync } from 'fastify'

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.get('/domains', async () => ({ data: [], meta: { cnameTargetManagedByNode: true } }))
}
