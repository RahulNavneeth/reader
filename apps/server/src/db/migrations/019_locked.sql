-- Owner-controlled write freeze. When `locked = 1`, every mutation
-- on the doc (CRDT autosave, MCP edit, /api/file/upload overwrite,
-- chat apply-edit, delete, move, etc.) returns 423 Locked unless the
-- actor is the owner or an admin. Distinct from `archived` (which
-- only hides from default listings — still editable).
--
-- locked: 0/1 (default 0).
-- locked_at: timestamp the flag flipped to 1, null when unlocked.
-- locked_by: username that locked the doc. Surfaced in the UI banner
--   so share-recipients know who to ask for an unlock.
ALTER TABLE documents ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN locked_at INTEGER;
ALTER TABLE documents ADD COLUMN locked_by TEXT;

-- Partial index on locked docs so "is this doc locked" lookups stay
-- cheap and the rare "list all my locked docs" view is indexed.
CREATE INDEX IF NOT EXISTS idx_documents_locked
  ON documents (locked_at DESC)
  WHERE locked = 1;
