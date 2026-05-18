import path from 'node:path'
import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { ensureDir, readJson, removeFile, safeFileName, writeJson } from '../lib/fs.js'
import type { Chunk, DocumentMeta } from '../types.js'

function docDir(id: string): string {
  return path.join(config.paths.documents, safeFileName(id))
}

export function metaFile(id: string): string {
  return path.join(docDir(id), 'meta.json')
}

export function textFile(id: string): string {
  return path.join(docDir(id), 'text.txt')
}

export function chunksFile(id: string): string {
  return path.join(docDir(id), 'chunks.jsonl')
}

export function thumbnailFile(id: string): string {
  return path.join(docDir(id), 'thumb.png')
}

export async function readThumbnail(id: string): Promise<Buffer | null> {
  try {
    return await readFile(thumbnailFile(id))
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

export async function writeThumbnail(id: string, buffer: Buffer): Promise<void> {
  await ensureDir(docDir(id))
  await writeFile(thumbnailFile(id), buffer)
}

/**
 * Full-size derived JPEG, used to display formats browsers can't render
 * natively (HEIC). Distinct from `thumb.png` so we don't trash the small,
 * cheap-to-serve thumbnail.
 */
export function previewFile(id: string): string {
  return path.join(docDir(id), 'preview.jpg')
}

export async function readPreview(id: string): Promise<Buffer | null> {
  try {
    return await readFile(previewFile(id))
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

export async function writePreview(id: string, buffer: Buffer): Promise<void> {
  await ensureDir(docDir(id))
  await writeFile(previewFile(id), buffer)
}

/**
 * Sidecar holding the doc's CLIP image embedding (a 512-dim float
 * vector). Lives next to meta/text/chunks so a `deleteDocument` rm
 * of the dir takes it out with everything else.
 *
 * JSON, not binary, because the per-doc cost is ~4 KB — small enough
 * that the readability of being able to `cat` the file outweighs the
 * 4× size win you'd get from Float32 binary.
 */
export function clipFile(id: string): string {
  return path.join(docDir(id), 'clip.json')
}

export async function readClipEmbedding(id: string): Promise<number[] | null> {
  try {
    const raw = await readFile(clipFile(id), 'utf8')
    const parsed = JSON.parse(raw) as { vector?: number[] }
    return Array.isArray(parsed.vector) ? parsed.vector : null
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    return null
  }
}

export async function writeClipEmbedding(id: string, vector: number[]): Promise<void> {
  await ensureDir(docDir(id))
  await writeFile(
    clipFile(id),
    JSON.stringify({ dim: vector.length, vector }),
  )
}

// Per-doc-id serialization for saveMeta.
//
// Why this exists: writeJson() does atomic-replace via temp-file +
// rename. Two concurrent saveMeta(sameId) calls each create their
// own temp file and race on the rename — the loser's mutation just
// disappears (e.g. tag edit + visibility flip arriving in the same
// tick would silently lose one side). The map+promise-chain pattern
// queues writes for the same id so they apply in arrival order.
//
// How it works: each entry is the in-flight write chain for a given
// doc id. New calls append to the chain via `.then()`, so the next
// write only starts after the previous resolves. The `.catch()` on
// the previous step ensures one writer's failure doesn't cancel the
// queue (the failed writer still throws to its own caller).
//
// Why a Map and not a single global lock: most writes are to
// different docs and shouldn't serialize across the whole vault. The
// `saveLocks.get(id) === next` cleanup in the finally is essential:
// without it the map grows forever and you leak a Promise per write;
// with it, the entry survives only while another call has appended
// to the chain, otherwise it's dropped.
//
// Trade-off: in-process only. A second Reader instance writing the
// same doc would still race — file-system flock would be the next
// step if/when we add multi-process deployments. Today's single-
// node assumption makes that unnecessary.
const saveLocks = new Map<string, Promise<void>>()

// In-memory index of all DocumentMeta keyed by id, populated lazily
// on first `listAllDocuments()` call and maintained by saveMeta /
// deleteDocument from there on.
//
// Why this exists: a fresh listAllDocuments() does readdir +
// loadMeta-per-id, which is ~N disk seeks. At 10k+ docs that's
// hundreds of ms per call, and every list/search hit reads the
// whole index. The cache turns that into an O(1) Map read with no
// disk traffic until something changes.
//
// Eventually the right answer is SQLite (this map at 100k docs ×
// ~10KB each is 1GB of RAM); for now we get a 100× speedup without
// adding a dep. The migration to a real KV/SQL adapter just swaps
// the impl behind these three exported functions.
let docIndex: Map<string, DocumentMeta> | null = null
let indexLoad: Promise<Map<string, DocumentMeta>> | null = null

async function loadIndex(): Promise<Map<string, DocumentMeta>> {
  if (docIndex) return docIndex
  if (indexLoad) return indexLoad
  indexLoad = (async () => {
    const ids = await readdir(config.paths.documents).catch(() => [])
    const m = new Map<string, DocumentMeta>()
    for (const id of ids) {
      if (id.startsWith('.')) continue
      const meta = await readJson<DocumentMeta>(metaFile(id))
      if (meta) m.set(id, meta)
    }
    docIndex = m
    indexLoad = null
    return m
  })()
  return indexLoad
}

/** Drop the in-memory index so the next list rebuilds from disk.
 *  Used by tests + the admin "reembed all" sweep that mutates many
 *  metas in a row. */
export function invalidateDocIndex(): void {
  docIndex = null
  indexLoad = null
}

export async function saveMeta(meta: DocumentMeta): Promise<void> {
  const id = meta.id
  const prev = saveLocks.get(id) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(() => writeJson(metaFile(id), meta))
  saveLocks.set(id, next)
  try {
    await next
    // Update the in-memory index alongside disk so listAllDocuments
    // reflects the change immediately. Skip if the index hasn't been
    // built yet — first call will populate it from disk anyway.
    if (docIndex) docIndex.set(id, meta)
  } finally {
    // Only clear if no newer call has taken the slot since.
    if (saveLocks.get(id) === next) saveLocks.delete(id)
  }
}

export async function loadMeta(id: string): Promise<DocumentMeta | null> {
  if (docIndex?.has(id)) return docIndex.get(id) ?? null
  return readJson<DocumentMeta>(metaFile(id))
}

export async function deleteDocument(id: string): Promise<void> {
  await rm(docDir(id), { recursive: true, force: true })
  docIndex?.delete(id)
}

export async function writeText(id: string, text: string): Promise<void> {
  await ensureDir(docDir(id))
  await writeFile(textFile(id), text, 'utf8')
}

export async function readText(id: string): Promise<string | null> {
  try {
    return await readFile(textFile(id), 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

export async function writeChunks(id: string, chunks: Chunk[]): Promise<void> {
  await ensureDir(docDir(id))
  const lines = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n'
  await writeFile(chunksFile(id), lines, 'utf8')
}

/** Streams chunks from disk so we don't need to hold the whole file in memory. */
export async function* streamChunks(id: string): AsyncGenerator<Chunk> {
  let stream
  try {
    stream = createReadStream(chunksFile(id), 'utf8')
  } catch {
    return
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const t = line.trim()
      if (!t) continue
      try {
        yield JSON.parse(t) as Chunk
      } catch {
        // skip malformed
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

/**
 * Sweep public files whose expiry has passed and flip `public:false`.
 * Treats expired = private from then on, so everything downstream
 * (file globe, /api/list anonymous filter, /api/file/raw gate)
 * behaves consistently without special-casing 'expired'.
 *
 * Cheap pass over all doc metas; returns how many got flipped so the
 * boot/cron caller can log it.
 */
export async function sweepExpiredPublic(): Promise<number> {
  const docs = await listAllDocuments()
  const now = Date.now()
  let flipped = 0
  for (const d of docs) {
    if (!d.public) continue
    if (d.publicExpiresAt == null) continue
    if (d.publicExpiresAt > now) continue
    await saveMeta({
      ...d,
      public: false,
      publicExpiresAt: null,
      publicPasswordHash: null,
      updatedAt: now,
    })
    flipped++
  }
  return flipped
}

export async function listAllDocuments(): Promise<DocumentMeta[]> {
  const idx = await loadIndex()
  // Snapshot into an array + sort newest-first. Callers (search,
  // listing) historically rely on this ordering.
  return Array.from(idx.values()).sort((a, b) => b.createdAt - a.createdAt)
}

export function userCanRead(meta: DocumentMeta, username: string, role: string): boolean {
  if (role === 'admin') return true
  if (meta.owner === username) return true
  if (meta.acl.readers.includes(username)) return true
  if (meta.acl.readers.includes('*')) return true
  if (meta.acl.editors.includes(username)) return true
  return false
}

export function userCanEdit(meta: DocumentMeta, username: string, role: string): boolean {
  if (role === 'admin') return true
  if (meta.owner === username) return true
  if (meta.acl.editors.includes(username)) return true
  return false
}

export function sha256Of(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export async function diskFootprint(id: string): Promise<{ meta: number; text: number; chunks: number }> {
  const out = { meta: 0, text: 0, chunks: 0 }
  for (const [k, fp] of [['meta', metaFile(id)], ['text', textFile(id)], ['chunks', chunksFile(id)]] as const) {
    try {
      out[k] = (await stat(fp)).size
    } catch {
      // skip
    }
  }
  return out
}

export { removeFile }
