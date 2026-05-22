-- Memory relevance retrieval. Each memory now carries:
--   • embedding — the fact's vector via the same model used for
--     chunks. NULL until backfilled on next boot.
--   • always_inject — when 1, the memory bypasses the cosine
--     threshold at retrieval. Used for implicit preferences
--     ("answer in INR", "be terse") that don't share tokens with
--     most queries but should still apply.
--
-- Why this exists:
--   Before: every memory was injected into every chat turn (sorted
--   by popularity, capped at N). That ate prompt budget on
--   irrelevant memories and made the "Used memory" footer appear
--   on every answer.
--   Now:    memories are cosine-ranked against the query at
--   retrieval; only ones above the threshold (or flagged
--   always_inject) make it into the prompt.

ALTER TABLE user_memories ADD COLUMN embedding BLOB;
ALTER TABLE user_memories ADD COLUMN always_inject INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_user_memories_user_always
  ON user_memories(user_id, always_inject);

ALTER TABLE doc_memories ADD COLUMN embedding BLOB;
ALTER TABLE doc_memories ADD COLUMN always_inject INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_doc_memories_doc_user_always
  ON doc_memories(doc_id, user_id, always_inject);
