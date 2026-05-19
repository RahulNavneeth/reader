-- Collections — flat, virtual groupings of documents that can include
-- the same doc in many collections without copying or moving it.
-- Folders remain the physical hierarchy on disk; collections are
-- purely a database concept ("curated set").
--
-- Three tables:
--   collections          — the collection itself + owner + metadata
--   collection_members   — many-to-many (collection ↔ document)
--   collection_shares    — recipients who can view (+ optionally edit)
--                          the collection. Does NOT cascade read
--                          access to member docs in this first cut;
--                          per-doc ACL still gates /api/file/* reads.

CREATE TABLE collections (
  id             TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  -- Explicit cover doc. NULL falls back to the first member (by
  -- position then added_at) on the client side.
  cover_doc_id   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_collections_owner ON collections(owner);

CREATE TABLE collection_members (
  collection_id  TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  added_at       INTEGER NOT NULL,
  -- Optional manual ordering. NULL = "sort by added_at DESC" (the
  -- default chronological newest-first), positive integer = pinned
  -- to this slot. Lets the user re-order without rewriting every row.
  position       INTEGER,
  PRIMARY KEY (collection_id, doc_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
-- Reverse-lookup: given a doc, which collections is it in.
CREATE INDEX idx_collection_members_doc ON collection_members(doc_id);

CREATE TABLE collection_shares (
  collection_id  TEXT NOT NULL,
  recipient      TEXT NOT NULL,
  -- can_edit = 1 lets the recipient add/remove members + rename.
  -- They still can't share to others or delete the collection.
  can_edit       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (collection_id, recipient),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);
-- "What collections are shared TO this user" — drives the sidebar.
CREATE INDEX idx_collection_shares_recipient ON collection_shares(recipient);
