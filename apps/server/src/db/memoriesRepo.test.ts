import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { _resetDbForTest, db } from './sqlite.js'
import { runMigrations } from './migrations.js'
import {
  addUserMemory,
  addDocMemory,
  addChatErrorNote,
  deleteUserMemory,
  deleteDocMemory,
  deleteChatErrorNote,
  incrementUserMemoryUsage,
  listUserMemories,
  listUserMemoriesByPopularity,
  listDocMemories,
  listRecentErrorNotes,
} from './memoriesRepo.js'

/**
 * Coverage for the Reader AI memory system (migration 007).
 * Locks in the scope contract: a user memory belongs to one
 * user, a doc memory belongs to one (user, doc), and the failure
 * log is per-user. Cross-scope reads / deletes must refuse.
 */

const originalData = config.dataDir

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-mem-'))
  ;(config as { dataDir: string }).dataDir = dir
  _resetDbForTest()
  runMigrations()
  // Two stub docs for the doc-memory FK + cascade tests.
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

describe('memoriesRepo — user_memories', () => {
  const make = (id: string, userId: string, fact: string, usedCount = 0, createdAt = Date.now()) => ({
    id,
    userId,
    fact,
    source: 'user_command' as const,
    usedCount,
    createdAt,
  })

  it('starts empty for a fresh user', () => {
    expect(listUserMemories('alice')).toEqual([])
  })

  it('persists a memory and reads it back', () => {
    addUserMemory(make('u1', 'alice', 'currency is ₹'))
    const out = listUserMemories('alice')
    expect(out).toHaveLength(1)
    expect(out[0].fact).toBe('currency is ₹')
    expect(out[0].source).toBe('user_command')
    expect(out[0].usedCount).toBe(0)
  })

  it('isolates user memories by user', () => {
    addUserMemory(make('a1', 'alice', 'alice fact'))
    addUserMemory(make('b1', 'bob', 'bob fact'))
    expect(listUserMemories('alice').map((m) => m.fact)).toEqual(['alice fact'])
    expect(listUserMemories('bob').map((m) => m.fact)).toEqual(['bob fact'])
  })

  it('lists by popularity (used_count DESC, then created_at DESC)', () => {
    addUserMemory(make('low', 'alice', 'less popular', 1, 1000))
    addUserMemory(make('high', 'alice', 'most popular', 10, 1000))
    addUserMemory(make('mid-new', 'alice', 'mid newer', 5, 3000))
    addUserMemory(make('mid-old', 'alice', 'mid older', 5, 2000))
    const out = listUserMemoriesByPopularity('alice', 10).map((m) => m.id)
    expect(out).toEqual(['high', 'mid-new', 'mid-old', 'low'])
  })

  it('caps popularity list to the requested limit', () => {
    for (let i = 0; i < 25; i++) {
      addUserMemory(make(`u${i}`, 'alice', `fact ${i}`, i))
    }
    expect(listUserMemoriesByPopularity('alice', 5)).toHaveLength(5)
  })

  it('refuses to delete a memory belonging to another user', () => {
    addUserMemory(make('a1', 'alice', 'alice fact'))
    expect(deleteUserMemory('a1', 'bob')).toBe(false)
    expect(listUserMemories('alice')).toHaveLength(1)
  })

  it('deletes a memory when the user matches', () => {
    addUserMemory(make('a1', 'alice', 'alice fact'))
    expect(deleteUserMemory('a1', 'alice')).toBe(true)
    expect(listUserMemories('alice')).toHaveLength(0)
  })

  it('incrementUserMemoryUsage bumps used_count and is idempotent for missing ids', () => {
    addUserMemory(make('a1', 'alice', 'fact A', 3))
    addUserMemory(make('a2', 'alice', 'fact B', 5))
    incrementUserMemoryUsage(['a1', 'a2', 'nonexistent'])
    const byPop = listUserMemoriesByPopularity('alice', 10)
    expect(byPop.find((m) => m.id === 'a1')?.usedCount).toBe(4)
    expect(byPop.find((m) => m.id === 'a2')?.usedCount).toBe(6)
  })

  it('incrementUserMemoryUsage handles an empty list without error', () => {
    expect(() => incrementUserMemoryUsage([])).not.toThrow()
  })
})

