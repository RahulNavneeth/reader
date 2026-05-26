/**
 * Pull-side consumer for the change log. Catches up on mutations
 * other devices (or the user's own offline-then-replayed ops) made
 * while this tab was offline / closed / focused elsewhere.
 *
 * Strategy:
 *   - Persist a `lastSeenLsn` cursor in localStorage.
 *   - On every reconnect (and once on mount), GET
 *     `/api/sync/pull?since=<cursor>&limit=500` repeatedly until
 *     `hasMore: false`.
 *   - Hand the caller the set of affected paths so it can decide
 *     what to refetch — typically that's just bumping a global
 *     "vault changed" nonce, but a smarter consumer could
 *     refresh only the open doc.
 *   - Bump the cursor past every applied row so the next pull
 *     starts where this one ended.
 *
 * Idempotency: re-pulling the same range is a no-op (server is
 * read-only, client cursor only advances on success). Safe to call
 * repeatedly.
 */
import { getLastSeenLsn, setLastSeenLsn } from './cursor'

const ENDPOINT = '/api/sync/pull'
const PAGE_SIZE = 500
const MAX_PAGES = 20

type ChangeRow = {
  lsn: number
  owner: string
  entityType: string
  entityId: string
  kind: string
  payload: Record<string, unknown> | null
  ts: number
}

export type PullSummary = {
  /** Total rows applied across all pages. */
  count: number
  /** New cursor — also already persisted to localStorage. */
  cursor: number
  /** Vault-relative paths that changed. Caller refetches what it
   *  cares about; for a global "something changed" UI, the
   *  callback in `pullSince` already fires for each row. */
  affectedPaths: string[]
  /** Per-row events the caller may want to surface in the UI —
   *  conflicts coming in from another device live here (the
   *  payload's `kind` is `doc.upsert` but the path matches the
   *  `<orig>.conflict-<ts>.<ext>` convention). */
  rows: ChangeRow[]
}

let inFlight: Promise<PullSummary> | null = null

function looksLikeConflictPath(p: string): boolean {
  return /\.conflict-\d+\.(md|markdown|mdx|txt|csv|json)$/i.test(p)
}

/** Pull every change since the persisted cursor. Calls `onRow`
 *  for each row as it arrives so a hot UI can react before the
 *  full set is in. Single-flight: a second concurrent caller
 *  shares the in-flight promise. */
export function pullSince(
  onRow?: (row: ChangeRow) => void,
): Promise<PullSummary> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    let cursor = getLastSeenLsn()
    const seen = new Set<string>()
    const allRows: ChangeRow[] = []
    let pages = 0
    while (pages < MAX_PAGES) {
      let res: Response
      try {
        res = await fetch(
          `${ENDPOINT}?since=${cursor}&limit=${PAGE_SIZE}`,
          {
            method: 'GET',
            credentials: 'include',
            headers: { accept: 'application/json' },
          },
        )
      } catch {
        // Network blip — return what we have and let the next
        // reconnect resume.
        break
      }
      if (!res.ok) {
        // 401 (signed out) or 5xx (server issue) — same handling:
        // give up this round, retry on next online event.
        break
      }
      const body = (await res.json().catch(() => null)) as
        | { changes: ChangeRow[]; hasMore: boolean; head: number }
        | null
      if (!body) break
      for (const r of body.changes) {
        allRows.push(r)
        seen.add(r.entityId)
        onRow?.(r)
        if (r.lsn > cursor) cursor = r.lsn
      }
      // Persist the cursor between pages too — if we crash on
      // page 3 we don't refetch pages 1+2 on the next try.
      setLastSeenLsn(cursor)
      pages++
      if (!body.hasMore) break
    }
    inFlight = null
    return {
      count: allRows.length,
      cursor,
      affectedPaths: [...seen],
      rows: allRows,
    }
  })()
  return inFlight
}

/** Filter rows the caller may want to alert on. Today: conflict
 *  files (`<path>.conflict-<ts>.md`) coming in from another
 *  device. Extend as new event types deserve UI attention. */
export function notableRows(rows: ChangeRow[]): ChangeRow[] {
  return rows.filter((r) => looksLikeConflictPath(r.entityId))
}
