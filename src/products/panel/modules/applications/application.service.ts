import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { createApplicationSchema } from './application.schema.js'

type CreateApplication = z.infer<typeof createApplicationSchema>

export const sampleApplications = [
  { id: '9e01ddbc-fc72-46d5-bced-e0b3f54ccaa1', name: 'portal-api', domain: 'api.legacyhosting.dev', node: 'fra-01', status: 'Running', cpu: '8.4%', mem: '214 MB', deploy: '2 min ago', color: 'violet' },
  { id: '9e01ddbc-fc72-46d5-bced-e0b3f54ccaa2', name: 'customer-dashboard', domain: 'app.legacyhosting.dev', node: 'fra-01', status: 'Running', cpu: '3.1%', mem: '386 MB', deploy: 'Yesterday', color: 'blue' },
  { id: '9e01ddbc-fc72-46d5-bced-e0b3f54ccaa3', name: 'billing-worker', domain: 'worker.legacyhosting.dev', node: 'ams-02', status: 'Stopped', cpu: '—', mem: '—', deploy: '3 days ago', color: 'orange' },
]

export function createApplication(input: CreateApplication) {
  if (input.domain !== input.rootDomain && !input.domain.endsWith(`.${input.rootDomain}`)) {
    throw new Error('Domain must belong to the selected root domain')
  }

  return {
    id: randomUUID(),
    ...input,
    storagePath: `/home/${input.rootDomain}/${input.domain}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
}
