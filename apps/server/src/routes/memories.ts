import type { FastifyInstance } from 'fastify'
import { listAllDocuments } from '../stores/documents.js'

/**
 * Memories — "On this day" surface for the Account dashboard. Returns
 * the user's files whose `createdAt` matches today's month + day in any
 * prior year, grouped by year. Cheap pass over the doc index; the
 * dataset per user is small.
 */
export async function memoriesRoutes(app: FastifyInstance) {
  app.get('/api/account/memories', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    const docs = await listAllDocuments()
    const now = new Date()
    const todayMonth = now.getMonth()
    const todayDay = now.getDate()
    const currentYear = now.getFullYear()

    const groups = new Map<number, Array<{
      path: string
      name: string
      bytes: number
      mime: string
      createdAt: number
      embedded: boolean
      public: boolean
    }>>()

    for (const d of docs) {
      if (d.owner !== user.username) continue
      const c = new Date(d.createdAt)
      if (c.getMonth() !== todayMonth) continue
      if (c.getDate() !== todayDay) continue
      if (c.getFullYear() >= currentYear) continue
      const yearsAgo = currentYear - c.getFullYear()
      if (!groups.has(yearsAgo)) groups.set(yearsAgo, [])
      groups.get(yearsAgo)!.push({
        path: d.storageKey,
        name: d.originalFilename,
        bytes: d.bytes,
        mime: d.mime,
        createdAt: d.createdAt,
        embedded: !!d.ingest?.embedded,
        public: !!d.public,
      })
    }

    const sorted = Array.from(groups.entries())
      .map(([yearsAgo, items]) => ({
        yearsAgo,
        label: yearsAgo === 1 ? 'a year ago' : `${yearsAgo} years ago`,
        items: items.sort((a, b) => b.createdAt - a.createdAt),
      }))
      .sort((a, b) => a.yearsAgo - b.yearsAgo)

    return { date: now.toISOString().slice(0, 10), groups: sorted }
  })
}
