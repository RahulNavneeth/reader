import type { FastifyInstance } from 'fastify'
import { listAllDocuments } from '../stores/documents.js'

/**
 * Photo timeline endpoint — chronological feed of the caller's
 * geotag-or-image media for the new /timeline UI. Returns items
 * already grouped by day, newest first, so the client doesn't have
 * to bucket on the fly.
 *
 *   GET /api/account/timeline?cursor=<base64>&limit=200
 *
 * Cursor pagination so a multi-year vault can load incrementally
 * instead of dumping every image into a single response.
 */
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif',
  '.bmp', '.ico', '.heic', '.heif', '.tiff', '.tif', '.jxl',
])
const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi',
  '.3gp', '.3gpp', '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
])

function ext(name: string): string {
  const m = name.toLowerCase().match(/\.[^./\\]+$/)
  return m ? m[0] : ''
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function timelineRoutes(app: FastifyInstance) {
  app.get('/api/account/timeline', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const me = req.currentUser.username
    const q = req.query as { cursor?: string; limit?: string }
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 200))

    let skip = 0
    if (q.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(q.cursor, 'base64').toString('utf8'))
        if (typeof parsed?.skip === 'number' && parsed.skip >= 0) skip = parsed.skip
      } catch {
        return reply.code(400).send({ error: 'invalid cursor' })
      }
    }

    // Filter to image/video files the caller owns, sorted newest
    // first. We dedupe by storageKey because the doc index can hold
    // multiple records for the same path during re-ingest churn.
    const all = (await listAllDocuments()).filter((d) => d.owner === me)
    const seen = new Set<string>()
    const media = all
      .filter((d) => {
        if (seen.has(d.storageKey)) return false
        const e = ext(d.originalFilename)
        if (!IMAGE_EXTS.has(e) && !VIDEO_EXTS.has(e)) return false
        seen.add(d.storageKey)
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)

    const page = media.slice(skip, skip + limit)

    // Bucket by day so the client renders date headers without
    // having to walk a flat list.
    const groups = new Map<
      string,
      Array<{
        docId: string
        path: string
        name: string
        mime: string
        kind: 'image' | 'video'
        createdAt: number
        bytes: number
        gps?: { lat: number; lng: number } | null
      }>
    >()
    for (const d of page) {
      const key = dayKey(d.createdAt)
      const e = ext(d.originalFilename)
      const entry = {
        docId: d.id,
        path: d.storageKey,
        name: d.originalFilename,
        mime: d.mime,
        kind: VIDEO_EXTS.has(e) ? ('video' as const) : ('image' as const),
        createdAt: d.createdAt,
        bytes: d.bytes,
        gps: d.gps ?? null,
        livePhotoPair: d.livePhotoPair ?? null,
      }
      const arr = groups.get(key) ?? []
      arr.push(entry)
      groups.set(key, arr)
    }

    const days = Array.from(groups.entries()).map(([day, items]) => ({
      day,
      items,
    }))
    const nextSkip = skip + page.length
    const nextCursor =
      nextSkip < media.length
        ? Buffer.from(JSON.stringify({ skip: nextSkip }), 'utf8').toString('base64')
        : null

    return { days, nextCursor, total: media.length }
  })
}
