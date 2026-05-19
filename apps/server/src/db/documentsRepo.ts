/**
 * Documents index repository — read/write API over the SQL tables
 * defined in `migrations/001_documents.sql`. Replaces the
 * read-everything-into-a-Map approach in stores/documents.ts.
 *
 * Mapping rules:
 *   - boolean flags use INTEGER 0/1 in SQL, JS booleans in the type.
 *   - The nested `ingest` object is flattened to `ingest_*` columns.
 *   - `entities` is round-tripped through a JSON blob (the field is
 *     a small object of string arrays; not worth normalising).
 *   - GPS is tri-state (untried | tried-no-data | has-coords) via the
 *     gps_tried flag + nullable lat/lng columns; see the SQL file.
 *   - Tags and ACL readers/editors live in join tables, so each
 *     upsert replaces the full set for a doc inside one transaction.
 *
 * All write methods batch their multi-table writes inside a single
 * SQLite transaction so a save is either fully applied or rolled back.
 */
import { db } from './sqlite.js'
import type { DocumentMeta } from '../types.js'

type DocRow = {
  id: string
  owner: string
  storage_key: string
  title: string
  original_filename: string
  mime: string
  bytes: number
  sha256: string
  created_at: number
  updated_at: number
  public: number
  public_expires_at: number | null
  public_password_hash: string | null
  collection_id: string | null
  ingest_status: string
  ingest_error: string | null
  ingest_chunk_count: number | null
  ingest_embed_dim: number | null
  ingest_embedded: number
  ingest_extracted_at: number | null
  ingest_embedded_at: number | null
  entities_json: string | null
  gps_lat: number | null
  gps_lng: number | null
  gps_tried: number
  p_hash: string | null
  live_photo_pair: string | null
  hls_ready: number
}

function rowToMeta(
  row: DocRow,
  tags: string[],
  readers: string[],
  editors: string[],
): DocumentMeta {
  // Reconstruct the tri-state GPS field exactly as the JSON encoding
  // expected it: `undefined` means untried, `null` means tried+absent,
  // `{lat,lng}` means has-coords.
  let gps: DocumentMeta['gps']
  if (row.gps_tried === 1) {
    gps = row.gps_lat != null && row.gps_lng != null
      ? { lat: row.gps_lat, lng: row.gps_lng }
      : null
  }
  // pHash: NULL → untried (undefined), '' → tried-failed (null), hex → ok.
  let pHash: DocumentMeta['pHash']
  if (row.p_hash === '') pHash = null
  else if (row.p_hash != null) pHash = row.p_hash
  return {
    id: row.id,
    title: row.title,
    originalFilename: row.original_filename,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    storageKey: row.storage_key,
    owner: row.owner,
    acl: {
      readers,
      editors,
    },
    public: row.public === 1,
    publicExpiresAt: row.public_expires_at,
    publicPasswordHash: row.public_password_hash,
    tags,
    collectionId: row.collection_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ingest: {
      status: row.ingest_status as DocumentMeta['ingest']['status'],
      error: row.ingest_error ?? undefined,
      chunkCount: row.ingest_chunk_count ?? undefined,
      embedDim: row.ingest_embed_dim ?? undefined,
      embedded: row.ingest_embedded === 1,
      extractedAt: row.ingest_extracted_at ?? undefined,
      embeddedAt: row.ingest_embedded_at ?? undefined,
    },
    entities: row.entities_json ? JSON.parse(row.entities_json) : undefined,
    gps,
    pHash,
    livePhotoPair: row.live_photo_pair,
    hlsReady: row.hls_ready === 1,
  }
}

