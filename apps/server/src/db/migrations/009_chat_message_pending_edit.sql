-- In-chat document editing — pending edit payloads.
--
-- An assistant turn can carry one or more proposed edits the
-- model emitted as <proposed_edit> blocks. These DON'T mutate
-- the doc on their own; they're persisted as data so the UI
-- can render a diff card with Apply / Discard buttons. The
-- server only writes to disk when the user explicitly applies.
--
-- pending_edit: JSON array of { op, heading?, content }. NULL
--   when the turn has no proposed edits (most turns). Cleared
--   on Discard; preserved on Apply (so history can show what
--   was applied) alongside edit_applied_at.
-- edit_applied_at: epoch ms of the Apply click. NULL while
--   pending; non-null after Apply. Used to render
--   "Applied 2 hrs ago" vs "Apply / Discard" buttons, and to
--   short-circuit double-apply.
-- edit_target_sha256: sha256 of the doc at the time the model
--   proposed the edit. On Apply, server compares to current
--   doc sha256. Mismatch → refuse with a conflict UI prompt
--   so a stale model output can't silently overwrite a recent
--   manual edit.
ALTER TABLE chat_messages ADD COLUMN pending_edit TEXT;
ALTER TABLE chat_messages ADD COLUMN edit_applied_at INTEGER;
ALTER TABLE chat_messages ADD COLUMN edit_target_sha256 TEXT;
