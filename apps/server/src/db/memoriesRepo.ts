/**
 * Memory repository for Reader AI.
 *
 * Three independent tables, each with its own scope contract:
 *   - user_memories      — per-user, applies everywhere
 *   - doc_memories       — per-(user, doc), applies only on that doc
 *   - chat_error_notes   — per-user failure log, optionally doc-scoped
 *
 * v1 retrieval is intentionally simple:
 *   - listUserMemoriesByPopularity returns top-N by used_count
 *   - listRecentErrorNotes returns the most recent N
 *
 * Embedding-based similarity retrieval for chat_error_notes is
 * deferred to v2 (the design doc covers the upgrade path).
 */
import { db } from './sqlite.js'

export type MemorySource = 'user_command' | 'auto_extracted'

export type UserMemory = {
  id: string
  userId: string
  fact: string
  source: MemorySource
  usedCount: number
  createdAt: number
}

export type DocMemory = {
  id: string
  docId: string
  userId: string
  fact: string
  createdAt: number
}

export type ChatErrorNote = {
  id: string
  userId: string
  /** Non-null when the failure was raised inside a specific doc's chat. */
  docId: string | null
  question: string
  wrongAnswer: string | null
  correction: string
  createdAt: number
}

// ── User memories ─────────────────────────────────────────────────

type UserMemoryRow = {
  id: string
  user_id: string
  fact: string
  source: string
  used_count: number
  created_at: number
}

function rowToUserMemory(r: UserMemoryRow): UserMemory {
  return {
    id: r.id,
    userId: r.user_id,
    fact: r.fact,
    source: r.source === 'auto_extracted' ? 'auto_extracted' : 'user_command',
    usedCount: r.used_count,
    createdAt: r.created_at,
  }
}

/** All user memories, newest first. UI uses this to render the
 *  memories panel; the prompt injector uses
 *  listUserMemoriesByPopularity instead. */
export function listUserMemories(userId: string): UserMemory[] {
  const rows = db()
    .prepare(
      `SELECT id, user_id, fact, source, used_count, created_at
         FROM user_memories
        WHERE user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(userId) as UserMemoryRow[]
  return rows.map(rowToUserMemory)
}

/** Top-N user memories by popularity. Surfaces in the system
 *  prompt so the most-relied-on facts make the per-prompt cap. */
export function listUserMemoriesByPopularity(
  userId: string,
  limit: number,
): UserMemory[] {
  const rows = db()
    .prepare(
      `SELECT id, user_id, fact, source, used_count, created_at
         FROM user_memories
        WHERE user_id = ?
        ORDER BY used_count DESC, created_at DESC
        LIMIT ?`,
    )
    .all(userId, limit) as UserMemoryRow[]
  return rows.map(rowToUserMemory)
}

export function addUserMemory(m: Omit<UserMemory, 'usedCount'> & { usedCount?: number }): void {
  db()
    .prepare(
      `INSERT INTO user_memories (id, user_id, fact, source, used_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(m.id, m.userId, m.fact, m.source, m.usedCount ?? 0, m.createdAt)
}

/** Scoped to (id, user_id) so a caller can't delete someone
 *  else's memory by guessing the id. Returns true when a row
 *  was removed. */
export function deleteUserMemory(id: string, userId: string): boolean {
  const r = db()
    .prepare(`DELETE FROM user_memories WHERE id = ? AND user_id = ?`)
    .run(id, userId)
  return (r.changes ?? 0) > 0
}

/** Increment used_count by 1 for each id in the list. Called by
 *  the prompt builder whenever a memory makes it into the system
 *  prompt — drives the popularity-sort feedback loop. */
export function incrementUserMemoryUsage(ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db()
    .prepare(`UPDATE user_memories SET used_count = used_count + 1 WHERE id IN (${placeholders})`)
    .run(...ids)
}

// ── Doc memories ──────────────────────────────────────────────────

type DocMemoryRow = {
  id: string
  doc_id: string
  user_id: string
  fact: string
  created_at: number
}

function rowToDocMemory(r: DocMemoryRow): DocMemory {
  return {
    id: r.id,
    docId: r.doc_id,
    userId: r.user_id,
    fact: r.fact,
    createdAt: r.created_at,
  }
}

export function listDocMemories(docId: string, userId: string): DocMemory[] {
  const rows = db()
    .prepare(
      `SELECT id, doc_id, user_id, fact, created_at
         FROM doc_memories
        WHERE doc_id = ? AND user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(docId, userId) as DocMemoryRow[]
  return rows.map(rowToDocMemory)
}

export function addDocMemory(m: DocMemory): void {
  db()
    .prepare(
      `INSERT INTO doc_memories (id, doc_id, user_id, fact, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(m.id, m.docId, m.userId, m.fact, m.createdAt)
}

/** Scoped to (id, doc_id, user_id). Returns true when a row was
 *  removed — the triple scope prevents cross-doc / cross-user
 *  deletes even when the caller guesses the id. */
export function deleteDocMemory(id: string, docId: string, userId: string): boolean {
  const r = db()
    .prepare(
      `DELETE FROM doc_memories
        WHERE id = ? AND doc_id = ? AND user_id = ?`,
    )
    .run(id, docId, userId)
  return (r.changes ?? 0) > 0
}

// ── Chat error notes ──────────────────────────────────────────────

type ChatErrorNoteRow = {
  id: string
  user_id: string
  doc_id: string | null
  question: string
  wrong_answer: string | null
  correction: string
  created_at: number
}

function rowToErrorNote(r: ChatErrorNoteRow): ChatErrorNote {
  return {
    id: r.id,
    userId: r.user_id,
    docId: r.doc_id,
    question: r.question,
    wrongAnswer: r.wrong_answer,
    correction: r.correction,
    createdAt: r.created_at,
  }
}

export function addChatErrorNote(n: ChatErrorNote): void {
  db()
    .prepare(
      `INSERT INTO chat_error_notes (id, user_id, doc_id, question, wrong_answer, correction, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      n.id,
      n.userId,
      n.docId,
      n.question,
      n.wrongAnswer,
      n.correction,
      n.createdAt,
    )
}

/** Most-recent error notes for a user. The prompt injector calls
 *  this to seed <known_mistakes>; v1 uses recency only, v2 will
 *  add similarity-based retrieval against the current query. */
export function listRecentErrorNotes(
  userId: string,
  limit: number,
): ChatErrorNote[] {
  const rows = db()
    .prepare(
      `SELECT id, user_id, doc_id, question, wrong_answer, correction, created_at
         FROM chat_error_notes
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(userId, limit) as ChatErrorNoteRow[]
  return rows.map(rowToErrorNote)
}

export function deleteChatErrorNote(id: string, userId: string): boolean {
  const r = db()
    .prepare(`DELETE FROM chat_error_notes WHERE id = ? AND user_id = ?`)
    .run(id, userId)
  return (r.changes ?? 0) > 0
}
