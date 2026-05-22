import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendMessage,
  clearThread,
  deleteMessageById,
  discardPendingEdit,
  findMessageByIdScoped,
  listMessages,
  markEditApplied,
  type ChatMessage,
} from './chatRepo.js'
import { config } from '../config.js'
import { db, _resetDbForTest } from './sqlite.js'
import { runMigrations } from './migrations.js'

const originalData = config.dataDir

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-chat-'))
  ;(config as { dataDir: string }).dataDir = dir
  _resetDbForTest()
  // We need the documents table to satisfy the chat_messages FK.
  runMigrations()
  // Insert two stub docs so the FK references in chat_messages are
  // satisfied. We only fill the NOT NULL columns; the rest default.
  const insertDoc = db().prepare(
    `INSERT INTO documents
       (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?)`,
  )
  const now = Date.now()
  insertDoc.run('docA', 'alice', 'a.md', 'A', 'a.md', 'text/markdown', now, now)
  insertDoc.run('docB', 'alice', 'b.md', 'B', 'b.md', 'text/markdown', now, now)
})

afterEach(async () => {
  const dir = config.dataDir
  _resetDbForTest()
  ;(config as { dataDir: string }).dataDir = originalData
  await rm(dir, { recursive: true, force: true })
})

function msg(partial: Partial<ChatMessage>): ChatMessage {
  const docId = partial.docId ?? 'docA'
  const userId = partial.userId ?? 'alice'
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    docId,
    userId,
    // Tests predate multi-thread; default to the legacy thread id
    // format so messages from the same (doc, user) land in one
    // conversation, matching the pre-multi-thread expectation.
    threadId: partial.threadId ?? `legacy-${docId}-${userId}`,
    role: partial.role ?? 'user',
    content: partial.content ?? 'hi',
    citations: partial.citations ?? null,
    memoriesUsed: partial.memoriesUsed ?? null,
    error: partial.error ?? null,
    pendingEdit: partial.pendingEdit ?? null,
    editAppliedAt: partial.editAppliedAt ?? null,
    editTargetSha256: partial.editTargetSha256 ?? null,
    toolTrace: partial.toolTrace ?? null,
    createdAt: partial.createdAt ?? Date.now(),
  }
}

/** Convenience wrapper for tests that predate multi-thread — fills
 *  in the deterministic legacy thread id so existing assertions
 *  read the messages they just wrote. */
function legacyList(docId: string, userId: string) {
  return listMessages(docId, userId, `legacy-${docId}-${userId}`)
}

describe('chatRepo', () => {
  it('starts empty for a new (doc, user)', () => {
    expect(legacyList('docA', 'alice')).toEqual([])
  })

  it('persists and reads back in chronological order', async () => {
    const t0 = Date.now()
    appendMessage(msg({ id: '1', role: 'user', content: 'q1', createdAt: t0 }))
    appendMessage(msg({ id: '2', role: 'assistant', content: 'a1', createdAt: t0 + 10 }))
    appendMessage(msg({ id: '3', role: 'user', content: 'q2', createdAt: t0 + 20 }))
    const list = legacyList('docA', 'alice')
    expect(list.map((m) => m.id)).toEqual(['1', '2', '3'])
    expect(list.map((m) => m.content)).toEqual(['q1', 'a1', 'q2'])
  })

  it('round-trips citations + memoriesUsed JSON', () => {
    appendMessage(
      msg({
        id: 'a',
        role: 'assistant',
        content: 'answer',
        citations: [{ docId: 'docA', chunkIdx: 0, score: 0.9, docTitle: 'A' }],
        memoriesUsed: [{ kind: 'user', id: 'm1', preview: 'liquid funds' }],
      }),
    )
    const list = legacyList('docA', 'alice')
    expect(list).toHaveLength(1)
    expect(list[0].citations?.[0].score).toBe(0.9)
    expect(list[0].memoriesUsed?.[0].kind).toBe('user')
  })

  it('round-trips pendingEdit JSON', () => {
    appendMessage(
      msg({
        id: 'p',
        role: 'assistant',
        content: 'sure',
        pendingEdit: [{ op: 'replace_section', heading: 'Risks', content: 'new body' }],
        editTargetSha256: 'sha',
      }),
    )
    const list = legacyList('docA', 'alice')
    expect(list[0].pendingEdit?.[0].op).toBe('replace_section')
    expect(list[0].editTargetSha256).toBe('sha')
  })

  it('scopes by user — alice cannot see bob', () => {
    appendMessage(msg({ id: 'a1', userId: 'alice', content: 'alice msg' }))
    appendMessage(msg({ id: 'b1', userId: 'bob', content: 'bob msg' }))
    expect(legacyList('docA', 'alice').map((m) => m.content)).toEqual(['alice msg'])
    expect(legacyList('docA', 'bob').map((m) => m.content)).toEqual(['bob msg'])
  })

  it('scopes by doc — docA messages do not appear in docB list', () => {
    appendMessage(msg({ id: 'a1', docId: 'docA', content: 'on A' }))
    appendMessage(msg({ id: 'b1', docId: 'docB', content: 'on B' }))
    expect(legacyList('docA', 'alice').map((m) => m.content)).toEqual(['on A'])
    expect(legacyList('docB', 'alice').map((m) => m.content)).toEqual(['on B'])
  })

  it('clearThread wipes only the matching (doc, user)', () => {
    appendMessage(msg({ id: 'a1', userId: 'alice', docId: 'docA' }))
    appendMessage(msg({ id: 'b1', userId: 'bob', docId: 'docA' }))
    appendMessage(msg({ id: 'a2', userId: 'alice', docId: 'docB' }))
    const n = clearThread('docA', 'alice')
    expect(n).toBe(1)
    expect(legacyList('docA', 'alice')).toEqual([])
    expect(legacyList('docA', 'bob').length).toBe(1)
    expect(legacyList('docB', 'alice').length).toBe(1)
  })

  it('deleteMessageById removes a single row, scoped', () => {
    appendMessage(msg({ id: 'x', userId: 'alice', docId: 'docA' }))
    appendMessage(msg({ id: 'y', userId: 'alice', docId: 'docB' }))
    const ok = deleteMessageById('x', 'alice', 'docA')
    expect(ok).toBe(true)
    expect(legacyList('docA', 'alice')).toEqual([])
    expect(legacyList('docB', 'alice').length).toBe(1)
  })

  it('deleteMessageById refuses cross-user / cross-doc', () => {
    appendMessage(msg({ id: 'x', userId: 'alice', docId: 'docA' }))
    expect(deleteMessageById('x', 'bob', 'docA')).toBe(false)
    expect(deleteMessageById('x', 'alice', 'docB')).toBe(false)
    const ids = legacyList('docA', 'alice').map((m) => m.id)
    expect(ids).toEqual(['x'])
  })

  it('LIMIT caps the returned set at 500 rows', () => {
    const t0 = Date.now()
    for (let i = 0; i < 510; i++) {
      appendMessage(msg({ id: `n${i}`, createdAt: t0 + i }))
    }
    // 510 inserted; the SELECT caps at 500 — verify it doesn't blow
    // up the row reader or return a partial JSON parse failure.
    expect(legacyList('docA', 'alice').length).toBe(500)
  })

  it('findMessageByIdScoped returns the row when (id, userId, docId) match', () => {
    appendMessage(msg({ id: 'find', userId: 'alice', docId: 'docA', content: 'present' }))
    const r = findMessageByIdScoped('find', 'alice', 'docA')
    expect(r?.content).toBe('present')
  })

  it('findMessageByIdScoped returns null cross-user / cross-doc / missing', () => {
    appendMessage(msg({ id: 'find', userId: 'alice', docId: 'docA' }))
    expect(findMessageByIdScoped('find', 'bob', 'docA')).toBeNull()
    expect(findMessageByIdScoped('find', 'alice', 'docB')).toBeNull()
    expect(findMessageByIdScoped('does-not-exist', 'alice', 'docA')).toBeNull()
  })
})

