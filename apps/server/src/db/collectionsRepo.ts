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

/**
 * Smart-collection rule. NULL on a static collection (membership
 * lives in `collection_members`); non-NULL turns the collection
 * into a saved search that resolves at view time from the docs
 * table. All fields are optional + ANDed together — a collection
 * matching every doc is `{}`, a collection matching docs tagged
 * "finance" inside the `invoices/` folder is
 * `{tags: ['finance'], pathPrefix: 'invoices/'}`.
 */
export type SmartCollectionQuery = {
  /** Doc must have at least one of these tags (any-of). Empty
   *  array or missing key skips the tag filter. */
  tags?: string[]
  /** Doc storage key startsWith this prefix. Trailing slash
   *  recommended for folder-shaped prefixes. */
  pathPrefix?: string
  /** Filter by content kind. `markdown` covers `.md` / `.markdown`
   *  / `.mdx`. Skip the field for "any kind". */
  mimeKind?: 'image' | 'video' | 'file' | 'markdown'
  /** Inclusive lower bound on `createdAt`, unix-ms. */
  dateFromTs?: number | null
  /** Inclusive upper bound on `createdAt`, unix-ms. */
  dateToTs?: number | null
  /** When true → include archived docs; false → only non-archived;
   *  omitted → match the rest of the app (hide archived). */
  archived?: boolean
  /** Natural-language semantic query. Resolved via the same
   *  Ollama-backed `searchKnowledge` the search bar uses — picks
   *  docs whose chunk text is semantically similar to the prompt.
   *  Layered as an intersection over the structural filters
   *  above. Empty / missing skips this dimension. */
  semanticQuery?: string
  /** Maximum docs returned when `semanticQuery` is set. Defaults
   *  to 50 so the page stays bounded for browsing. */
  semanticLimit?: number
}

export type Collection = {
  id: string
  owner: string
  name: string
  description: string | null
  coverDocId: string | null
  createdAt: number
  updatedAt: number
  public: boolean
  publicExpiresAt: number | null
  publicPasswordHash: string | null
  publicSlug: string | null
  /** When set, this collection is "smart" — its membership is
   *  computed live from this query rather than pulled from
   *  `collection_members`. */
  query: SmartCollectionQuery | null
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
  public: number
  public_expires_at: number | null
  public_password_hash: string | null
  public_slug: string | null
  query: string | null
}

function rowToCollection(r: CollectionRow): Collection {
  let query: SmartCollectionQuery | null = null
  if (r.query) {
    try {
      query = JSON.parse(r.query) as SmartCollectionQuery
    } catch {
      // Malformed JSON in the column should never happen via our
      // write path, but if it does, treat the collection as
      // static and surface it normally rather than 500-ing every
      // request that touches it.
      query = null
    }
  }
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    description: r.description,
    coverDocId: r.cover_doc_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    public: r.public === 1,
    publicExpiresAt: r.public_expires_at,
    publicPasswordHash: r.public_password_hash,
    publicSlug: r.public_slug,
    query,
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
  patch: {
    name?: string
    description?: string | null
    coverDocId?: string | null
    /** `undefined` leaves the query untouched; `null` clears it
     *  (collection becomes static again); an object value
     *  switches the collection into smart mode with that rule. */
    query?: SmartCollectionQuery | null
  },
): Collection | null {
  const cur = load(id)
  if (!cur) return null
  const next: Collection = {
    ...cur,
    name: patch.name ?? cur.name,
    description: patch.description === undefined ? cur.description : patch.description,
    coverDocId: patch.coverDocId === undefined ? cur.coverDocId : patch.coverDocId,
    query: patch.query === undefined ? cur.query : patch.query,
    updatedAt: Date.now(),
  }
  db()
    .prepare(
      `UPDATE collections
         SET name = ?, description = ?, cover_doc_id = ?, query = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.name,
      next.description,
      next.coverDocId,
      next.query ? JSON.stringify(next.query) : null,
      next.updatedAt,
      id,
    )
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

// ---------------- share-cascade grants ----------------

/**
 * Bundle of doc-level read/edit access the user gets indirectly via
 * any collection that's shared with them. Pre-fetched once per
 * request and consulted by the per-doc read gates so a single
 * collection share cascades to every member doc without forcing
 * the owner to also doc-share each one.
 *
 * One row per doc-id: the MAX(can_edit) collapses multiple shares
 * of the same doc into "best access wins" — if you have a read-only
 * share on one collection and an edit share on another that both
 * contain the same doc, you get edit.
 *
 * Cost: one indexed SELECT per request. With ~10 shares × ~100
 * members each, that's 1k rows max — well within "free" territory.
 */
export type CollectionGrants = {
  readableDocs: Set<string>
  editableDocs: Set<string>
}

export function grantsForUser(username: string): CollectionGrants {
  const rows = db()
    .prepare(
      `SELECT m.doc_id AS doc_id, MAX(s.can_edit) AS can_edit
         FROM collection_members m
         JOIN collection_shares s ON s.collection_id = m.collection_id
        WHERE s.recipient = ?
        GROUP BY m.doc_id`,
    )
    .all(username) as Array<{ doc_id: string; can_edit: number }>
  const readableDocs = new Set<string>()
  const editableDocs = new Set<string>()
  for (const r of rows) {
    readableDocs.add(r.doc_id)
    if (r.can_edit === 1) editableDocs.add(r.doc_id)
  }
  return { readableDocs, editableDocs }
}

/** Identity grants — used by the route layer when there is no
 *  authenticated user (anonymous public-collection access). */
export function emptyGrants(): CollectionGrants {
  return { readableDocs: new Set(), editableDocs: new Set() }
}

// ---------------- public-link helpers ----------------

/**
 * Set/unset a collection's public-link state. Caller is responsible
 * for hashing the password (the route layer uses the same scrypt
 * helper as document public passwords) and minting the slug.
 */
export function setPublic(
  id: string,
  opts: {
    isPublic: boolean
    expiresAt?: number | null
    passwordHash?: string | null
    slug?: string | null
  },
): Collection | null {
  const c = load(id)
  if (!c) return null
  db()
    .prepare(
      `UPDATE collections
         SET public = ?, public_expires_at = ?, public_password_hash = ?,
             public_slug = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      opts.isPublic ? 1 : 0,
      opts.isPublic ? (opts.expiresAt ?? null) : null,
      opts.isPublic ? (opts.passwordHash ?? null) : null,
      opts.isPublic ? (opts.slug ?? null) : null,
      Date.now(),
      id,
    )
  return load(id)
}

export function bySlug(slug: string): Collection | null {
  const row = db()
    .prepare('SELECT * FROM collections WHERE public_slug = ? AND public = 1')
    .get(slug) as CollectionRow | undefined
  return row ? rowToCollection(row) : null
}

/** Tri-state public-gate check. Mirrors the file-level publicGate
 *  helper in routes/vault.ts so anonymous viewers go through the
 *  same expiry + password ceremony. */
export function publicGate(
  c: Collection,
  providedPassword: string | undefined,
  verify: (hash: string, pwd: string) => Promise<boolean> | boolean,
): Promise<'ok' | 'password-required' | 'password-wrong' | 'expired' | 'not-public'> {
  return (async () => {
    if (!c.public) return 'not-public'
    if (c.publicExpiresAt && c.publicExpiresAt < Date.now()) return 'expired'
    if (c.publicPasswordHash) {
      if (!providedPassword) return 'password-required'
      const ok = await Promise.resolve(verify(c.publicPasswordHash, providedPassword))
      return ok ? 'ok' : 'password-wrong'
    }
    return 'ok'
  })()
}
