import type { FastifyInstance } from 'fastify'
import { listViews, addView, deleteView } from '../stores/views.js'

export async function viewsRoutes(app: FastifyInstance) {
  app.get('/api/views', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const views = await listViews(req.currentUser.username)
    return { views }
  })

  app.post('/api/views', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const body = req.body as { name?: string; query?: string; tag?: string }
    const name = (body?.name || '').trim()
    if (!name) return reply.code(400).send({ error: 'name required' })
    if (!body.query && !body.tag) {
      return reply.code(400).send({ error: 'view needs a query or tag' })
    }
    const v = await addView(req.currentUser.username, {
      name,
      query: body.query?.trim() || undefined,
      tag: body.tag?.trim() || undefined,
    })
    return reply.code(201).send({ view: v })
  })

  app.delete('/api/views/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id } = req.params as { id: string }
    const ok = await deleteView(req.currentUser.username, id)
    if (!ok) return reply.code(404).send({ error: 'not found' })
    return { ok: true }
  })
}
