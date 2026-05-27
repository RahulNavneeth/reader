/**
 * In-memory registry of `Y.Doc` instances, keyed by docId.
 *
 *   - Lazy-load: a doc is hydrated from `documents.crdt_state` on
 *     first attach; if that column is NULL the Y.Doc starts empty
 *     and the disk bytes are imported as a single foreign update
 *     the first time we materialise (Phase 3 work).
 *
 *   - Persist: every Y.Doc update marks the entry dirty and arms
 *     a 2s debounce. On fire, the full state + state vector are
 *     written back to SQLite. We don't persist deltas — full
 *     state is a few kB for typical markdown, much simpler to
 *     reason about than a delta journal, and SQLite eats blobs
 *     just fine.
 *
 *   - Refcount: each WebSocket attach increments `attachCount`,
 *     each disconnect decrements. The eviction loop only sweeps
 *     entries with `attachCount === 0`. Without this guard, a
 *     swept Y.Doc would lose every connected client's
 *     not-yet-persisted updates the next time the registry
 *     re-hydrated from disk.
 *
 * Eviction policy is intentionally simple — periodic sweep, age-
 * based. Memory pressure isn't the constraint at our scale; this
 * is here so a daemon that's been up for weeks doesn't accumulate
 * a Y.Doc for every doc the user ever opened.
 */
import * as Y from 'yjs'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  loadCrdtState,
  markCrdtMaterialised,
  saveCrdtState,
  type CrdtSnapshot,
} from '../db/crdtRepo.js'

type DocLocator = {
  /** Vault-relative path; used for materialisation back to disk. */
  storageKey: string
  /** Username whose vault owns the file. */
  owner: string
}

type Entry = {
  doc: Y.Doc
  attachCount: number
  /** Marked true on every `update` event; cleared by the
   *  persist tick once we've written. */
  dirty: boolean
  /** Last time anyone attached. Used for evicting cold docs. */
  lastAttachAt: number
  /** Active debounce timer, if any. Reset on each new update. */
  saveTimer: NodeJS.Timeout | null
  /** Cached on first lease so materialisation doesn't have to
   *  round-trip through the documents repo on every flush. NULL
   *  before a lease provides locator hints — flush still
   *  persists the CRDT state, it just skips the disk write
   *  until we know the path. */
  locator: DocLocator | null
  /** In-flight materialise() chained promise. flush() (fire-and-
   *  forget, e.g. from detach) and flushDocSync (awaited, e.g.
   *  from upload_text / instantiate / chat apply-edit) both
   *  serialise through this so a second materialise can't start
   *  before the first finishes its ingest pipeline. Without this,
   *  ingestDocument's later saveMeta calls could land AFTER a
   *  subsequent route mutation (archive, set_visibility) and
   *  overwrite the just-set fields with the materialise call's
   *  stale meta snapshot. */
  materialisePromise: Promise<void> | null
}

const PERSIST_DEBOUNCE_MS = 2_000
const EVICT_SCAN_MS = 60_000
const EVICT_IDLE_MS = 10 * 60_000

const entries = new Map<string, Entry>()
let evictTimer: NodeJS.Timeout | null = null

function ensureEvictionLoop(): void {
  if (evictTimer) return
  evictTimer = setInterval(() => {
    const now = Date.now()
    for (const [docId, e] of entries) {
      if (e.attachCount > 0) continue
      if (now - e.lastAttachAt < EVICT_IDLE_MS) continue
      // Persist one last time before eviction so any in-flight
      // updates from the very last attach don't get lost.
      if (e.dirty) flush(docId, e)
      entries.delete(docId)
    }
  }, EVICT_SCAN_MS)
  // Don't keep the process alive just for the sweeper.
  evictTimer.unref?.()
}

