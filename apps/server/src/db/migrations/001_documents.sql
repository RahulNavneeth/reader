-- Document index moves from JSON-on-disk meta.json files into SQLite
-- so listAllDocuments() stops loading the entire corpus into memory.
-- The per-doc storage directory (text.txt, chunks.jsonl, thumb, preview,
-- hls/, clip.json) stays on disk — only the index moves to SQL.

CREATE TABLE documents (
  id                    TEXT PRIMARY KEY,
  owner                 TEXT NOT NULL,
  storage_key           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  original_filename     TEXT NOT NULL,
  mime                  TEXT NOT NULL,
  bytes                 INTEGER NOT NULL,
  sha256                TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,

  -- Public-link state.
  public                INTEGER NOT NULL DEFAULT 0,
  public_expires_at     INTEGER,
  public_password_hash  TEXT,

  -- Vestigial single-collection pointer kept for compatibility with
  -- the existing JSON shape; the upcoming many-to-many Collections
  -- feature lives in a separate join table and ignores this column.
  collection_id         TEXT,

  -- Ingest state — flattened from meta.ingest.* in the JSON shape.
  ingest_status         TEXT NOT NULL DEFAULT 'pending',
  ingest_error          TEXT,
  ingest_chunk_count    INTEGER,
  ingest_embed_dim      INTEGER,
  ingest_embedded       INTEGER NOT NULL DEFAULT 0,
  ingest_extracted_at   INTEGER,
  ingest_embedded_at    INTEGER,

  -- Optional regex-extracted entities. Serialized JSON of the shape
  -- {dates, amounts, emails, urls, orgs}. NULL when ingest hasn't
  -- run yet; a JSON object otherwise.
  entities_json         TEXT,

  -- GPS — tri-state to match the existing JSON convention:
  --   gps_tried=0              → untried (undefined in JSON)
  --   gps_tried=1, lat IS NULL → tried + absent (null in JSON)
  --   gps_tried=1, lat/lng set → has coordinates
  gps_lat               REAL,
  gps_lng               REAL,
  gps_tried             INTEGER NOT NULL DEFAULT 0,

  -- Perceptual dHash for near-duplicate detection. NULL = untried,
  -- '' (empty) = tried and failed, hex = ok.
  p_hash                TEXT,

  -- Live Photo pair — the vault-relative path of the matched
  -- HEIC/MOV sibling. Set on both halves when a pair is detected.
  live_photo_pair       TEXT,

  -- Set to 1 once ffmpeg has produced an HLS bundle on disk.
  hls_ready             INTEGER NOT NULL DEFAULT 0
);

-- Owner+createdAt covers the most common queries: "list this user's
-- docs newest-first" (timeline, sidebar feed, account/timeline).
CREATE INDEX idx_documents_owner_created ON documents(owner, created_at DESC);

-- storageKey lookup powers /api/file/* path-based resolution.
CREATE INDEX idx_documents_owner_storage_key ON documents(owner, storage_key);
CREATE INDEX idx_documents_storage_key ON documents(storage_key);

-- sha256 group-bys feed the admin Duplicates panel.
CREATE INDEX idx_documents_sha256 ON documents(sha256);

-- Tags as a join table so tag-filter queries are an indexed lookup
-- rather than a full-corpus scan of the JSON array field.
CREATE TABLE document_tags (
  doc_id  TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (doc_id, tag),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_tags_tag ON document_tags(tag);

-- Reader/editor ACLs. '*' in the username column is the legacy
-- "any authenticated user" wildcard — handled in code rather than
-- expanded into N rows.
CREATE TABLE document_acl_readers (
  doc_id    TEXT NOT NULL,
  username  TEXT NOT NULL,
  PRIMARY KEY (doc_id, username),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_acl_readers_user ON document_acl_readers(username);

CREATE TABLE document_acl_editors (
  doc_id    TEXT NOT NULL,
  username  TEXT NOT NULL,
  PRIMARY KEY (doc_id, username),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_acl_editors_user ON document_acl_editors(username);
