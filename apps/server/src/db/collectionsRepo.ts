/**
 * Collections repository — SQL-backed CRUD for the three tables
 * defined in `migrations/002_collections.sql`.
 *
 * Authorization is intentionally NOT enforced here. Routes layer
 * that on top; the repo is a thin data-access layer. That keeps it
 * usable from background jobs (cleanup sweeps, MCP tools) without
 * having to fabricate a user identity.
 */
import { db } from './sqlite.js'

export type Collection = {
  id: string
  owner: string
  name: string
  description: string | null
  coverDocId: string | null
  createdAt: number
  updatedAt: number
}

export type CollectionMember = {
  collectionId: string
  docId: string
  addedAt: number
  position: number | null
}

export type CollectionShare = {
  collectionId: string
  recipient: string
  canEdit: boolean
  createdAt: number
}

type CollectionRow = {
  id: string
  owner: string
  name: string
  description: string | null
  cover_doc_id: string | null
  created_at: number
  updated_at: number
}

function rowToCollection(r: CollectionRow): Collection {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    description: r.description,
    coverDocId: r.cover_doc_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function create(opts: {
  id: string
  owner: string
  name: string
  description?: string | null
}): Collection {
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO collections (id, owner, name, description, cover_doc_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(opts.id, opts.owner, opts.name, opts.description ?? null, now, now)
  return load(opts.id)!
}

export function update(
  id: string,
  patch: { name?: string; description?: string | null; coverDocId?: string | null },
): Collection | null {
  const cur = load(id)
  if (!cur) return null
  const next: Collection = {
    ...cur,
    name: patch.name ?? cur.name,
    description: patch.description === undefined ? cur.description : patch.description,
    coverDocId: patch.coverDocId === undefined ? cur.coverDocId : patch.coverDocId,
    updatedAt: Date.now(),
  }
  db()
    .prepare(
      `UPDATE collections
         SET name = ?, description = ?, cover_doc_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(next.name, next.description, next.coverDocId, next.updatedAt, id)
  return next
}

export function remove(id: string): void {
  // ON DELETE CASCADE drops members + shares with the collection.
  db().prepare('DELETE FROM collections WHERE id = ?').run(id)
}

export function load(id: string): Collection | null {
  const row = db().prepare('SELECT * FROM collections WHERE id = ?').get(id) as
    | CollectionRow
    | undefined
  return row ? rowToCollection(row) : null
}

export function listByOwner(owner: string): Collection[] {
  const rows = db()
    .prepare('SELECT * FROM collections WHERE owner = ? ORDER BY updated_at DESC')
    .all(owner) as CollectionRow[]
  return rows.map(rowToCollection)
}

/** Collections shared TO the given user, including the share's
 *  canEdit flag so the caller can hand the recipient a read-only
 *  view vs. a fully-editable one. */
export function listSharedTo(
  recipient: string,
): Array<Collection & { canEdit: boolean }> {
  const rows = db()
    .prepare(
      `SELECT c.*, s.can_edit AS share_can_edit
         FROM collections c
         JOIN collection_shares s ON s.collection_id = c.id
        WHERE s.recipient = ?
        ORDER BY c.updated_at DESC`,
    )
    .all(recipient) as Array<CollectionRow & { share_can_edit: number }>
  return rows.map((r) => ({ ...rowToCollection(r), canEdit: r.share_can_edit === 1 }))
}

// ---------------- members ----------------

export function addMember(collectionId: string, docId: string): void {
  // INSERT OR IGNORE so adding an already-present doc is a no-op
  // (idempotent — bulk "add 50 docs" doesn't error on the ones that
  // are already there).
  db()
    .prepare(
      `INSERT OR IGNORE INTO collection_members (collection_id, doc_id, added_at, position)
       VALUES (?, ?, ?, NULL)`,
    )
    .run(collectionId, docId, Date.now())
  // Bump updated_at on the parent so the sidebar list re-sorts.
  db()
    .prepare('UPDATE collections SET updated_at = ? WHERE id = ?')
    .run(Date.now(), collectionId)
}

export function removeMember(collectionId: string, docId: string): void {
  db()
    .prepare('DELETE FROM collection_members WHERE collection_id = ? AND doc_id = ?')
    .run(collectionId, docId)
  db()
    .prepare('UPDATE collections SET updated_at = ? WHERE id = ?')
    .run(Date.now(), collectionId)
}

export function listMembers(collectionId: string): CollectionMember[] {
  const rows = db()
    .prepare(
      `SELECT collection_id, doc_id, added_at, position
         FROM collection_members
        WHERE collection_id = ?
        -- Manual positions first (lowest position number wins),
        -- then chronological among the rest. NULLs LAST works
        -- because SQLite's default-asc sorts NULLs last.
        ORDER BY position ASC, added_at DESC`,
    )
    .all(collectionId) as Array<{
    collection_id: string
    doc_id: string
    added_at: number
    position: number | null
  }>
  return rows.map((r) => ({
    collectionId: r.collection_id,
    docId: r.doc_id,
    addedAt: r.added_at,
    position: r.position,
  }))
}

export function memberCount(collectionId: string): number {
  return (
    db()
      .prepare('SELECT COUNT(*) AS n FROM collection_members WHERE collection_id = ?')
      .get(collectionId) as { n: number }
  ).n
}

/** Which collections (owned by `viewer`) the given doc currently sits
 *  inside. Used by the file's "Add to collection" picker to render
 *  the checked state. */
export function collectionsContainingDoc(
  docId: string,
  viewer: string,
): Collection[] {
  const rows = db()
    .prepare(
      `SELECT c.*
         FROM collections c
         JOIN collection_members m ON m.collection_id = c.id
        WHERE m.doc_id = ? AND c.owner = ?`,
    )
    .all(docId, viewer) as CollectionRow[]
  return rows.map(rowToCollection)
}

// ---------------- shares ----------------

export function share(opts: {
  collectionId: string
  recipient: string
  canEdit: boolean
}): CollectionShare {
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO collection_shares (collection_id, recipient, can_edit, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(collection_id, recipient) DO UPDATE SET can_edit = excluded.can_edit`,
    )
    .run(opts.collectionId, opts.recipient, opts.canEdit ? 1 : 0, now)
  return {
    collectionId: opts.collectionId,
    recipient: opts.recipient,
    canEdit: opts.canEdit,
    createdAt: now,
  }
}

export function unshare(collectionId: string, recipient: string): void {
  db()
    .prepare(
      'DELETE FROM collection_shares WHERE collection_id = ? AND recipient = ?',
    )
    .run(collectionId, recipient)
}

export function listShares(collectionId: string): CollectionShare[] {
  const rows = db()
    .prepare(
      `SELECT collection_id, recipient, can_edit, created_at
         FROM collection_shares
        WHERE collection_id = ?
        ORDER BY created_at DESC`,
    )
    .all(collectionId) as Array<{
    collection_id: string
    recipient: string
    can_edit: number
    created_at: number
  }>
  return rows.map((r) => ({
    collectionId: r.collection_id,
    recipient: r.recipient,
    canEdit: r.can_edit === 1,
    createdAt: r.created_at,
  }))
}

/** Permission helper for the route layer. */
export function userCanEdit(c: Collection, username: string, role: string): boolean {
  if (role === 'admin') return true
  if (c.owner === username) return true
  const row = db()
    .prepare(
      'SELECT can_edit FROM collection_shares WHERE collection_id = ? AND recipient = ?',
    )
    .get(c.id, username) as { can_edit: number } | undefined
  return row?.can_edit === 1
}

export function userCanView(c: Collection, username: string, role: string): boolean {
  if (role === 'admin') return true
  if (c.owner === username) return true
  const row = db()
    .prepare(
      'SELECT 1 FROM collection_shares WHERE collection_id = ? AND recipient = ?',
    )
    .get(c.id, username) as { 1: number } | undefined
  return !!row
}
