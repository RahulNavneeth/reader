/**
 * Offline mutation queue, persisted in IndexedDB. Enqueued ops survive
 * tab reloads + browser restarts; the replay loop drains them through
 * `/api/sync/push` once the network is back.
 *
 * Storage shape: one object store `queue`, keyed by `clientOpId`. We
 * keep the rows append-immutable until they're acked — `markApplied`
 * deletes, `markFailure` bumps attempts + writes lastError. The push
 * endpoint is itself idempotent on (owner, clientOpId), so retrying
 * an op the server already accepted is safe.
 *
 * No external dep on `idb` to keep the bundle small; the raw IDB API
 * is verbose but the surface used here is narrow (open, put, getAll,
 * delete) and wrapped in promises below.
 */

const DB_NAME = 'reader-sync'
const DB_VERSION = 1
const STORE = 'queue'

export type QueuedKind = 'doc.upsert' | 'doc.tags' | 'doc.visibility' | 'doc.archive'

export type QueuedOp = {
  clientOpId: string
  /** Vault-relative path (matches storage_key on the server). */
  entityId: string
  kind: QueuedKind
  /** Kind-specific fields. Mirrors the push endpoint's accepted body:
   *  { content?, baseSha?, tags?, public?, archived? }. */
  body: Record<string, unknown>
  createdAt: number
  /** How many times we've tried to push this. Used by the replay
   *  loop to back off + eventually surface as a permanent failure
   *  in the UI. */
  attempts: number
  lastError?: string
  lastAttemptAt?: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable (running outside browser?)'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'clientOpId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    // Block close on another tab's upgrade so we don't end up
    // holding a dead handle; the replay loop will re-open lazily.
    req.onblocked = () => reject(new Error('IDB open blocked'))
  })
  return dbPromise
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const s = t.objectStore(STORE)
        let result: T | undefined
        Promise.resolve(fn(s))
          .then((res) => {
            if (res && typeof res === 'object' && 'onsuccess' in res) {
              const req = res as IDBRequest<T>
              req.onsuccess = () => {
                result = req.result
              }
              req.onerror = () => reject(req.error)
            } else {
              result = res as T
            }
          })
          .catch(reject)
        t.oncomplete = () => resolve(result as T)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('idb tx aborted'))
      }),
  )
}

function newClientOpId(): string {
  // 22 chars of url-safe entropy. Reused across reloads — that's
  // intentional; an op gets the same id if we re-enqueue it.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) =>
    c === '+' ? '-' : c === '/' ? '_' : '',
  )
}

/** Append an op. Returns the `clientOpId` so callers can correlate
 *  the eventual server result back to whatever optimistic UI they
 *  set. */
export async function enqueue(
  op: Omit<QueuedOp, 'clientOpId' | 'createdAt' | 'attempts'>,
): Promise<string> {
  const clientOpId = newClientOpId()
  const row: QueuedOp = {
    ...op,
    clientOpId,
    createdAt: Date.now(),
    attempts: 0,
  }
  await tx('readwrite', (s) => s.put(row))
  return clientOpId
}

/** Snapshot of all pending ops, oldest first. Empty array on a
 *  fresh queue. */
export async function listPending(): Promise<QueuedOp[]> {
  const all = await tx<QueuedOp[]>('readonly', (s) => s.getAll())
  return [...all].sort((a, b) => a.createdAt - b.createdAt)
}

/** Drop an op from the queue. Server already accepted it (either
 *  applied or marked duplicate). */
export async function markApplied(clientOpId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(clientOpId))
}

/** Bump attempts + record the last failure reason. Caller decides
 *  whether to keep retrying or surface as permanent. */
export async function markFailure(
  clientOpId: string,
  error: string,
): Promise<void> {
  const existing = await tx<QueuedOp | undefined>('readonly', (s) =>
    s.get(clientOpId),
  )
  if (!existing) return
  const next: QueuedOp = {
    ...existing,
    attempts: existing.attempts + 1,
    lastError: error,
    lastAttemptAt: Date.now(),
  }
  await tx('readwrite', (s) => s.put(next))
}

/** Drop everything — wired into the "sign out" path so a different
 *  user opening this browser doesn't replay the previous account's
 *  queue. */
export async function clearAll(): Promise<void> {
  await tx('readwrite', (s) => s.clear())
}