function flush(docId: string, e: Entry): void {
  if (!e.dirty) return
  try {
    saveCrdtState(
      docId,
      Y.encodeStateAsUpdate(e.doc),
      Y.encodeStateVector(e.doc),
    )
    e.dirty = false
    // Schedule a disk-side materialisation. Async + fire-and-
    // forget — a failure (eg permission, disk full) leaves the
    // CRDT state authoritative; we just don't update the
    // mirror. Next flush retries.
    //
    // Chain off `e.materialisePromise` so a back-to-back flush
    // (detach + flushDocSync, two debounce ticks landing close)
    // doesn't run two materialise calls concurrently — ingest's
    // saveMeta calls capture meta at materialise start, and
    // overlapping calls can clobber unrelated fields the second
    // call wasn't aware of.
    if (e.locator) {
      const locator = e.locator
      const prev = e.materialisePromise ?? Promise.resolve()
      e.materialisePromise = prev.then(() => materialise(docId, e.doc, locator))
      e.materialisePromise.catch(() => null)
    }
  } catch {
    // Swallow — next debounce / eviction retries. Logging would
    // need to thread a logger through; leaving silent for now
    // because the worst case is data only in memory until the
    // process restarts, and Phase 1 LWW writes still provide a
    // floor of durability via the file-system writes.
  }
}

/** Flush the Y.Doc's body text back to disk + re-ingest so the
 *  rest of the stack (chat AI, search, embeddings, public
 *  shares, `cat` / `nvim`) sees the latest content. Idempotent
 *  vs the chokidar watcher: we register the expected sha so the
 *  watcher's `change` event no-ops instead of re-ingesting on
 *  top of us.
 *
 *  We import these helpers dynamically to avoid a top-level
 *  cycle (`crdtRegistry → documents store → events → registry`
 *  would otherwise close the loop). */
async function materialise(
  docId: string,
  doc: Y.Doc,
  locator: DocLocator,
): Promise<void> {
  try {
    const body = doc.getText('body').toString()
    // Empty Y.Text means "not seeded yet" — don't overwrite a
    // perfectly good disk file with zero bytes just because the
    // CRDT has nothing to flush.
    if (body.length === 0) return
    const { resolveUserVault } = await import('../lib/userVault.js')
    const { sha256Of, loadMeta, saveMeta } = await import('../stores/documents.js')
    const { markExpectedWrite } = await import('./webhooks.js')
    const { ingestDocument } = await import('./ingest.js')
    const { invalidateSearchCache } = await import('./search.js')
    const { publish } = await import('./events.js')
    const abs = resolveUserVault(locator.owner, locator.storageKey)
    const buf = Buffer.from(body, 'utf8')
    const newSha = sha256Of(buf)
    const meta = await loadMeta(docId)
    if (!meta) return
    if (meta.sha256 === newSha) {
      // No drift — disk already reflects the CRDT. Skip the
      // write but still stamp materialised_at so eviction sees
      // a fresh timestamp.
      markCrdtMaterialised(docId, Date.now())
      return
    }
    await mkdir(path.dirname(abs), { recursive: true })
    markExpectedWrite(abs, newSha)
    await writeFile(abs, buf)
    const next = {
      ...meta,
      bytes: buf.length,
      sha256: newSha,
      updatedAt: Date.now(),
      ingest: { status: 'pending' as const, embedded: false },
    }
    await saveMeta(next)
    await ingestDocument(next, buf)
    invalidateSearchCache()
    markCrdtMaterialised(docId, Date.now())
    publish({ type: 'edit', path: locator.storageKey, docId })
  } catch {
    /* see flush() — best-effort, retry on next persist. */
  }
}

/** Best-effort seed from disk bytes when the Y.Doc is empty + a
 *  real markdown file exists at the locator. Lets a doc that
 *  existed before CRDT came along bootstrap its Y.Doc with
 *  current content the first time anyone attaches. */
