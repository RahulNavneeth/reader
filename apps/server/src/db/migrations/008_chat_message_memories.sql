-- Persist which memories were surfaced when an assistant turn was
-- generated, so the UI can show "Used memory: …" footers even on
-- turns loaded from history.
--
-- JSON blob: an array of { kind: 'user'|'doc'|'mistake', id, preview }
-- describing what landed in the prompt. NULL for user turns + for
-- assistant turns generated before this column existed.
ALTER TABLE chat_messages ADD COLUMN memories_used TEXT;
