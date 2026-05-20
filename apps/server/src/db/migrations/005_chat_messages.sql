-- Per-document chat history. Each conversation is scoped to
-- (doc_id, user_id) — a doc can hold one running thread per user.
-- Refreshing the page resumes the same thread; "clear" wipes it.
--
-- Why not a separate `chat_threads` table: a single thread per
-- (doc, user) keeps the UI simple and matches the "ask this
-- document" mental model. If we later want named threads, add a
-- `thread_id` column with a default-thread row per (doc, user).
--
-- Cascade on doc delete so chat history doesn't outlive its anchor.

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  -- JSON array of { docId, chunkIdx, score } from the RAG retrieval
  -- step. Stored on assistant turns so the UI can show which chunks
  -- the model saw. NULL for user turns.
  citations   TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_doc_user_time ON chat_messages(doc_id, user_id, created_at);
