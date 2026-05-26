-- Foundation for offline sync + multi-device CRDT.
--
-- Two storage shapes, deliberately split:
--
--   sync_changes
--     Append-only mutation log. Each row is one logical mutation
--     ("upserted doc X", "tagged Y", "archived Z"). Clients pull
--     with `?since=<lsn>` to incrementally hydrate their local
--     state; clients push with their own UUID so retries are
--     idempotent. Used by Phase 1 (LWW writes, conflict files)
--     and stays useful in Phase 4 (metadata changes still flow
--     through here even when bodies are CRDT-driven).
--
--   documents.crdt_state
--     Per-document Yjs binary state. Populated lazily on first
--     edit through the WebSocket transport. Phase 2+ uses this as
--     the canonical body source for markdown docs; non-markdown
--     wraps the bytes in a Y.Doc with metadata fields that the
--     awareness protocol can broadcast (per-doc presence, tag
--     change notifications, etc).

CREATE TABLE IF NOT EXISTS sync_changes (
  -- Monotonic per-row sequence; clients track their last seen
  -- value and resume from it. Using `INTEGER PRIMARY KEY` rather
  -- than `AUTOINCREMENT` so rowid reuse is impossible (sqlite
  -- guarantees strict monotonicity for this exact column type).
  lsn INTEGER PRIMARY KEY,
  -- The user whose vault the change applies to. Used both for ACL
  -- on pull and for scoping a sync session (each user gets their
  -- own resumable cursor).
  owner TEXT NOT NULL,
  -- What kind of entity changed. Keeping this open as a string
  -- (rather than an enum) so future entity types (folders,
  -- collections, threads, pins) don't need a migration.
  entity_type TEXT NOT NULL,
  -- Vault-relative path for files/folders; entity id for things
  -- with no on-disk representation (threads, pins). Always the
  -- *stable* identifier so reconciliation works across renames
  -- via the change log's rename event.
  entity_id TEXT NOT NULL,
  -- Mutation verb: 'upsert', 'delete', 'rename', 'move',
  -- 'restore'. Same open-string design as entity_type.
  kind TEXT NOT NULL,
  -- Full mutation payload, json-encoded. Clients re-apply by
  -- decoding + replaying. For 'upsert' on a doc body the payload
  -- carries the new sha256 + a content patch (or full body for
  -- short docs); for 'tags' it carries the new tag array; etc.
  payload TEXT NOT NULL,
  -- Who fired the change. 'system' for watcher / migration paths.
  actor TEXT NOT NULL,
  -- Wallclock at the server. Distinct from `lsn` (which is a
  -- sequence number) — `ts` is human-meaningful for audit and
  -- conflict UX ("you edited at 14:32, server saw 14:33").
  ts INTEGER NOT NULL,
  -- Optional client-supplied UUID used for idempotency on push.
  -- If a client retries a push with the same `client_op_id`, the
  -- server's UNIQUE constraint short-circuits the second write
  -- and returns the original lsn.
  client_op_id TEXT
);

-- Pull endpoint is keyed on (owner, lsn) — most queries shape:
--   SELECT * FROM sync_changes WHERE owner = ? AND lsn > ? ORDER BY lsn ASC
-- A covering index on (owner, lsn) makes that an index-only scan.
CREATE INDEX IF NOT EXISTS idx_sync_changes_owner_lsn
  ON sync_changes (owner, lsn);

-- Idempotency guard for client push retries. Only one row may
-- exist for any given (owner, client_op_id) pair; NULL ids are
-- ignored by the partial index so server-generated entries don't
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_changes_client_op
  ON sync_changes (owner, client_op_id)
  WHERE client_op_id IS NOT NULL;

-- Per-document Yjs state. NULL means "no CRDT updates yet" — the
-- file's on-disk bytes are still authoritative until a client
-- attaches to the WebSocket and seeds the Y.Doc.
ALTER TABLE documents ADD COLUMN crdt_state BLOB;

-- Vector clock / state vector for the doc — small (typically
-- 8-40 bytes), pulled on every websocket attach so the server can
-- compute the diff to send. Sentinel for "fully replicated"
-- when null + state null. Kept separate from crdt_state so the
-- common "have you got my update yet?" probe doesn't have to
-- decode the full state.
ALTER TABLE documents ADD COLUMN crdt_state_vector BLOB;

-- Bookkeeping: when the doc was last materialised back to disk.
-- The materialisation loop debounces 2s after the Y.Doc settles,
-- so this lags the last edit slightly. Used to detect divergence
-- (disk_mtime > crdt_materialised_at means an external editor
-- wrote — schedule a foreign-update import).
ALTER TABLE documents ADD COLUMN crdt_materialised_at INTEGER;
