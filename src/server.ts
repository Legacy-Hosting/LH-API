import { buildApp } from './app.js'
import { env } from './core/config/env.js'
import { closeDatabase } from './core/database/mysql.js'

const app = await buildApp()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    await closeDatabase()
    process.exit(0)
  })
}

await app.listen({ host: env.HOST, port: env.PORT })
