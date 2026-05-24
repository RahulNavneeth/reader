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

/** Single step in the agent's tool-call trace for one assistant
 *  turn. Persisted so a reloaded thread can render the same
 *  "Reasoning (N steps)" accordion it had during streaming. */
export type ToolTraceEntry = {
  /** Stable id of the form "iter.step" (e.g. "0.1") used to pair
   *  start + result events during streaming; survives persistence
   *  for stable React keys. */
  id: string
  /** Tool name as registered in the agent catalog. */
  name: string
  /** Arguments the model passed to the tool. JSON-serialisable. */
  args: unknown
  /** True when the tool executor returned without error. May be
   *  undefined on rows persisted before the result event landed
   *  (defensive — shouldn't happen in normal flow). */
  ok?: boolean
  /** One-line human-readable summary of the result, e.g.
   *  `outline (5 headings)`. */
  summary?: string
}

/** Structured edit the model proposed inside a chat turn. Mirrors
 *  the existing lib/mdx.ts granular-edit ops; the server applies
 *  via those primitives once the user clicks Apply. */
/** Per-op state tracked inline on the pending-edit payload.
 *  `appliedAt` lets the user accept individual ops via the
 *  preview's per-op buttons without losing record of which
 *  ops have already landed. Apply-edit (bulk) and apply-op
 *  both skip ops that already carry an appliedAt. */
type ProposedEditCommon = {
  /** Epoch ms when this specific op was applied via the per-op
   *  preview flow. Null / undefined = still pending. */
  appliedAt?: number | null
}

export type ProposedEditOp =
  | (ProposedEditCommon & { op: 'replace_section'; heading: string; content: string })
  | (ProposedEditCommon & { op: 'insert_after'; heading: string; content: string })
  | (ProposedEditCommon & { op: 'delete_section'; heading: string })
  | (ProposedEditCommon & { op: 'append_text'; content: string })
  | (ProposedEditCommon & { op: 'prepend_text'; content: string })
  // Full-file replace — for non-markdown formats (CSV, JSON, YAML,
  // any text file) where section-level edits don't apply. The card
  // UX shows a unified diff just like the section ops.
  | (ProposedEditCommon & { op: 'rewrite_file'; content: string })

export type ChatMessage = {
  id: string
  docId: string
  userId: string
  /** Thread this message belongs to. Required for new writes — the
   *  route always knows the active thread by the time it persists.
   *  Old rows backfilled by migration 011 carry a deterministic
   *  legacy thread id (`legacy-<docId>-<userId>`). */
  threadId: string
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
  /** Edits the model proposed inside this turn. Null when no
   *  <proposed_edit> blocks were emitted. UI renders these as
   *  diff cards with Apply / Discard. Always null for user turns. */
  pendingEdit: ProposedEditOp[] | null
  /** Epoch ms when the user clicked Apply on this turn's edits.
   *  Null = still pending; non-null = applied (UI hides the
   *  Apply button, shows "Applied N ago"). */
  editAppliedAt: number | null
  /** Doc sha256 at the time the model proposed this edit. Server
   *  compares against current doc sha256 on Apply — mismatch =
   *  doc changed underneath, refuse + surface conflict UI. */
  editTargetSha256: string | null
  /** Agent tool-call trace. Null for non-agent turns. UI renders
   *  as a collapsible "Reasoning (N steps)" accordion above the
   *  answer. */
  toolTrace: ToolTraceEntry[] | null
  createdAt: number
}

type Row = {
  id: string
  doc_id: string
  user_id: string
  thread_id: string | null
  role: ChatRole
  content: string
  citations: string | null
  memories_used: string | null
  error_text: string | null
  pending_edit: string | null
  edit_applied_at: number | null
  edit_target_sha256: string | null
  tool_trace: string | null
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
  let pendingEdit: ProposedEditOp[] | null = null
  if (r.pending_edit) {
    try {
      pendingEdit = JSON.parse(r.pending_edit) as ProposedEditOp[]
    } catch {
      pendingEdit = null
    }
  }
  let toolTrace: ToolTraceEntry[] | null = null
  if (r.tool_trace) {
    try {
      toolTrace = JSON.parse(r.tool_trace) as ToolTraceEntry[]
    } catch {
      toolTrace = null
    }
  }
  return {
    id: r.id,
    docId: r.doc_id,
    userId: r.user_id,
    // Legacy rows backfilled by migration 011 always carry a
    // non-null thread_id, so this fallback only triggers if someone
    // bypasses appendMessage to write a raw row.
    threadId: r.thread_id ?? `legacy-${r.doc_id}-${r.user_id}`,
    role: r.role,
    content: r.content,
    citations,
    memoriesUsed,
    error: r.error_text ?? null,
    pendingEdit,
    editAppliedAt: r.edit_applied_at ?? null,
    editTargetSha256: r.edit_target_sha256 ?? null,
    toolTrace,
    createdAt: r.created_at,
  }
}