const UPSERT_SQL = `
  INSERT INTO documents (
    id, owner, storage_key, title, original_filename, mime, bytes, sha256,
    created_at, updated_at,
    public, public_expires_at, public_password_hash, collection_id,
    ingest_status, ingest_error, ingest_chunk_count, ingest_embed_dim,
    ingest_embedded, ingest_extracted_at, ingest_embedded_at,
    entities_json, gps_lat, gps_lng, gps_tried,
    p_hash, live_photo_pair, hls_ready
  ) VALUES (
    @id, @owner, @storage_key, @title, @original_filename, @mime, @bytes, @sha256,
    @created_at, @updated_at,
    @public, @public_expires_at, @public_password_hash, @collection_id,
    @ingest_status, @ingest_error, @ingest_chunk_count, @ingest_embed_dim,
    @ingest_embedded, @ingest_extracted_at, @ingest_embedded_at,
    @entities_json, @gps_lat, @gps_lng, @gps_tried,
    @p_hash, @live_photo_pair, @hls_ready
  )
  ON CONFLICT(id) DO UPDATE SET
    owner = excluded.owner,
    storage_key = excluded.storage_key,
    title = excluded.title,
    original_filename = excluded.original_filename,
    mime = excluded.mime,
    bytes = excluded.bytes,
    sha256 = excluded.sha256,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    public = excluded.public,
    public_expires_at = excluded.public_expires_at,
    public_password_hash = excluded.public_password_hash,
    collection_id = excluded.collection_id,
    ingest_status = excluded.ingest_status,
    ingest_error = excluded.ingest_error,
    ingest_chunk_count = excluded.ingest_chunk_count,
    ingest_embed_dim = excluded.ingest_embed_dim,
    ingest_embedded = excluded.ingest_embedded,
    ingest_extracted_at = excluded.ingest_extracted_at,
    ingest_embedded_at = excluded.ingest_embedded_at,
    entities_json = excluded.entities_json,
    gps_lat = excluded.gps_lat,
    gps_lng = excluded.gps_lng,
    gps_tried = excluded.gps_tried,
    p_hash = excluded.p_hash,
    live_photo_pair = excluded.live_photo_pair,
    hls_ready = excluded.hls_ready
`

function metaToParams(m: DocumentMeta): Record<string, unknown> {
  // GPS tri-state: undefined→untried, null→tried-absent, obj→has.
  const gps_tried = m.gps === undefined ? 0 : 1
  const gps_lat = m.gps && typeof m.gps === 'object' ? m.gps.lat : null
  const gps_lng = m.gps && typeof m.gps === 'object' ? m.gps.lng : null
  // pHash: undefined→NULL, null→'', hex→hex.
  const p_hash = m.pHash === undefined ? null : m.pHash === null ? '' : m.pHash
  return {
    id: m.id,
    owner: m.owner,
    storage_key: m.storageKey,
    title: m.title,
    original_filename: m.originalFilename,
    mime: m.mime,
    bytes: m.bytes,
    sha256: m.sha256,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    public: m.public ? 1 : 0,
    public_expires_at: m.publicExpiresAt ?? null,
    public_password_hash: m.publicPasswordHash ?? null,
    collection_id: m.collectionId ?? null,
    ingest_status: m.ingest.status,
    ingest_error: m.ingest.error ?? null,
    ingest_chunk_count: m.ingest.chunkCount ?? null,
    ingest_embed_dim: m.ingest.embedDim ?? null,
    ingest_embedded: m.ingest.embedded ? 1 : 0,
    ingest_extracted_at: m.ingest.extractedAt ?? null,
    ingest_embedded_at: m.ingest.embeddedAt ?? null,
    entities_json: m.entities ? JSON.stringify(m.entities) : null,
    gps_lat,
    gps_lng,
    gps_tried,
    p_hash,
    live_photo_pair: m.livePhotoPair ?? null,
    hls_ready: m.hlsReady ? 1 : 0,
  }
}

/** Replace every join-table edge for a doc with the new set inside
 *  the active transaction. Cheap: doc_id is the PK lookup prefix. */
function replaceEdges(
  d: ReturnType<typeof db>,
  docId: string,
  tags: string[],
  readers: string[],
  editors: string[],
): void {
  d.prepare('DELETE FROM document_tags WHERE doc_id = ?').run(docId)
  const insTag = d.prepare('INSERT OR IGNORE INTO document_tags (doc_id, tag) VALUES (?, ?)')
  for (const t of tags) insTag.run(docId, t)

  d.prepare('DELETE FROM document_acl_readers WHERE doc_id = ?').run(docId)
  const insR = d.prepare('INSERT OR IGNORE INTO document_acl_readers (doc_id, username) VALUES (?, ?)')
  for (const u of readers) insR.run(docId, u)

  d.prepare('DELETE FROM document_acl_editors WHERE doc_id = ?').run(docId)
  const insE = d.prepare('INSERT OR IGNORE INTO document_acl_editors (doc_id, username) VALUES (?, ?)')
  for (const u of editors) insE.run(docId, u)
}

