/**
 * Drains the IndexedDB queue against `/api/sync/push`. Hooked to
 * fire on:
 *   1. App mount (in case the previous session crashed mid-replay)
 *   2. `online` event (came back from offline)
 *   3. Manual trigger from the status badge
 *
 * Strategy:
 *   - Batch up to BATCH_LIMIT ops per push (server caps at 200).
 *   - Per-op outcome:
 *       applied / duplicate → markApplied (drop from queue)
 *       conflict            → markApplied + emit notice
 *       error               → markFailure, leave in queue
 *   - Single in-flight drain: a second concurrent caller waits on
 *     the first promise so we don't double-push the same row.
 */
import { listPending, markApplied, markFailure } from './queue'

const BATCH_LIMIT = 50
const ENDPOINT = '/api/sync/push'

export type ReplayResult = {
  attempted: number
  applied: number
  duplicate: number
  conflicts: { entityId: string; conflictPath: string }[]
  errors: { clientOpId: string; error: string }[]
}

let inFlight: Promise<ReplayResult> | null = null

export function drainQueue(): Promise<ReplayResult> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const pending = await listPending()
      if (pending.length === 0) {
        return { attempted: 0, applied: 0, duplicate: 0, conflicts: [], errors: [] }
      }
      const batch = pending.slice(0, BATCH_LIMIT)
      const ops = batch.map((o) => ({
        clientOpId: o.clientOpId,
        entityId: o.entityId,
        kind: o.kind,
        ...o.body,
      }))
      let res: Response
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
          },
          body: JSON.stringify({ ops }),
        })
      } catch (e) {
        // Network blip — leave the rows alone, the next online
        // event will retry.
        for (const o of batch) {
          await markFailure(o.clientOpId, (e as Error).message ?? 'network').catch(() => null)
        }
        return {
          attempted: batch.length,
          applied: 0,
          duplicate: 0,
          conflicts: [],
          errors: batch.map((o) => ({
            clientOpId: o.clientOpId,
            error: (e as Error).message ?? 'network',
          })),
        }
      }
      if (!res.ok) {
        // 4xx/5xx response — log against each op and back off.
        const text = await res.text().catch(() => `${res.status}`)
        for (const o of batch) await markFailure(o.clientOpId, text).catch(() => null)
        return {
          attempted: batch.length,
          applied: 0,
          duplicate: 0,
          conflicts: [],
          errors: batch.map((o) => ({ clientOpId: o.clientOpId, error: text })),
        }
      }
      const body = (await res.json()) as {
        results: Array<
          | { clientOpId: string; result: 'applied'; lsn: number }
          | { clientOpId: string; result: 'duplicate'; lsn: number }
          | { clientOpId: string; result: 'conflict'; conflictPath: string; lsn: number }
          | { clientOpId: string; result: 'error'; error: string }
        >
      }
      const out: ReplayResult = {
        attempted: batch.length,
        applied: 0,
        duplicate: 0,
        conflicts: [],
        errors: [],
      }
      for (const r of body.results) {
        if (r.result === 'applied') {
          out.applied++
          await markApplied(r.clientOpId).catch(() => null)
        } else if (r.result === 'duplicate') {
          out.duplicate++
          await markApplied(r.clientOpId).catch(() => null)
        } else if (r.result === 'conflict') {
          // The push endpoint already wrote our bytes to a
          // sibling file, so we drop the queue row — the user
          // resolves the conflict file manually.
          const op = batch.find((o) => o.clientOpId === r.clientOpId)
          if (op) out.conflicts.push({ entityId: op.entityId, conflictPath: r.conflictPath })
          await markApplied(r.clientOpId).catch(() => null)
        } else if (r.result === 'error') {
          out.errors.push({ clientOpId: r.clientOpId, error: r.error })
          await markFailure(r.clientOpId, r.error).catch(() => null)
        }
      }
      return out
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
