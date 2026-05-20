import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { _resetDbForTest, db } from './sqlite.js'
import { runMigrations } from './migrations.js'
import {
  appendMessage,
  clearThread,
  deleteMessageById,
  listMessages,
  type ChatMessage,
} from './chatRepo.js'

/**
 * Persistence + isolation contract for the chat history layer.
 *
 * Two scoping rules matter for safety:
 *   - thread per (docId, userId): clearing alice's thread on doc A
 *     must not touch bob's thread on doc A, or alice's on doc B
 *   - listMessages returns oldest-first so the UI can replay turns
 */

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
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    docId: partial.docId ?? 'docA',
    userId: partial.userId ?? 'alice',
    role: partial.role ?? 'user',
    content: partial.content ?? 'hi',
    citations: partial.citations ?? null,
    memoriesUsed: partial.memoriesUsed ?? null,
    error: partial.error ?? null,
    createdAt: partial.createdAt ?? Date.now(),
  }
}

describe('chatRepo', () => {
  it('starts empty for a new (doc, user)', () => {
    expect(listMessages('docA', 'alice')).toEqual([])
  })

  it('persists and reads back in chronological order', async () => {
    const t0 = Date.now()
    appendMessage(msg({ id: '1', role: 'user', content: 'q1', createdAt: t0 }))
    appendMessage(msg({ id: '2', role: 'assistant', content: 'a1', createdAt: t0 + 10 }))
    appendMessage(msg({ id: '3', role: 'user', content: 'q2', createdAt: t0 + 20 }))
    const list = listMessages('docA', 'alice')
    expect(list.map((m) => m.id)).toEqual(['1', '2', '3'])
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('round-trips an assistant turn with an error (regression: failures must persist)', () => {
    appendMessage(
      msg({
        id: 'e1',
        role: 'assistant',
        content: '',
        error: "Ollama returned 404: model 'qwen2.5:7b-instruct' not found",
      }),
    )
    const list = listMessages('docA', 'alice')
    expect(list).toHaveLength(1)
    expect(list[0].error).toMatch(/model 'qwen2\.5:7b-instruct' not found/)
    expect(list[0].content).toBe('')
  })

  it('round-trips citations as structured JSON', () => {
    appendMessage(
      msg({
        id: 'c1',
        role: 'assistant',
        content: 'with refs',
        citations: [
          { docId: 'docA', chunkIdx: 0, score: 0.91 },
          { docId: 'docB', chunkIdx: 3, score: 0.77 },
        ],
      }),
    )
    const list = listMessages('docA', 'alice')
    expect(list[0].citations).toEqual([
      { docId: 'docA', chunkIdx: 0, score: 0.91 },
      { docId: 'docB', chunkIdx: 3, score: 0.77 },
    ])
  })

  it('isolates threads by user', () => {
    appendMessage(msg({ id: 'a1', userId: 'alice', content: 'alice msg' }))
    appendMessage(msg({ id: 'b1', userId: 'bob', content: 'bob msg' }))
    expect(listMessages('docA', 'alice').map((m) => m.content)).toEqual(['alice msg'])
    expect(listMessages('docA', 'bob').map((m) => m.content)).toEqual(['bob msg'])
  })

  it('isolates threads by docId', () => {
    appendMessage(msg({ id: 'a1', docId: 'docA', content: 'on A' }))
    appendMessage(msg({ id: 'b1', docId: 'docB', content: 'on B' }))
    expect(listMessages('docA', 'alice').map((m) => m.content)).toEqual(['on A'])
    expect(listMessages('docB', 'alice').map((m) => m.content)).toEqual(['on B'])
  })

  it('clearThread wipes only that (doc, user) pair', () => {
    appendMessage(msg({ id: 'a1', docId: 'docA', userId: 'alice' }))
    appendMessage(msg({ id: 'a2', docId: 'docA', userId: 'bob' }))
    appendMessage(msg({ id: 'b1', docId: 'docB', userId: 'alice' }))
    const n = clearThread('docA', 'alice')
    expect(n).toBe(1)
    expect(listMessages('docA', 'alice')).toEqual([])
    expect(listMessages('docA', 'bob').length).toBe(1)
    expect(listMessages('docB', 'alice').length).toBe(1)
  })

  it('cascades on document delete', () => {
    appendMessage(msg({ id: 'a1', docId: 'docA' }))
    appendMessage(msg({ id: 'b1', docId: 'docB' }))
    db().prepare(`DELETE FROM documents WHERE id = ?`).run('docA')
    expect(listMessages('docA', 'alice')).toEqual([])
    expect(listMessages('docB', 'alice').length).toBe(1)
  })

  describe('deleteMessageById', () => {
    it('drops the named row and only the named row', () => {
      appendMessage(msg({ id: 'keep', content: 'q1' }))
      appendMessage(msg({ id: 'drop', role: 'assistant', content: 'a1' }))
      appendMessage(msg({ id: 'keep2', content: 'q2' }))
      const ok = deleteMessageById('drop', 'alice', 'docA')
      expect(ok).toBe(true)
      const ids = listMessages('docA', 'alice').map((m) => m.id)
      expect(ids).toEqual(['keep', 'keep2'])
    })

    it('refuses to delete a row that belongs to another user', () => {
      appendMessage(msg({ id: 'a-msg', userId: 'alice', content: 'mine' }))
      const ok = deleteMessageById('a-msg', 'bob', 'docA')
      expect(ok).toBe(false)
      expect(listMessages('docA', 'alice')).toHaveLength(1)
    })

    it('refuses to delete a row scoped to a different doc', () => {
      appendMessage(msg({ id: 'm1', docId: 'docA', content: 'in A' }))
      const ok = deleteMessageById('m1', 'alice', 'docB')
      expect(ok).toBe(false)
      expect(listMessages('docA', 'alice')).toHaveLength(1)
    })
  })

  it('caps thread reads at the 500-message ceiling', () => {
    for (let i = 0; i < 510; i++) {
      appendMessage(msg({ id: `m${i}`, createdAt: i, content: `n${i}` }))
    }
    expect(listMessages('docA', 'alice').length).toBe(500)
  })
})