export function upsert(meta: DocumentMeta): void {
  const d = db()
  const tx = d.transaction(() => {
    d.prepare(UPSERT_SQL).run(metaToParams(meta) as never)
    replaceEdges(d, meta.id, meta.tags, meta.acl.readers, meta.acl.editors)
  })
  tx()
}

export function remove(id: string): void {
  // ON DELETE CASCADE on the join tables takes the edges with it.
  db().prepare('DELETE FROM documents WHERE id = ?').run(id)
}

function loadEdges(docIds: string[]): {
  tags: Map<string, string[]>
  readers: Map<string, string[]>
  editors: Map<string, string[]>
} {
  const tags = new Map<string, string[]>()
  const readers = new Map<string, string[]>()
  const editors = new Map<string, string[]>()
  if (docIds.length === 0) return { tags, readers, editors }
  // SQLite bound-parameter limit defaults to 32_766 — well above
  // realistic doc counts in one query. If we ever cross that we
  // chunk; for now a single IN() is simplest.
  const placeholders = docIds.map(() => '?').join(',')
  const d = db()
  const tagRows = d
    .prepare(`SELECT doc_id, tag FROM document_tags WHERE doc_id IN (${placeholders})`)
    .all(...docIds) as Array<{ doc_id: string; tag: string }>
  for (const r of tagRows) {
    const arr = tags.get(r.doc_id) ?? []
    arr.push(r.tag)
    tags.set(r.doc_id, arr)
  }
  const rRows = d
    .prepare(`SELECT doc_id, username FROM document_acl_readers WHERE doc_id IN (${placeholders})`)
    .all(...docIds) as Array<{ doc_id: string; username: string }>
  for (const r of rRows) {
    const arr = readers.get(r.doc_id) ?? []
    arr.push(r.username)
    readers.set(r.doc_id, arr)
  }
  const eRows = d
    .prepare(`SELECT doc_id, username FROM document_acl_editors WHERE doc_id IN (${placeholders})`)
    .all(...docIds) as Array<{ doc_id: string; username: string }>
  for (const r of eRows) {
    const arr = editors.get(r.doc_id) ?? []
    arr.push(r.username)
    editors.set(r.doc_id, arr)
  }
  return { tags, readers, editors }
}

export function load(id: string): DocumentMeta | null {
  const row = db().prepare('SELECT * FROM documents WHERE id = ?').get(id) as
    | DocRow
    | undefined
  if (!row) return null
  const { tags, readers, editors } = loadEdges([id])
  return rowToMeta(row, tags.get(id) ?? [], readers.get(id) ?? [], editors.get(id) ?? [])
}

export function listAll(): DocumentMeta[] {
  const rows = db()
    .prepare('SELECT * FROM documents ORDER BY created_at DESC')
    .all() as DocRow[]
  const ids = rows.map((r) => r.id)
  const { tags, readers, editors } = loadEdges(ids)
  return rows.map((r) =>
    rowToMeta(r, tags.get(r.id) ?? [], readers.get(r.id) ?? [], editors.get(r.id) ?? []),
  )
}

export function count(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n
}

export function byStorageKey(owner: string, storageKey: string): DocumentMeta | null {
  const row = db()
    .prepare('SELECT * FROM documents WHERE owner = ? AND storage_key = ? LIMIT 1')
    .get(owner, storageKey) as DocRow | undefined
  if (!row) return null
  const { tags, readers, editors } = loadEdges([row.id])
  return rowToMeta(
    row,
    tags.get(row.id) ?? [],
    readers.get(row.id) ?? [],
    editors.get(row.id) ?? [],
  )
}