describe('markEditApplied', () => {
  it('flips edit_applied_at on a turn that had a pending edit', () => {
    appendMessage(
      msg({
        id: 'a',
        role: 'assistant',
        pendingEdit: [{ op: 'append_text', content: 'tail' }],
      }),
    )
    expect(markEditApplied('a', 'alice', 'docA', 12345)).toBe(true)
    expect(legacyList('docA', 'alice')[0].editAppliedAt).toBe(12345)
  })

  it('is a no-op when the turn has no pending edit', () => {
    appendMessage(msg({ id: 'a', role: 'assistant', pendingEdit: null }))
    expect(markEditApplied('a', 'alice', 'docA')).toBe(false)
  })

  it('is idempotent — second call is a no-op', () => {
    appendMessage(
      msg({
        id: 'a',
        role: 'assistant',
        pendingEdit: [{ op: 'append_text', content: 'tail' }],
      }),
    )
    expect(markEditApplied('a', 'alice', 'docA')).toBe(true)
    expect(markEditApplied('a', 'alice', 'docA')).toBe(false)
  })

  it('refuses cross-user', () => {
    appendMessage(
      msg({
        id: 'a',
        userId: 'alice',
        role: 'assistant',
        pendingEdit: [{ op: 'append_text', content: 'tail' }],
      }),
    )
    expect(markEditApplied('a', 'bob', 'docA')).toBe(false)
    expect(legacyList('docA', 'alice')[0].editAppliedAt).toBeNull()
  })
})

describe('discardPendingEdit', () => {
  it('clears the pending_edit payload on success', () => {
    appendMessage(
      msg({
        id: 'a',
        role: 'assistant',
        pendingEdit: [{ op: 'append_text', content: 'x' }],
        editTargetSha256: 'sha',
      }),
    )
    expect(discardPendingEdit('a', 'alice', 'docA')).toBe(true)
    const row = legacyList('docA', 'alice')[0]
    expect(row.pendingEdit).toBeNull()
    expect(row.editTargetSha256).toBeNull()
  })

  it('refuses cross-user; the original row is untouched', () => {
    appendMessage(
      msg({
        id: 'a',
        userId: 'alice',
        role: 'assistant',
        pendingEdit: [{ op: 'append_text', content: 'x' }],
      }),
    )
    expect(discardPendingEdit('a', 'bob', 'docA')).toBe(false)
    expect(legacyList('docA', 'alice')[0].pendingEdit).not.toBeNull()
  })

  it('refuses on an already-applied turn', () => {
    appendMessage(
      msg({
        id: 'a',
        role: 'assistant',
        pendingEdit: [{ op: 'append_text', content: 'x' }],
        editAppliedAt: 1,
      }),
    )
    expect(discardPendingEdit('a', 'alice', 'docA')).toBe(false)
  })
})
