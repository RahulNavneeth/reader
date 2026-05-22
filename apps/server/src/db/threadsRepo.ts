/**
 * Chat threads repository.
 *
 * A thread is a named conversation scoped to (doc, user). Multiple
 * threads per (doc, user) are now supported — see migration 011.
 *
 * Title handling:
 *   • Threads are created with a placeholder title ("New chat"). The
 *     first user message bumps the title via deriveTitleFromMessage
 *     — first ~40 chars, sentence-cased. This is intentionally cheap
 *     (no LLM call) so thread creation stays sub-millisecond.
 *   • Users can rename via PATCH; renames lock the title in (we
 *     don't auto-overwrite a user-set title with another auto-title
 *     on a later message — the user-titled flag is implicit: any
 *     title that isn't exactly "New chat" is treated as user-set).
 */
import { db } from './sqlite.js'

export type ChatThread = {
  id: string
  docId: string
  userId: string
  title: string
  createdAt: number
  updatedAt: number
}

type Row = {
  id: string
  doc_id: string
  user_id: string
  title: string
  created_at: number
  updated_at: number
}

const DEFAULT_TITLE = 'New chat'

function rowToThread(r: Row): ChatThread {
  return {
    id: r.id,
    docId: r.doc_id,
    userId: r.user_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Threads visible to (doc, user), most-recently-active first. */
export function listThreads(docId: string, userId: string): ChatThread[] {
  const rows = db()
    .prepare(
      `SELECT id, doc_id, user_id, title, created_at, updated_at
         FROM chat_threads
        WHERE doc_id = ? AND user_id = ?
        ORDER BY updated_at DESC
        LIMIT 200`,
    )
    .all(docId, userId) as Row[]
  return rows.map(rowToThread)
}

/** Fetch one thread by id, scoped to the caller for safety — a user
 *  can never load another user's thread even if they guess the id. */
export function getThread(id: string, userId: string): ChatThread | null {
  const r = db()
    .prepare(
      `SELECT id, doc_id, user_id, title, created_at, updated_at
         FROM chat_threads
        WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as Row | undefined
  return r ? rowToThread(r) : null
}

export type CreateThreadInput = {
  id: string
  docId: string
  userId: string
  title?: string
  createdAt?: number
}

export function createThread(input: CreateThreadInput): ChatThread {
  const now = input.createdAt ?? Date.now()
  const title = (input.title ?? '').trim() || DEFAULT_TITLE
  db()
    .prepare(
      `INSERT INTO chat_threads (id, doc_id, user_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.docId, input.userId, title, now, now)
  return {
    id: input.id,
    docId: input.docId,
    userId: input.userId,
    title,
    createdAt: now,
    updatedAt: now,
  }
}

/** Rename a thread. Scoped by (id, userId, docId) so a caller can't
 *  rename someone else's thread. Returns true if the row updated. */
export function renameThread(
  id: string,
  userId: string,
  docId: string,
  title: string,
): boolean {
  const trimmed = title.trim()
  if (!trimmed) return false
  const r = db()
    .prepare(
      `UPDATE chat_threads
          SET title = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND doc_id = ?`,
    )
    .run(trimmed.slice(0, 200), Date.now(), id, userId, docId)
  return (r.changes ?? 0) > 0
}

/** Bump updated_at so the thread floats to the top of the dropdown
 *  after activity. Called on every new message. */
export function touchThread(id: string, userId: string, docId: string): void {
  db()
    .prepare(
      `UPDATE chat_threads
          SET updated_at = ?
        WHERE id = ? AND user_id = ? AND doc_id = ?`,
    )
    .run(Date.now(), id, userId, docId)
}

/** Auto-title from the first user message, but only when the
 *  thread still has the default placeholder. Once a user has
 *  renamed it, leave it alone. */
export function maybeAutoTitleFromMessage(
  id: string,
  userId: string,
  docId: string,
  message: string,
): void {
  const derived = deriveTitleFromMessage(message)
  if (!derived) return
  db()
    .prepare(
      `UPDATE chat_threads
          SET title = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND doc_id = ?
          AND title = ?`,
    )
    .run(derived, Date.now(), id, userId, docId, DEFAULT_TITLE)
}

/** Drop a thread and (via ON DELETE CASCADE? — actually no, FK is
 *  on doc not thread; messages share thread_id but no FK). We
 *  delete the thread row plus all messages with that thread_id. */
export function deleteThread(id: string, userId: string, docId: string): boolean {
  const dbi = db()
  // Delete dependent messages first. Scoped by user + doc to keep
  // accidental cross-scope deletes impossible.
  dbi
    .prepare(
      `DELETE FROM chat_messages
        WHERE thread_id = ? AND user_id = ? AND doc_id = ?`,
    )
    .run(id, userId, docId)
  const r = dbi
    .prepare(
      `DELETE FROM chat_threads
        WHERE id = ? AND user_id = ? AND doc_id = ?`,
    )
    .run(id, userId, docId)
  return (r.changes ?? 0) > 0
}

/** Strip the Reply-popover blockquote (if any) and use the user's
 *  freeform question as the title. Caps at 60 chars. Returns null
 *  on empty input — caller should leave the placeholder alone. */
export function deriveTitleFromMessage(message: string): string | null {
  const withoutQuote = message.replace(/^\s*>\s*"[^]*?"\s*\n*/, '').trim()
  const source = withoutQuote.length > 0 ? withoutQuote : message.trim()
  if (!source) return null
  // First line, collapsed whitespace.
  const firstLine = source.split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!firstLine) return null
  const capped = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine
  // Sentence-case the first character so titles look intentional
  // ("rephrase this" → "Rephrase this").
  return capped.charAt(0).toUpperCase() + capped.slice(1)
}