async function maybeSeedFromDisk(
  doc: Y.Doc,
  locator: DocLocator,
): Promise<void> {
  try {
    const ytext = doc.getText('body')
    if (ytext.length > 0) return
    const { resolveUserVault } = await import('../lib/userVault.js')
    const abs = resolveUserVault(locator.owner, locator.storageKey)
    const s = await stat(abs).catch(() => null)
    if (!s?.isFile()) return
    // Only seed text-shaped files. Binaries would explode the
    // Y.Text and the CRDT model doesn't help for non-markdown
    // content anyway.
    if (!/\.(md|markdown|mdx|txt|csv|json)$/i.test(locator.storageKey)) return
    const buf = await readFile(abs)
    const content = buf.toString('utf8')
    if (!content) return
    // Single transaction so the seed is one CRDT op (not N
    // per-char ops) — keeps the state vector small.
    doc.transact(() => {
      ytext.insert(0, content)
    }, 'seed-from-disk')
  } catch {
    /* swallow; an unseeded doc is fine — the next deliberate
     * write will populate it. */
  }
}

function attach(docId: string, locator?: DocLocator): Entry {
  let e = entries.get(docId)
  if (!e) {
    const doc = new Y.Doc()
    const snapshot: CrdtSnapshot = loadCrdtState(docId)
    if (snapshot.state) {
      // Hydrate from persisted state. Any subscribers attached
      // during this synchronous call will receive the rehydrated
      // state through the normal Yjs sync protocol — they don't
      // see the import-as-update event because we apply BEFORE
      // wiring the update listener below.
      Y.applyUpdate(doc, snapshot.state)
    }
    e = {
      doc,
      attachCount: 0,
      dirty: false,
      lastAttachAt: Date.now(),
      saveTimer: null,
      locator: locator ?? null,
      materialisePromise: null,
    }
    // Async seed-from-disk for first-time CRDT lease against a
    // pre-existing markdown file. Fires the registry's update
    // listener exactly once — Yjs delivers that to peers as a
    // single insert, much smaller than per-char broadcasting.
    if (locator && !snapshot.state) {
      void maybeSeedFromDisk(doc, locator)
    }
    doc.on('update', () => {
      // We may not have an entry anymore if the doc was evicted
      // mid-tick; tolerate that.
      const current = entries.get(docId)
      if (!current) return
      current.dirty = true
      if (current.saveTimer) clearTimeout(current.saveTimer)
      current.saveTimer = setTimeout(() => {
        current.saveTimer = null
        flush(docId, current)
      }, PERSIST_DEBOUNCE_MS)
      current.saveTimer.unref?.()
    })
    entries.set(docId, e)
  }
  // A late-arriving lease may know the locator the first one
  // didn't — fill it in opportunistically so materialisation
  // can start working as soon as anyone tells us where the
  // file is on disk.
  if (locator && !e.locator) e.locator = locator
  e.attachCount++
  e.lastAttachAt = Date.now()
  ensureEvictionLoop()
  return e
}

function detach(docId: string): void {
  const e = entries.get(docId)
  if (!e) return
  e.attachCount = Math.max(0, e.attachCount - 1)
  // On the last detach, force a flush so a process kill within
  // PERSIST_DEBOUNCE_MS of the last edit doesn't lose data.
  if (e.attachCount === 0 && e.dirty) {
    if (e.saveTimer) {
      clearTimeout(e.saveTimer)
      e.saveTimer = null
    }
    flush(docId, e)
  }
}

/** Lease a Y.Doc — caller must invoke `release()` exactly once on
 *  every code path (WebSocket close, error, normal exit). The
 *  registry uses the refcount to defer eviction.
 *
 *  Pass `locator` if you know the owner + storage path; that
 *  enables initial seed-from-disk on the very first lease and
 *  materialisation back to disk after edits. The WebSocket
 *  route always provides it (it already loaded meta for the
 *  ACL check). */
export function leaseDoc(
  docId: string,
  locator?: DocLocator,
): { doc: Y.Doc; release: () => void } {
  const e = attach(docId, locator)
  let released = false
  return {
    doc: e.doc,
    release: () => {
      if (released) return
      released = true
      detach(docId)
    },
  }
}

