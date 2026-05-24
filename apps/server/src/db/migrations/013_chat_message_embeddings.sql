-- Per-chat-message semantic memory. We embed user + assistant turns
-- as they're persisted, then on each new query we similarity-search
-- past messages in the SAME thread that fell outside the recent
-- token-budget window. Top hits get injected as a "Possibly
-- relevant earlier turns" system note so the model can reference
-- something the user mentioned 30 turns ago without us re-sending
-- the entire transcript.
--
-- Storage mirrors chunks.embedding: little-endian Float32 blob,
-- separate column for the dimension so a future model swap doesn't
-- silently mix vectors of different sizes.
--
-- Existing rows stay NULL; only messages persisted after the embed
-- pipeline ships get a vector. The dispatcher tolerates NULL by
-- skipping those rows from similarity scan and falling back to the
-- existing extractive summary for context continuity.

ALTER TABLE chat_messages ADD COLUMN embedding BLOB;
ALTER TABLE chat_messages ADD COLUMN embed_dim INTEGER;
