import type { FastifyInstance } from 'fastify'
import { listAllDocuments } from '../stores/documents.js'

/**
 * Document timeline endpoint — chronological feed of every document
 * the caller owns, grouped by day, newest first. Originally photo-
 * only; widened to include all files so the user has a single "what
 * landed in my vault when" view.
 *
 *   GET /api/account/timeline?cursor=<base64>&limit=200
 *
 * Cursor pagination so a multi-year vault can load incrementally
 * instead of dumping every doc into a single response.
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

    // Every doc the caller owns, newest first. Dedupe by storageKey
    // because the doc index can briefly hold multiple records for
    // the same path during re-ingest churn.
    const all = (await listAllDocuments()).filter((d) => d.owner === me)
    const seen = new Set<string>()
    const docs = all
      .filter((d) => {
        if (seen.has(d.storageKey)) return false
        seen.add(d.storageKey)
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt)

    const page = docs.slice(skip, skip + limit)

    // Bucket by day so the client renders date headers without
    // having to walk a flat list. `kind` is the broad category the
    // client uses to choose between thumbnail + file-icon rendering.
    const groups = new Map<
      string,
      Array<{
        docId: string
        path: string
        name: string
        mime: string
        kind: 'image' | 'video' | 'file'
        createdAt: number
        bytes: number
        gps?: { lat: number; lng: number } | null
        livePhotoPair?: string | null
      }>
    >()
    for (const d of page) {
      const key = dayKey(d.createdAt)
      const e = ext(d.originalFilename)
      const kind: 'image' | 'video' | 'file' = VIDEO_EXTS.has(e)
        ? 'video'
        : IMAGE_EXTS.has(e)
          ? 'image'
          : 'file'
      const entry = {
        docId: d.id,
        path: d.storageKey,
        name: d.originalFilename,
        mime: d.mime,
        kind,
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
      nextSkip < docs.length
        ? Buffer.from(JSON.stringify({ skip: nextSkip }), 'utf8').toString('base64')
        : null

    return { days, nextCursor, total: docs.length }
  })

  /**
   * Calendar heatmap aggregation. Returns one row per day in the
   * requested window with a count of docs the user created that
   * day. Suitable for a GitHub-style contribution grid: each cell
   * gets its color from `count`, click navigates to the timeline
   * pinned at that day.
   *
   *   GET /api/account/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Both bounds inclusive. Missing `to` defaults to today; missing
   * `from` defaults to one year ago. Days with zero docs are
   * omitted from the response — let the client fill those in as
   * blanks; cuts the payload from 365 rows to ~N (where N = days
   * with activity).
   */
  app.get('/api/account/calendar', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const me = req.currentUser.username
    const q = req.query as { from?: string; to?: string }

    const parseDate = (s?: string): number | null => {
      if (!s) return null
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
      if (!m) return null
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      return Number.isNaN(d.getTime()) ? null : d.getTime()
    }

    const now = new Date()
    const toMs = parseDate(q.to) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const fromMs =
      parseDate(q.from) ??
      new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).getTime()
    if (fromMs > toMs) {
      return reply.code(400).send({ error: 'from must be ≤ to' })
    }
    // Upper-bound the window so "from=1970, to=now" can't scan
    // forever. 5 years is generous for an MVP heatmap.
    const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000
    if (toMs - fromMs > FIVE_YEARS_MS) {
      return reply.code(400).send({ error: 'window exceeds 5 years' })
    }
    // Inclusive bound on the END day: bump to end-of-day so a doc
    // created at 23:59 of `to` still lands inside.
    const toEnd = toMs + 24 * 60 * 60 * 1000 - 1

    const docs = await listAllDocuments()
    const counts = new Map<string, { count: number; lastTs: number }>()
    for (const d of docs) {
      if (d.owner !== me) continue
      if (d.createdAt < fromMs || d.createdAt > toEnd) continue
      const key = dayKey(d.createdAt)
      const cur = counts.get(key)
      if (cur) {
        cur.count++
        if (d.createdAt > cur.lastTs) cur.lastTs = d.createdAt
      } else {
        counts.set(key, { count: 1, lastTs: d.createdAt })
      }
    }
    const days = Array.from(counts.entries())
      .map(([day, v]) => ({ day, count: v.count, lastTs: v.lastTs }))
      .sort((a, b) => (a.day < b.day ? -1 : 1))
    const total = days.reduce((s, d) => s + d.count, 0)
    return {
      from: dayKey(fromMs),
      to: dayKey(toEnd),
      total,
      days,
    }
  })
}
