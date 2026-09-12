import type { FastifyPluginAsync } from 'fastify'

export const overviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/overview', async () => ({
    data: {
      stats: { applications: 3, runningApplications: 2, nodes: 2, onlineNodes: 2, domains: 4, proxiedDomains: 3, deploymentsThisMonth: 28 },
      systemStatus: 'operational',
    },
  }))
}
