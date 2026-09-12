import type { FastifyPluginAsync } from 'fastify'

export const nodeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/nodes', async () => ({ data: [
    { id: 'fra-01', name: 'fra-01', region: 'Frankfurt, DE', status: 'online', cpu: 42, memory: 61 },
    { id: 'ams-02', name: 'ams-02', region: 'Amsterdam, NL', status: 'online', cpu: 28, memory: 38 },
  ] }))
}
