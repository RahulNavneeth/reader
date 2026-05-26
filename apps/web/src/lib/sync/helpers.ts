/**
 * Shared offline-first plumbing for mutation buttons. Two small
 * helpers so each call site stays ~5 lines of branching instead of
 * the 20-line block ArchiveButton ended up with.
 */
import { enqueue, type QueuedKind } from './queue'
import { drainQueue } from './replay'

/** Quick classifier — does this look like a connectivity failure
 *  we should treat as "queue + retry later" vs a real 4xx/5xx the
 *  user should see? Covers both the browser's offline flag and the
 *  shape of errors that bubble out of `fetch` when DNS / TCP /
 *  TLS dies. */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  const msg = (e as Error)?.message ?? ''
  return /fetch|network|offline|failed to fetch|err_internet/i.test(msg)
}

/** Enqueue an op + try to drain right away. Used by mutation
 *  buttons in the "I tried to send and the network seems flakey"
 *  branch — parking the op is the durable guarantee, the drain
 *  attempt is best-effort (the network may have already come
 *  back; if not, the next online event picks it up). */
export async function enqueueAndTryDrain(op: {
  entityId: string
  kind: QueuedKind
  body: Record<string, unknown>
}): Promise<void> {
  await enqueue(op).catch(() => null)
  void drainQueue().catch(() => null)
}
