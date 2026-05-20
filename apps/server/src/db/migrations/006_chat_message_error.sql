-- Persist chat failures alongside the user turn so reloading the
-- page doesn't make a 404'd assistant reply silently disappear.
-- Before this column, a failed stream only saved the user message,
-- producing threads of dangling questions with no visible reply.
--
-- Semantics: when `error_text` is non-NULL, the assistant turn
-- represents a failure — `content` is typically empty and the UI
-- renders the error via the friendly error formatter. When NULL,
-- the row is a normal successful assistant turn.
ALTER TABLE chat_messages ADD COLUMN error_text TEXT;
