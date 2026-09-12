import type { FastifyPluginAsync } from 'fastify'
import { createApplicationSchema } from './application.schema.js'
import { createApplication, sampleApplications } from './application.service.js'

export const applicationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/applications', async () => ({ data: sampleApplications }))

  app.post('/applications', async (request, reply) => {
    const result = createApplicationSchema.safeParse(request.body)
    if (!result.success) return reply.status(400).send({ error: 'validation_error', details: result.error.flatten() })

    try {
      return reply.status(201).send({ data: createApplication(result.data) })
    } catch (error) {
      return reply.status(400).send({ error: 'invalid_domain', message: error instanceof Error ? error.message : 'Invalid domain' })
    }
  })
}
