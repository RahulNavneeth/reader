-- Multi-thread chat. Each (doc, user) can have many named
-- conversations now. chat_threads carries the metadata
-- (title, timestamps); chat_messages.thread_id binds messages
-- to their owning thread.
--
-- Existing data is backfilled into a single "Conversation" thread
-- per (doc_id, user_id) so the upgrade is invisible — the user
-- opens their chat and sees the same history under a thread named
-- "Conversation" they can rename or supersede with a new chat.

CREATE TABLE chat_threads (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_threads_doc_user_recent
  ON chat_threads(doc_id, user_id, updated_at DESC);

ALTER TABLE chat_messages ADD COLUMN thread_id TEXT;
CREATE INDEX idx_chat_messages_thread_time
  ON chat_messages(thread_id, created_at);

-- Backfill: one legacy thread per (doc_id, user_id) holding the
-- existing messages. The deterministic "legacy-<doc>-<user>" id is
-- unique because each (doc, user) only ever had one implicit thread.
INSERT INTO chat_threads (id, doc_id, user_id, title, created_at, updated_at)
SELECT
  'legacy-' || doc_id || '-' || user_id AS id,
  doc_id,
  user_id,
  'Conversation' AS title,
  MIN(created_at) AS created_at,
  MAX(created_at) AS updated_at
FROM chat_messages
WHERE thread_id IS NULL
GROUP BY doc_id, user_id;

UPDATE chat_messages
SET thread_id = 'legacy-' || doc_id || '-' || user_id
WHERE thread_id IS NULL;
