import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import type { RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { database } from '../../../../core/database/mysql.js'

const processSchema = z.object({
  pm2Id: z.number().int().nullable(),
  name: z.string().min(1).max(120),
  pid: z.number().int().nullable(),
  status: z.string().max(30),
  cpuPercent: z.number().min(0),
  memoryBytes: z.number().int().min(0),
  restartCount: z.number().int().min(0),
  startedAt: z.string().datetime().nullable(),
  revision: z.string().max(64).nullable(),
})

const heartbeatSchema = z.object({
  agentVersion: z.string().min(1).max(30),
  sentAt: z.string().datetime(),
  system: z.object({
    hostname: z.string().min(1).max(253),
    uptimeSeconds: z.number().int().min(0),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
    memoryTotalBytes: z.number().int().min(0),
    memoryUsedBytes: z.number().int().min(0),
    memoryUsedPercent: z.number().min(0).max(100),
    diskUsedPercent: z.number().min(0).max(100).nullable(),
  }),
  processes: z.array(processSchema).max(500),
})

type CredentialRow = RowDataPacket & { authentication_key: Buffer }

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/heartbeat', async (request, reply) => {
    const nodeId = request.headers['x-lh-node-id']
    const timestamp = request.headers['x-lh-timestamp']
    const signature = request.headers['x-lh-signature']

    if (typeof nodeId !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
      return reply.status(401).send({ error: 'agent_authentication_required' })
    }

    if (!z.string().uuid().safeParse(nodeId).success || !/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
      return reply.status(401).send({ error: 'invalid_agent_credentials' })
    }

    const age = Math.abs(Date.now() - Number(timestamp))
    if (age > 5 * 60 * 1000) return reply.status(401).send({ error: 'expired_agent_request' })

    const payload = heartbeatSchema.safeParse(request.body)
    if (!payload.success) return reply.status(400).send({ error: 'validation_error', details: payload.error.flatten() })

    const pool = database()
    const [credentialRows] = await pool.query<CredentialRow[]>(
      'SELECT authentication_key FROM node_agent_credentials WHERE node_id = UUID_TO_BIN(?) AND revoked_at IS NULL LIMIT 1',
      [nodeId],
    )
    const credential = credentialRows[0]
    if (!credential) return reply.status(401).send({ error: 'invalid_agent_credentials' })

    const expected = createHmac('sha256', credential.authentication_key)
      .update(`${timestamp}.${JSON.stringify(request.body)}`)
      .digest()
    const received = Buffer.from(signature, 'hex')
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return reply.status(401).send({ error: 'invalid_agent_signature' })
    }

    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(
        `UPDATE nodes SET status='online', agent_version=?, last_heartbeat_at=CURRENT_TIMESTAMP(3)
         WHERE id=UUID_TO_BIN(?)`,
        [payload.data.agentVersion, nodeId],
      )
      await connection.execute(
        `UPDATE node_agent_credentials SET last_used_at=CURRENT_TIMESTAMP(3)
         WHERE node_id=UUID_TO_BIN(?)`,
        [nodeId],
      )
      await connection.execute(
        `INSERT INTO node_metrics
         (node_id, load_1, load_5, load_15, memory_total_bytes, memory_used_bytes, memory_used_percent, disk_used_percent, uptime_seconds)
         VALUES (UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nodeId,
          ...payload.data.system.loadAverage,
          payload.data.system.memoryTotalBytes,
          payload.data.system.memoryUsedBytes,
          payload.data.system.memoryUsedPercent,
          payload.data.system.diskUsedPercent,
          payload.data.system.uptimeSeconds,
        ],
      )

      for (const process of payload.data.processes) {
        await connection.execute(
          `INSERT INTO pm2_process_snapshots
           (node_id, pm2_id, process_name, process_status, pid, cpu_percent, memory_bytes, restart_count, started_at, revision)
           VALUES (UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [nodeId, process.pm2Id, process.name, process.status, process.pid, process.cpuPercent, process.memoryBytes, process.restartCount, process.startedAt, process.revision],
        )
      }

      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }

    return reply.send({ accepted: true, serverTime: new Date().toISOString() })
  })
}