/** Full thread for a (doc, user), oldest first. Bounded — pulls at
 *  most 500 messages; older rows are ignored. The UI is meant to
 *  be cleared periodically. */
/** Messages in one thread, oldest first. Bounded at 500 rows; older
 *  messages are silently dropped from this query (UI doesn't expose
 *  pagination yet). */
export function listMessages(
  docId: string,
  userId: string,
  threadId: string,
): ChatMessage[] {
  const rows = db()
    .prepare(
      `SELECT id, doc_id, user_id, thread_id, role, content, citations,
              memories_used, error_text, pending_edit, edit_applied_at,
              edit_target_sha256, tool_trace, created_at
         FROM chat_messages
        WHERE doc_id = ? AND user_id = ? AND thread_id = ?
        ORDER BY created_at ASC
        LIMIT 500`,
    )
    .all(docId, userId, threadId) as Row[]
  return rows.map(rowToMessage)
}

/** Look up one message by id, scoped to (userId, docId). Used by the
 *  apply-edit endpoint which receives a message id from the client
 *  and needs the row regardless of which thread the message lives in.
 *  Returns null if the message doesn't exist or belongs to another
 *  user / doc. */
export function findMessageByIdScoped(
  id: string,
  userId: string,
  docId: string,
): ChatMessage | null {
  const r = db()
    .prepare(
      `SELECT id, doc_id, user_id, thread_id, role, content, citations,
              memories_used, error_text, pending_edit, edit_applied_at,
              edit_target_sha256, tool_trace, created_at
         FROM chat_messages
        WHERE id = ? AND user_id = ? AND doc_id = ?`,
    )
    .get(id, userId, docId) as Row | undefined
  return r ? rowToMessage(r) : null
}

/** Append a single message. Returns the persisted row. The optional
 *  `embedding` argument lets the dispatcher attach a nomic-embed-text
 *  vector (768-dim float32) so we can semantic-search older messages
 *  on future turns. NULL embedding is fine — messages just won't
 *  surface in the relevance retrieval. */