describe('memoriesRepo — doc_memories', () => {
  it('isolates doc memories by (doc, user)', () => {
    addDocMemory({ id: 'd1', docId: 'docA', userId: 'alice', fact: 'A.alice', createdAt: 1 })
    addDocMemory({ id: 'd2', docId: 'docA', userId: 'bob', fact: 'A.bob', createdAt: 2 })
    addDocMemory({ id: 'd3', docId: 'docB', userId: 'alice', fact: 'B.alice', createdAt: 3 })
    expect(listDocMemories('docA', 'alice').map((m) => m.fact)).toEqual(['A.alice'])
    expect(listDocMemories('docA', 'bob').map((m) => m.fact)).toEqual(['A.bob'])
    expect(listDocMemories('docB', 'alice').map((m) => m.fact)).toEqual(['B.alice'])
  })

  it('cascades doc memories when the parent doc is deleted', () => {
    addDocMemory({ id: 'd1', docId: 'docA', userId: 'alice', fact: 'A.alice', createdAt: 1 })
    addDocMemory({ id: 'd2', docId: 'docB', userId: 'alice', fact: 'B.alice', createdAt: 2 })
    db().prepare(`DELETE FROM documents WHERE id = 'docA'`).run()
    expect(listDocMemories('docA', 'alice')).toEqual([])
    expect(listDocMemories('docB', 'alice')).toHaveLength(1)
  })

  it('refuses to delete cross-doc or cross-user', () => {
    addDocMemory({ id: 'd1', docId: 'docA', userId: 'alice', fact: 'A.alice', createdAt: 1 })
    expect(deleteDocMemory('d1', 'docB', 'alice')).toBe(false)
    expect(deleteDocMemory('d1', 'docA', 'bob')).toBe(false)
    expect(listDocMemories('docA', 'alice')).toHaveLength(1)
  })

  it('deletes when (id, doc, user) all match', () => {
    addDocMemory({ id: 'd1', docId: 'docA', userId: 'alice', fact: 'A.alice', createdAt: 1 })
    expect(deleteDocMemory('d1', 'docA', 'alice')).toBe(true)
    expect(listDocMemories('docA', 'alice')).toEqual([])
  })
})

describe('memoriesRepo — chat_error_notes', () => {
  const note = (overrides: Partial<Parameters<typeof addChatErrorNote>[0]>) => {
    addChatErrorNote({
      id: overrides.id ?? Math.random().toString(36).slice(2),
      userId: overrides.userId ?? 'alice',
      docId: overrides.docId ?? null,
      question: overrides.question ?? 'what is X?',
      wrongAnswer: overrides.wrongAnswer ?? null,
      correction: overrides.correction ?? 'X is Y',
      createdAt: overrides.createdAt ?? Date.now(),
    })
  }

  it('returns recent notes for the user, newest first', () => {
    note({ id: 'old', question: 'old q', createdAt: 1 })
    note({ id: 'mid', question: 'mid q', createdAt: 2 })
    note({ id: 'new', question: 'new q', createdAt: 3 })
    const out = listRecentErrorNotes('alice', 10).map((n) => n.id)
    expect(out).toEqual(['new', 'mid', 'old'])
  })

  it('caps to the requested limit', () => {
    for (let i = 0; i < 10; i++) note({ id: `n${i}`, createdAt: i })
    expect(listRecentErrorNotes('alice', 3)).toHaveLength(3)
  })

  it('isolates notes by user', () => {
    note({ id: 'a1', userId: 'alice', question: 'alice q' })
    note({ id: 'b1', userId: 'bob', question: 'bob q' })
    expect(listRecentErrorNotes('alice', 10).map((n) => n.question)).toEqual(['alice q'])
  })

  it('sets doc_id to NULL when the linked doc is deleted (not cascade-delete)', () => {
    // A failure note's correction is valuable even if its anchor
    // doc is gone — the user might have learned something general
    // from the correction. Migration uses ON DELETE SET NULL.
    note({ id: 'a1', docId: 'docA' })
    db().prepare(`DELETE FROM documents WHERE id = 'docA'`).run()
    const out = listRecentErrorNotes('alice', 10)
    expect(out).toHaveLength(1)
    expect(out[0].docId).toBeNull()
  })

  it('refuses to delete a note belonging to another user', () => {
    note({ id: 'a1', userId: 'alice' })
    expect(deleteChatErrorNote('a1', 'bob')).toBe(false)
    expect(listRecentErrorNotes('alice', 10)).toHaveLength(1)
  })
})