/** Force a synchronous persist of every dirty doc. Wired into the
 *  server's shutdown hook so a clean restart doesn't drop the last
 *  2 seconds of edits. */
export function flushAll(): void {
  for (const [docId, e] of entries) flush(docId, e)
}

/**
 * Synchronously flush + materialise a single doc. Used by mutation
 * routes that want to be the canonical writer through the CRDT
 * layer instead of touching the filesystem themselves: they
 * `broadcastEdit(newBody)` to push the bytes into Y.Text, then
 * `await flushDocSync(docId)` so the materialiser writes the
 * file, saves meta, runs ingest, and the route can return the
 * fresh meta.
 *
 * Cancels the pending 2s debounce so the persist happens now
 * instead of slowly. Returns null if the doc id has never been
 * leased (callers should always broadcastEdit before calling).
 */
export async function flushDocSync(docId: string): Promise<void> {
  const e = entries.get(docId)
  if (!e) return
  if (e.saveTimer) {
    clearTimeout(e.saveTimer)
    e.saveTimer = null
  }
  if (e.dirty) {
    try {
      saveCrdtState(
        docId,
        Y.encodeStateAsUpdate(e.doc),
        Y.encodeStateVector(e.doc),
      )
      e.dirty = false
    } catch {
      /* keep going — failing here means we lose the BLOB row but
       * the disk write below is still worth doing. */
    }
  }
  if (e.locator) {
    // Chain through e.materialisePromise so any in-flight
    // fire-and-forget materialise from a recent flush() (e.g.
    // broadcastEdit's detach-flush) is awaited too. See the
    // matching comment in flush().
    const locator = e.locator
    const prev = e.materialisePromise ?? Promise.resolve()
    e.materialisePromise = prev.then(() => materialise(docId, e.doc, locator))
    await e.materialisePromise
  }
}

/**
 * Phase 4 hand-off: after a server-side mutation (chat apply-edit,
 * MCP granular edit, version restore, template refresh, etc.)
 * writes its bytes to disk, call this to mirror the new body into
 * the Y.Doc + broadcast to any connected WebSocket clients.
 *
 * Semantics:
 *   - If the Y.Doc's body is already identical to `nextBody`, no
 *     transaction is created (avoids a redundant CRDT op + the
 *     materialiser's sha-match no-op tick).
 *   - Otherwise we delete the entire Y.Text and insert `nextBody`
 *     as a single transaction. This is intentionally coarse — the
 *     server-side mutators operate on whole-body transforms, so
 *     finer deltas would have to be reconstructed via diff (and
 *     diffing markdown is itself an open problem we don't need to
 *     solve to get the broadcast).
 *   - Refcount: we lease + immediately release, so an idle doc
 *     persisted state stays load-on-demand; an active doc gets a
 *     bump on `lastAttachAt` so the eviction loop doesn't pull
 *     it out from under live clients.
 */
export function broadcastEdit(
  docId: string,
  locator: DocLocator,
  nextBody: string,
  origin = 'server-mutation',
): void {
  const lease = leaseDoc(docId, locator)
  try {
    const ytext = lease.doc.getText('body')
    if (ytext.toString() === nextBody) return
    lease.doc.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, nextBody)
    }, origin)
  } finally {
    lease.release()
  }
}

/** Test hook: drop every Y.Doc from memory + cancel the
 *  eviction loop. Persisted state is untouched. */
export function _resetForTest(): void {
  for (const e of entries.values()) {
    if (e.saveTimer) clearTimeout(e.saveTimer)
  }
  entries.clear()
  if (evictTimer) {
    clearInterval(evictTimer)
    evictTimer = null
  }
}

export function _registryStats(): { docs: number; attachments: number } {
  let attachments = 0
  for (const e of entries.values()) attachments += e.attachCount
  return { docs: entries.size, attachments }
}
