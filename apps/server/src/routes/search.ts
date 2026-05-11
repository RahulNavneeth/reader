import type { FastifyInstance } from 'fastify'
import { searchKnowledge } from '../services/search.js'

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)

  app.get('/api/search/knowledge', async (req) => {
    const q = (req.query as { q?: string }).q ?? ''
    const limit = Math.min(50, Number((req.query as { limit?: string }).limit ?? 20))
    const user = req.currentUser!
    const hits = await searchKnowledge({ q, user: { username: user.username, role: user.role }, limit })
    return { query: q, hits }
  })
}