export function appendMessage(
  m: ChatMessage,
  embedding?: Float32Array | null,
): void {
  db()
    .prepare(
      `INSERT INTO chat_messages
         (id, doc_id, user_id, thread_id, role, content, citations,
          memories_used, error_text, pending_edit, edit_applied_at,
          edit_target_sha256, tool_trace, created_at,
          embedding, embed_dim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.id,
      m.docId,
      m.userId,
      m.threadId,
      m.role,
      m.content,
      m.citations ? JSON.stringify(m.citations) : null,
      m.memoriesUsed ? JSON.stringify(m.memoriesUsed) : null,
      m.error ?? null,
      m.pendingEdit ? JSON.stringify(m.pendingEdit) : null,
      m.editAppliedAt ?? null,
      m.editTargetSha256 ?? null,
      m.toolTrace ? JSON.stringify(m.toolTrace) : null,
      m.createdAt,
      embedding && embedding.length > 0 ? encodeEmbedding(embedding) : null,
      embedding && embedding.length > 0 ? embedding.length : null,
    )
}

/** Stream messages within a thread that carry an embedding. Used
 *  by the dispatcher's similarity scan to find semantically
 *  relevant older turns once a thread exceeds the recent-window
 *  budget. Returns enough metadata to dedupe against the verbatim
 *  window the caller already plans to send. */
export type EmbeddedChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  embedding: Float32Array
}

export function listEmbeddedMessages(
  docId: string,
  userId: string,
  threadId: string,
): EmbeddedChatMessage[] {
  const rows = db()
    .prepare(
      `SELECT id, role, content, created_at, embedding, embed_dim
         FROM chat_messages
        WHERE doc_id = ? AND user_id = ? AND thread_id = ?
          AND embedding IS NOT NULL`,
    )
    .all(docId, userId, threadId) as Array<{
    id: string
    role: ChatRole
    content: string
    created_at: number
    embedding: Buffer
    embed_dim: number
  }>
  const out: EmbeddedChatMessage[] = []
  for (const r of rows) {
    const f = decodeEmbedding(r.embedding)
    if (f.length === 0) continue
    out.push({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      embedding: f,
    })
  }
  return out
}

function encodeEmbedding(f: Float32Array): Buffer {
  // Zero-copy view into the underlying ArrayBuffer; SQLite/better-
  // sqlite3 binds the bytes verbatim.
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

function decodeEmbedding(b: Buffer): Float32Array {
  // Float32Array needs a 4-byte-aligned offset. better-sqlite3 hands
  // us a fresh Buffer per row so this is normally fine, but we copy
  // when alignment is off as a safety belt.
  if (b.byteOffset % 4 === 0) {
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
  }
  const copy = Buffer.from(b)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/** Mark this assistant turn's pending edits as applied. Returns
 *  true when the update landed (and the row hadn't already been
 *  applied — second call is a no-op). Scoped by (id, userId,
 *  docId) so a caller can't apply someone else's edit. */
export function markEditApplied(
  id: string,
  userId: string,
  docId: string,
  appliedAt: number = Date.now(),
): boolean {
  const r = db()
    .prepare(
      `UPDATE chat_messages
          SET edit_applied_at = ?
        WHERE id = ? AND user_id = ? AND doc_id = ?
          AND pending_edit IS NOT NULL
          AND edit_applied_at IS NULL`,
    )
    .run(appliedAt, id, userId, docId)
  return (r.changes ?? 0) > 0
}

/** Drop the pending_edit payload on this turn — the user clicked
 *  Discard. The chat message itself (content + reasoning) stays
 *  in history so a future scroll-back shows "Reader AI suggested
 *  X, I discarded it". Scoped by (id, userId, docId). */
export function discardPendingEdit(
  id: string,
  userId: string,
  docId: string,
): boolean {
  const r = db()
    .prepare(
      `UPDATE chat_messages
          SET pending_edit = NULL,
              edit_target_sha256 = NULL
        WHERE id = ? AND user_id = ? AND doc_id = ?
          AND pending_edit IS NOT NULL
          AND edit_applied_at IS NULL`,
    )
    .run(id, userId, docId)
  return (r.changes ?? 0) > 0
}

/** Replace the pending_edit array on a turn with a new array.
 *  Used by per-op apply / discard to mark the one op the user
 *  acted on. The array is preserved (not shrunk) when applying
 *  so the UI keeps a record of "Applied to <heading>" pills for
 *  every op the model originally proposed. Discard-op DOES shrink
 *  (a discarded op is gone, not history-worthy). */
export function setPendingEdit(
  id: string,
  userId: string,
  docId: string,
  ops: unknown[],
): boolean {
  const r = db()
    .prepare(
      `UPDATE chat_messages
          SET pending_edit = ?
        WHERE id = ? AND user_id = ? AND doc_id = ?
          AND pending_edit IS NOT NULL
          AND edit_applied_at IS NULL`,
    )
    .run(JSON.stringify(ops), id, userId, docId)
  return (r.changes ?? 0) > 0
}

/** Update the turn's edit_target_sha256 to a new value. Called
 *  after a per-op apply that left additional ops pending: the
 *  doc's sha256 just changed, so the next per-op apply would
 *  otherwise 409 on the (now stale) sha check. */
export function updateEditTargetSha(
  id: string,
  userId: string,
  docId: string,
  sha: string,
): boolean {
  const r = db()
    .prepare(
      `UPDATE chat_messages
          SET edit_target_sha256 = ?
        WHERE id = ? AND user_id = ? AND doc_id = ?
          AND pending_edit IS NOT NULL
          AND edit_applied_at IS NULL`,
    )
    .run(sha, id, userId, docId)
  return (r.changes ?? 0) > 0
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
