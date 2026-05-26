-- Archive: hide docs from default listings/search without deleting.
-- Distinct from Trash (no auto-purge after 30 days), distinct from
-- public/private (doesn't change ACL), distinct from delete (the
-- file stays on disk + still searchable when opted in). For old
-- projects, tax records, historical content the owner wants out of
-- daily flow.
--
-- archived: 0/1 (default 0). Filtered out of MCP list_documents and
-- /api/search by default; surfaced via `includeArchived` / `archived=true`
-- query args.
-- archived_at: timestamp the flag flipped to 1, null otherwise. Used
-- by the future Archive view to sort by archive date.
ALTER TABLE documents ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN archived_at INTEGER;

-- Partial index so the "list archived docs" path stays cheap as the
-- corpus grows. Most queries hit the default (archived=0) path so we
-- index only the rare side.
CREATE INDEX IF NOT EXISTS idx_documents_archived
  ON documents (archived_at DESC)
  WHERE archived = 1;
