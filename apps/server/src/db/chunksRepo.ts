/**
 * Chunk + embedding repository. Replaces the in-memory Float32Array
 * cache that `services/search.ts` used to build at boot.
 *
 * Embeddings are stored as little-endian Float32 BLOBs. Encoding /
 * decoding is just `Buffer.from(arr.buffer)` and its inverse — no
 * JSON, no overhead.
 *
 * Three write paths:
 *   - replaceChunks(docId, chunks) — wipe + rewrite all chunks for
 *     a doc. Used by ingest after a successful re-embed.
 *   - clearChunks(docId) — drop the rows when a doc is deleted
 *     (the ON DELETE CASCADE on the FK does this too, but the
 *     explicit call lets callers force it without touching the
 *     documents row).
 *
 * Read paths:
 *   - streamChunks(docId) — yields rows for one doc.
 *   - streamEmbeddedChunks(allowedDocIds) — yields all chunks that
 *     have a non-null embedding for ANY doc in the allowedIds set.
 *     Used by the semantic search loop.
 */
import { db } from './sqlite.js'
import type { Chunk } from '../types.js'

function encodeEmbedding(v: number[] | undefined): Buffer | null {
  if (!v || v.length === 0) return null
  // The Float32Array constructor copies; we hand the underlying
  // buffer to better-sqlite3 which BLOB-serializes as-is.
  const f = new Float32Array(v)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

function decodeEmbedding(buf: Buffer | null, dim: number | null): Float32Array | null {
  if (!buf || !dim) return null
  // Buffer rows from SQLite may not be 4-byte aligned. Copy into a
  // fresh ArrayBuffer before casting so the Float32Array doesn't
  // alias an off-alignment slice (would throw on read).
  const ab = new ArrayBuffer(buf.byteLength)
  Buffer.from(ab).set(buf)
  return new Float32Array(ab, 0, dim)
}

export function replaceChunks(docId: string, chunks: Chunk[]): void {
  const d = db()
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
    const ins = d.prepare(
      'INSERT INTO chunks (doc_id, idx, text, embedding, embed_dim) VALUES (?, ?, ?, ?, ?)',
    )
    for (const c of chunks) {
      const blob = encodeEmbedding(c.embedding)
      ins.run(docId, c.idx, c.text, blob, blob ? c.embedding.length : null)
    }
  })
  tx()
}

export function clearChunks(docId: string): void {
  db().prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
}

export function* streamChunks(docId: string): Generator<Chunk> {
  const rows = db()
    .prepare(
      'SELECT idx, text, embedding, embed_dim FROM chunks WHERE doc_id = ? ORDER BY idx',
    )
    .iterate(docId) as Iterable<{
    idx: number
    text: string
    embedding: Buffer | null
    embed_dim: number | null
  }>
  for (const r of rows) {
    const f = decodeEmbedding(r.embedding, r.embed_dim)
    yield {
      idx: r.idx,
      text: r.text,
      embedding: f ? Array.from(f) : [],
    }
  }
}

/**
 * Streamed scan of all chunks that have an embedding AND belong to
 * a doc the caller is allowed to see. Yields a typed Float32Array
 * directly so the cosine loop in services/search.ts doesn't have to
 * round-trip through a plain number[] (and the JS engine can keep
 * the array in fast SMI/double-elements mode).
 *
 * The (doc_id) index makes the IN-list lookup cheap, and the partial
 * index `idx_chunks_embedded` lets SQLite skip rows where the
 * embedding never landed.
 */
export type EmbeddedChunkRow = {
  docId: string
  idx: number
  text: string
  embedding: Float32Array
  norm: number
}

export function* streamEmbeddedChunks(
  allowedDocIds: ReadonlySet<string>,
): Generator<EmbeddedChunkRow> {
  if (allowedDocIds.size === 0) return
  // SQLite's variable-binding limit is 32K by default — far past any
  // realistic per-user vault size. If we ever cross that we chunk
  // the IN list; for now one query covers it.
  const ids = Array.from(allowedDocIds)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db()
    .prepare(
      `SELECT doc_id, idx, text, embedding, embed_dim
         FROM chunks
        WHERE embedding IS NOT NULL AND doc_id IN (${placeholders})`,
    )
    .iterate(...ids) as Iterable<{
    doc_id: string
    idx: number
    text: string
    embedding: Buffer
    embed_dim: number
  }>
  for (const r of rows) {
    const f = decodeEmbedding(r.embedding, r.embed_dim)
    if (!f) continue
    // Pre-compute norm so cosine is a single dot-product per row at
    // search time instead of two passes.
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    yield {
      docId: r.doc_id,
      idx: r.idx,
      text: r.text,
      embedding: f,
      norm: Math.sqrt(sum),
    }
  }
}

export function count(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
}
