-- Reader AI memory system — three tables that give the chat
-- assistant the closest thing to durable memory across sessions.
--
-- Scopes intentionally separate so a per-doc fact (e.g. "PPFCF =
-- Parag Parikh Flexi Cap Fund") doesn't pollute every other doc's
-- chat, while a permanent user-level fact (e.g. "always use ₹ for
-- currency") applies everywhere.
--
-- v1 design doc: docs/design/reader-ai-memory.md

-- ── User-level memories ─────────────────────────────────────────
-- Apply to every chat for this user, across all docs. Surfaced in
-- the system prompt as <permanent_facts>, capped at the top-20
-- ordered by used_count DESC, created_at DESC.
CREATE TABLE user_memories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  fact        TEXT NOT NULL,
  -- 'user_command' = added via /remember or the memories panel.
  -- 'auto_extracted' = reserved for v2 (model proposes "should I
  -- remember X?" after a correction; user approves).
  source      TEXT NOT NULL DEFAULT 'user_command',
  -- Incremented each time this memory is surfaced in a prompt.
  -- Drives the popularity sort that decides which memories make
  -- the per-prompt cap.
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_user_memories_user ON user_memories(user_id, used_count DESC, created_at DESC);

-- ── Doc-level memories ──────────────────────────────────────────
-- Scoped to (doc_id, user_id) — Alice's facts about projection.md
-- don't appear when Bob chats with projection.md, even if Bob has
-- read access. Cascades on doc delete so memories don't outlive
-- their anchor.
CREATE TABLE doc_memories (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  fact        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_doc_memories_doc_user ON doc_memories(doc_id, user_id, created_at DESC);

-- ── Failure log ─────────────────────────────────────────────────
-- Captured when the user thumbs-down an assistant turn and supplies
-- a correction. Surfaced in future prompts as <known_mistakes>
-- when retrieval finds a similar prior question (Phase B will add
-- the retrieval; for now this table just stores the rows).
--
-- doc_id is optional: a failure note can be doc-scoped (when the
-- user corrected an answer in a specific doc's chat) or global
-- (general feedback about Reader AI's behaviour). Cascades only
-- when doc_id is non-null AND its doc is deleted.
CREATE TABLE chat_error_notes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  doc_id       TEXT,
  question     TEXT NOT NULL,
  wrong_answer TEXT,
  correction   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE SET NULL
);
CREATE INDEX idx_chat_error_notes_user_recent ON chat_error_notes(user_id, created_at DESC);
CREATE INDEX idx_chat_error_notes_doc ON chat_error_notes(doc_id) WHERE doc_id IS NOT NULL;
