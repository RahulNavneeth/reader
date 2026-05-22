import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createThread,
  deleteThread,
  deriveTitleFromMessage,
  getThread,
  listThreads,
  maybeAutoTitleFromMessage,
  renameThread,
  touchThread,
} from './threadsRepo.js'
import { appendMessage } from './chatRepo.js'
import { config } from '../config.js'
import { db, _resetDbForTest } from './sqlite.js'
import { runMigrations } from './migrations.js'

const originalData = config.dataDir

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-threads-'))
  ;(config as { dataDir: string }).dataDir = dir
  _resetDbForTest()
  runMigrations()
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

describe('threadsRepo', () => {
  it('creates a thread with default title and timestamps', () => {
    const t = createThread({ id: 't1', docId: 'docA', userId: 'alice' })
    expect(t.title).toBe('New chat')
    expect(t.createdAt).toBeGreaterThan(0)
    expect(t.updatedAt).toBe(t.createdAt)
  })

  it('lists threads most-recent-first per (doc, user)', () => {
    const base = Date.now()
    createThread({ id: 't1', docId: 'docA', userId: 'alice', createdAt: base })
    createThread({ id: 't2', docId: 'docA', userId: 'alice', createdAt: base + 10 })
    createThread({ id: 't3', docId: 'docA', userId: 'alice', createdAt: base + 20 })
    const list = listThreads('docA', 'alice')
    expect(list.map((t) => t.id)).toEqual(['t3', 't2', 't1'])
  })

  it('scopes by user — alice does not see bob threads', () => {
    createThread({ id: 'alice1', docId: 'docA', userId: 'alice' })
    createThread({ id: 'bob1', docId: 'docA', userId: 'bob' })
    const list = listThreads('docA', 'alice')
    expect(list.map((t) => t.id)).toEqual(['alice1'])
  })

  it('scopes by doc — docA threads do not appear under docB', () => {
    createThread({ id: 'a-on-a', docId: 'docA', userId: 'alice' })
    createThread({ id: 'a-on-b', docId: 'docB', userId: 'alice' })
    expect(listThreads('docA', 'alice').map((t) => t.id)).toEqual(['a-on-a'])
    expect(listThreads('docB', 'alice').map((t) => t.id)).toEqual(['a-on-b'])
  })

  it('getThread is scoped to the requesting user', () => {
    createThread({ id: 't1', docId: 'docA', userId: 'alice' })
    expect(getThread('t1', 'alice')?.id).toBe('t1')
    expect(getThread('t1', 'bob')).toBeNull()
  })

  it('renames a thread and refuses cross-user', () => {
    createThread({ id: 't1', docId: 'docA', userId: 'alice' })
    expect(renameThread('t1', 'alice', 'docA', 'Tax planning')).toBe(true)
    expect(getThread('t1', 'alice')?.title).toBe('Tax planning')
    expect(renameThread('t1', 'bob', 'docA', 'evil')).toBe(false)
    expect(getThread('t1', 'alice')?.title).toBe('Tax planning')
  })

  it('rejects an empty rename', () => {
    createThread({ id: 't1', docId: 'docA', userId: 'alice' })
    expect(renameThread('t1', 'alice', 'docA', '   ')).toBe(false)
    expect(getThread('t1', 'alice')?.title).toBe('New chat')
  })

  it('deleteThread cascades to that thread\'s messages', () => {
    createThread({ id: 't1', docId: 'docA', userId: 'alice' })
    appendMessage({
      id: 'm1', docId: 'docA', userId: 'alice', threadId: 't1',
      role: 'user', content: 'q', citations: null, memoriesUsed: null,
      error: null, pendingEdit: null, editAppliedAt: null,
      editTargetSha256: null, toolTrace: null, createdAt: Date.now(),
    })
    expect(deleteThread('t1', 'alice', 'docA')).toBe(true)
    expect(getThread('t1', 'alice')).toBeNull()
    // Messages should have been deleted too.
    const cnt = (db()
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?`)
      .get('t1') as { n: number }).n
    expect(cnt).toBe(0)
  })

  it('touchThread bumps updated_at so the thread floats to top', async () => {
    // Spread the creation timestamps so touchThread's Date.now()
    // unambiguously lands later than t2's updated_at, even on
    // systems where Date.now() resolution is 1 ms.
    const base = Date.now() - 1_000_000
    createThread({ id: 't1', docId: 'docA', userId: 'alice', createdAt: base })
    createThread({ id: 't2', docId: 'docA', userId: 'alice', createdAt: base + 100 })
    expect(listThreads('docA', 'alice').map((t) => t.id)).toEqual(['t2', 't1'])
    touchThread('t1', 'alice', 'docA')
    expect(listThreads('docA', 'alice').map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('maybeAutoTitleFromMessage replaces the default title only', () => {
    createThread({ id: 't1', docId: 'docA', userId: 'alice' })
    maybeAutoTitleFromMessage('t1', 'alice', 'docA', 'rephrase the Risks section')
    expect(getThread('t1', 'alice')?.title).toBe('Rephrase the Risks section')
    // User renames it explicitly — a later message shouldn't clobber.
    renameThread('t1', 'alice', 'docA', 'My custom name')
    maybeAutoTitleFromMessage('t1', 'alice', 'docA', 'another question entirely')
    expect(getThread('t1', 'alice')?.title).toBe('My custom name')
  })
})

describe('deriveTitleFromMessage', () => {
  it('uses the user\'s freeform line, sentence-cased and capped', () => {
    expect(deriveTitleFromMessage('summarize this doc')).toBe('Summarize this doc')
  })

  it('strips a leading Reply-popover blockquote and uses the question', () => {
    const msg = `> "Some excerpt"\n\nrephrase this`
    expect(deriveTitleFromMessage(msg)).toBe('Rephrase this')
  })

  it('caps at ~60 chars with an ellipsis', () => {
    const long = 'a'.repeat(80)
    const out = deriveTitleFromMessage(long)
    expect(out!.length).toBeLessThanOrEqual(61)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('returns null on empty / whitespace-only input', () => {
    expect(deriveTitleFromMessage('')).toBeNull()
    expect(deriveTitleFromMessage('   ')).toBeNull()
  })
})
