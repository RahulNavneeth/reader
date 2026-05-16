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

// Per-doc-id serialization. Without this, two concurrent saveMeta(sameId)
// calls each create their own temp file and the second rename silently
// wins — the first writer's mutation vanishes (e.g. concurrent tag edit
// + visibility flip would lose one side). Cheap promise chain per id;
// chain is dropped once empty so the map can't grow unbounded.
const saveLocks = new Map<string, Promise<void>>()

export async function saveMeta(meta: DocumentMeta): Promise<void> {
  const id = meta.id
  const prev = saveLocks.get(id) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(() => writeJson(metaFile(id), meta))
  saveLocks.set(id, next)
  try {
    await next
  } finally {
    // Only clear if no newer call has taken the slot since.
    if (saveLocks.get(id) === next) saveLocks.delete(id)
  }
}

export async function loadMeta(id: string): Promise<DocumentMeta | null> {
  return readJson<DocumentMeta>(metaFile(id))
}

export async function deleteDocument(id: string): Promise<void> {
  await rm(docDir(id), { recursive: true, force: true })
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

export async function listAllDocuments(): Promise<DocumentMeta[]> {
  const ids = await readdir(config.paths.documents).catch(() => [])
  const out: DocumentMeta[] = []
  for (const id of ids) {
    if (id.startsWith('.')) continue
    const m = await loadMeta(id)
    if (m) out.push(m)
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
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
