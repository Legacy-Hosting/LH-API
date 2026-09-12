import type { FastifyPluginAsync } from 'fastify'

export const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/subscriptions', async () => ({ data: [], meta: { module: 'billing/subscriptions' } }))
}
