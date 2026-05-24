import type { FastifyInstance } from 'fastify'
import { findSimilarDocs, searchKnowledge, type SearchFilters } from '../services/search.js'

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)

  app.get('/api/search/knowledge', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const q = query.q ?? ''
    const limit = Math.min(50, Number(query.limit ?? 20))
    const user = req.currentUser!

    // Parse optional faceted filters from query string. Repeating
    // params (?mime=image/&mime=application/pdf) is supported by
    // fastify's querystring parser; a single string also works
    // (?tags=urgent). after/before are epoch-ms ints.
    const asArray = (v: string | string[] | undefined): string[] | undefined => {
      if (v == null) return undefined
      const arr = (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter(Boolean)
      return arr.length > 0 ? arr : undefined
    }
    const asInt = (v: string | undefined): number | undefined => {
      if (v == null) return undefined
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    const filters: SearchFilters = {
      mime: asArray((req.query as Record<string, unknown>).mime as string | string[] | undefined),
      tags: asArray((req.query as Record<string, unknown>).tags as string | string[] | undefined),
      after: asInt(query.after),
      before: asInt(query.before),
      folder: query.folder?.trim() || undefined,
    }
    void reply

    const hits = await searchKnowledge({
      q,
      user: { username: user.username, role: user.role },
      limit,
      filters,
    })
    return { query: q, hits, filters }
  })

  // Find documents similar to a given doc, scored by averaged
  // chunk-embedding cosine. Returns up to `limit` other docs the
  // user can read; the source doc itself is always excluded.
  app.get<{ Params: { docId: string } }>('/api/search/similar/:docId', async (req, reply) => {
    const user = req.currentUser!
    const q = req.query as { limit?: string; path?: string }
    const limit = Math.min(50, Number(q.limit ?? 10))
    try {
      const hits = await findSimilarDocs({
        docId: req.params.docId,
        // `path` is a fallback hint sent by the viewer so a stale
        // docId (e.g. after the file was re-ingested under a new id)
        // can be resolved by storageKey instead of failing.
        pathHint: q.path?.trim() || undefined,
        user: { username: user.username, role: user.role },
        limit,
      })
      return { hits }
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500
      return reply.code(status).send({ error: (e as Error).message })
    }
  })
}
