import type { FastifyInstance } from 'fastify'
import { listAllDocuments } from '../stores/documents.js'
import { listFolderMetas } from '../stores/folderMetas.js'

function kindOf(filename: string): 'image' | 'video' | 'file' {
  const ext = filename.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ''
  if (/\.(png|jpe?g|webp|gif|avif|bmp|ico|heic|heif|tiff?|jxl)$/.test(ext)) return 'image'
  if (/\.(mp4|mov|m4v|mkv|webm|avi|3gp|3gpp|mts|m2ts|mpg|mpeg|wmv|flv|ogv)$/.test(ext)) return 'video'
  return 'file'
}

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
    const q = req.query as { cursor?: string; limit?: string; archived?: string }
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 200))
    // Archived tristate: default hides archived (matches the rest of
    // the app's "out of daily flow" semantics); `archived=true`
    // includes both; `archived=only` filters to just archived docs
    // — used by the dedicated /archive view in the web UI.
    const archMode: 'hide' | 'show' | 'only' =
      q.archived === 'only' ? 'only' : q.archived === 'true' ? 'show' : 'hide'

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
      .filter((d) => {
        const isArch = !!d.archived
        if (archMode === 'only') return isArch
        if (archMode === 'show') return true
        return !isArch
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

  /**
   * "On this day" — returns docs whose created OR updated MM-DD
   * matches today's MM-DD, from any prior year. Powers the
   * sidebar card on the home view. Excludes archived docs (same
   * "out of daily flow" semantics the rest of the app uses) and
   * caps at 50 results so a power user with 20 years of journals
   * doesn't dump an unbounded list onto the home screen.
   *
   *   GET /api/account/on-this-day
   *   → { today: 'MM-DD', items: [{id, storageKey, title, createdAt,
   *                                updatedAt, year, yearsAgo,
   *                                mimeKind: 'image'|'video'|'file'}] }
   */
  app.get('/api/account/on-this-day', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const me = req.currentUser.username
    const now = new Date()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const today = `${mm}-${dd}`
    const thisYear = now.getFullYear()
    const docs = await listAllDocuments()
    const matches: Array<{
      id: string
      storageKey: string
      title: string
      createdAt: number
      updatedAt: number
      year: number
      yearsAgo: number
      mimeKind: 'image' | 'video' | 'file'
    }> = []
    for (const d of docs) {
      if (d.owner !== me) continue
      if (d.archived) continue
      // Use the earliest of createdAt vs updatedAt that hits today's
      // MM-DD. createdAt wins ties — that's what "I made this on
      // <date> N years ago" usually means.
      const ca = new Date(d.createdAt)
      const ua = new Date(d.updatedAt)
      const caKey = `${String(ca.getMonth() + 1).padStart(2, '0')}-${String(ca.getDate()).padStart(2, '0')}`
      const uaKey = `${String(ua.getMonth() + 1).padStart(2, '0')}-${String(ua.getDate()).padStart(2, '0')}`
      let year: number | null = null
      if (caKey === today && ca.getFullYear() < thisYear) year = ca.getFullYear()
      else if (uaKey === today && ua.getFullYear() < thisYear) year = ua.getFullYear()
      if (year == null) continue
      matches.push({
        id: d.id,
        storageKey: d.storageKey,
        title: d.title,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        year,
        yearsAgo: thisYear - year,
        mimeKind: kindOf(d.originalFilename ?? d.storageKey),
      })
    }
    // Most recent year first, then most recently created within
    // each year so the card surfaces the freshest memory at top.
    matches.sort((a, b) => (b.year - a.year) || (b.createdAt - a.createdAt))
    return { today, items: matches.slice(0, 50) }
  })

  /**
   * Dedicated Archive listing — returns archived folders + the
   * archived files that are NOT already inside an archived folder
   * (those are represented by the folder itself, no point listing
   * twice). Both groups are sorted newest-archived first; the web UI
   * renders them as a single grid.
   */
  app.get('/api/account/archive', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const me = req.currentUser.username

    const folderMetas = await listFolderMetas(me)
    const archivedFolders = folderMetas.filter((m) => m.archived)
    // Pre-compute prefix predicates once so the file filter below
    // doesn't pay O(N×F) on every doc check.
    const archivedFolderPrefixes = archivedFolders.map(
      (f) => f.storageKey.replace(/\/+$/, '') + '/',
    )
    const isUnderArchivedFolder = (storageKey: string): boolean => {
      for (const p of archivedFolderPrefixes) {
        if (storageKey.startsWith(p)) return true
      }
      return false
    }

    const docs = await listAllDocuments()
    const archivedFiles = docs
      .filter((d) => d.owner === me)
      .filter((d) => d.archived)
      // De-dup against folder-level archive — if the file's parent
      // folder is already archived, the folder tile represents it.
      .filter((d) => !isUnderArchivedFolder(d.storageKey))

    return {
      folders: archivedFolders
        .map((f) => ({
          path: f.storageKey,
          name: f.storageKey.split('/').filter(Boolean).pop() || f.storageKey,
          tags: f.tags,
          archivedAt: f.archivedAt ?? f.updatedAt,
        }))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
      files: archivedFiles
        .map((d) => ({
          docId: d.id,
          path: d.storageKey,
          name: d.originalFilename,
          mime: d.mime,
          kind: kindOf(d.originalFilename),
          bytes: d.bytes,
          archivedAt: d.archivedAt ?? d.updatedAt,
        }))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    }
  })
}
