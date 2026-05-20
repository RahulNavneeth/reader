/**
 * Chat message repository — per-document, per-user conversation
 * history backing the AI chat panel.
 *
 * One thread per (docId, userId). Messages are immutable once
 * written: an assistant reply lands as a single row when its stream
 * completes (we don't persist partial streams — a disconnected
 * client never finished the answer, so the row would be misleading
 * to load back).
 */
import { db } from './sqlite.js'

export type ChatRole = 'user' | 'assistant'

export type ChatCitation = {
  /** Doc the chunk came from. May be a different doc than the
   *  thread's anchor when vault-wide RAG pulls in cross-doc
   *  context. */
  docId: string
  /** Chunk index within that doc, matching the chunks table. */
  chunkIdx: number
  /** Cosine score at retrieval time, rounded to 4 decimals. Useful
   *  for the UI to sort and de-duplicate citations. */
  score: number
  /** Human-readable doc title at the time of the citation. Saved on
   *  the citation so a later rename or delete doesn't strand the
   *  reference. Optional for back-compat with rows written before
   *  this field existed. */
  docTitle?: string
  /** Vault-relative path. Lets the UI link the citation chip back to
   *  the file. Optional for the same back-compat reason. */
  docPath?: string
  /** Short preview of the actual chunk text the model received as
   *  context. Capped at ~600 chars before storage so we don't bloat
   *  the messages row. Lets the UI surface what was retrieved
   *  without needing a separate chunk-fetch round-trip. */
  text?: string
  /** True when this citation came from the OPEN doc (focus / section
   *  match), false/undefined for cross-doc vault chunks. UI renders
   *  "from this document" entries separately. */
  primary?: boolean
}

/** Memory that was surfaced into the system prompt when this turn
 *  was generated. Persisted alongside the assistant turn so the UI
 *  can show "Used memory: …" footers on history-loaded turns, not
 *  just on the in-flight streaming turn. */
export type MemoryUsed = {
  kind: 'user' | 'doc' | 'mistake'
  id: string
  /** Short human-readable preview of what was used — the memory
   *  fact for user/doc, a "Q: …" snippet for mistakes. */
  preview: string
}

export type ChatMessage = {
  id: string
  docId: string
  userId: string
  role: ChatRole
  content: string
  citations: ChatCitation[] | null
  /** Memories surfaced for this turn. Null for user turns. */
  memoriesUsed: MemoryUsed[] | null
  /** When set, this turn represents a failure (model 404, daemon
   *  down, etc.) rather than a successful reply. UI renders this
   *  via the friendly error formatter instead of the markdown
   *  pipeline. Always null for user turns. */
  error: string | null
  createdAt: number
}

type Row = {
  id: string
  doc_id: string
  user_id: string
  role: ChatRole
  content: string
  citations: string | null
  memories_used: string | null
  error_text: string | null
  created_at: number
}

function rowToMessage(r: Row): ChatMessage {
  let citations: ChatCitation[] | null = null
  if (r.citations) {
    try {
      citations = JSON.parse(r.citations) as ChatCitation[]
    } catch {
      citations = null
    }
  }
  let memoriesUsed: MemoryUsed[] | null = null
  if (r.memories_used) {
    try {
      memoriesUsed = JSON.parse(r.memories_used) as MemoryUsed[]
    } catch {
      memoriesUsed = null
    }
  }
  return {
    id: r.id,
    docId: r.doc_id,
    userId: r.user_id,
    role: r.role,
    content: r.content,
    citations,
    memoriesUsed,
    error: r.error_text ?? null,
    createdAt: r.created_at,
  }
}

/** Full thread for a (doc, user), oldest first. Bounded — pulls at
 *  most 500 messages; older rows are ignored. The UI is meant to
 *  be cleared periodically. */
export function listMessages(docId: string, userId: string): ChatMessage[] {
  const rows = db()
    .prepare(
      `SELECT id, doc_id, user_id, role, content, citations, memories_used, error_text, created_at
         FROM chat_messages
        WHERE doc_id = ? AND user_id = ?
        ORDER BY created_at ASC
        LIMIT 500`,
    )
    .all(docId, userId) as Row[]
  return rows.map(rowToMessage)
}

/** Append a single message. Returns the persisted row. */
export function appendMessage(m: ChatMessage): void {
  db()
    .prepare(
      `INSERT INTO chat_messages (id, doc_id, user_id, role, content, citations, memories_used, error_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.id,
      m.docId,
      m.userId,
      m.role,
      m.content,
      m.citations ? JSON.stringify(m.citations) : null,
      m.memoriesUsed ? JSON.stringify(m.memoriesUsed) : null,
      m.error ?? null,
      m.createdAt,
    )
}

/** Wipe the thread for one (doc, user). Doesn't touch other users'
 *  threads on the same doc, or this user's threads on other docs. */
export function clearThread(docId: string, userId: string): number {
  const r = db()
    .prepare(`DELETE FROM chat_messages WHERE doc_id = ? AND user_id = ?`)
    .run(docId, userId)
  return r.changes ?? 0
}

/** Drop a single message, scoped to (id, docId, userId) so a caller
 *  can never delete a row that doesn't belong to the requesting
 *  user. Used by the regenerate flow to replace a stale assistant
 *  turn with a fresh one. Returns true when a row was removed. */
export function deleteMessageById(
  id: string,
  userId: string,
  docId: string,
): boolean {
  const r = db()
    .prepare(
      `DELETE FROM chat_messages
        WHERE id = ? AND user_id = ? AND doc_id = ?`,
    )
    .run(id, userId, docId)
  return (r.changes ?? 0) > 0
}
