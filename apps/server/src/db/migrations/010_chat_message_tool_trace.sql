-- Agent tool trace: ordered list of tool calls the agent ran while
-- producing this assistant turn. Stored as JSON for forward-compat
-- with new tool kinds. Null for legacy / non-agent turns.
ALTER TABLE chat_messages ADD COLUMN tool_trace TEXT;
