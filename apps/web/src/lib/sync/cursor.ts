/**
 * Per-client cursor tracking which LSN we last pulled from
 * `/api/sync/pull`. Persisted to localStorage so a tab reload
 * doesn't replay every change since the user's signup — the next
 * pull picks up exactly where we left off.
 *
 * Two design notes:
 *
 *   - Single key, single value. We don't track per-tab cursors —
 *     all tabs in the same browser share one user's queue, so they
 *     share one cursor. A second tab "racing" the first just
 *     means two pulls land with the same `since`; the server is
 *     idempotent on that.
 *
 *   - localStorage chosen over IndexedDB. The cursor is one
 *     number, read on every replay/pull cycle (twice per online
 *     event). The synchronous localStorage call is ~µs; opening
 *     IDB is ~ms. Not worth the wrapping cost for a single value.
 *     A wipe (via `clearCursor()`) lives on the logout path next
 *     to the queue's `clearAll`.
 */

const KEY = 'reader:syncCursor'

export function getLastSeenLsn(): number {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function setLastSeenLsn(lsn: number): void {
  try {
    localStorage.setItem(KEY, String(lsn))
  } catch {
    /* private mode / quota — survives as in-memory state for this
     * tab, lost on reload. Next pull will start from 0 again,
     * which is correct-but-noisy fallback behavior. */
  }
}

export function clearCursor(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to do — see above. */
  }
}
