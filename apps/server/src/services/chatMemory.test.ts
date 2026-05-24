import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { db, _resetDbForTest } from '../db/sqlite.js'
import { runMigrations } from '../db/migrations.js'
import { appendMessage } from '../db/chatRepo.js'
import * as embedModule from './embed.js'
import { EmbedError } from './embed.js'
import { embedMessageForStorage, findRelevantPastMessages } from './chatMemory.js'

const originalData = config.dataDir

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-chatmem-'))
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
})

afterEach(async () => {
  const dir = config.dataDir
  ;(config as { dataDir: string }).dataDir = originalData
  _resetDbForTest()
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Helper: persist a chat message with a hand-crafted embedding so
 *  we can control cosine outcomes deterministically in tests. */
function seedMessage(opts: {
  id: string
  role: 'user' | 'assistant'
  content: string
  embedding: number[] | null
  createdAt?: number
}) {
  appendMessage(
    {
      id: opts.id,
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      role: opts.role,
      content: opts.content,
      citations: null,
      memoriesUsed: null,
      pendingEdit: null,
      editAppliedAt: null,
      editTargetSha256: null,
      toolTrace: null,
      error: null,
      createdAt: opts.createdAt ?? Date.now(),
    },
    opts.embedding ? Float32Array.from(opts.embedding) : null,
  )
}

describe('embedMessageForStorage', () => {
  it('returns a Float32Array when Ollama responds', async () => {
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[0.1, 0.2, 0.3]])
    const v = await embedMessageForStorage('hello')
    expect(v).toBeInstanceOf(Float32Array)
    expect(Array.from(v!)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ])
  })

  it('returns null for empty / whitespace-only content', async () => {
    const v = await embedMessageForStorage('   ')
    expect(v).toBeNull()
  })

  it('swallows EmbedError and returns null', async () => {
    vi.spyOn(embedModule, 'embedBatch').mockRejectedValue(new EmbedError('offline'))
    const v = await embedMessageForStorage('hello')
    expect(v).toBeNull()
  })

  it('returns null when Ollama hands back an empty vector', async () => {
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[]])
    const v = await embedMessageForStorage('hello')
    expect(v).toBeNull()
  })
})

describe('findRelevantPastMessages', () => {
  it('returns [] when no embedded messages exist in the thread', async () => {
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[1, 0, 0]])
    const r = await findRelevantPastMessages({
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      query: 'anything',
    })
    expect(r).toEqual([])
  })

  it('returns top-K matches above the cosine floor in chronological order', async () => {
    // Seed three messages with embeddings of varying alignment to
    // the query vector [1, 0, 0]. Highest similarity should win,
    // but results render oldest-first for prompt readability.
    seedMessage({ id: 'm1', role: 'user', content: 'oldest match', embedding: [0.9, 0.1, 0], createdAt: 1_000 })
    seedMessage({ id: 'm2', role: 'assistant', content: 'middle low', embedding: [0.1, 0.9, 0], createdAt: 2_000 })
    seedMessage({ id: 'm3', role: 'user', content: 'newest match', embedding: [0.95, 0.05, 0], createdAt: 3_000 })
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[1, 0, 0]])
    const r = await findRelevantPastMessages({
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      query: 'q',
      topK: 2,
    })
    expect(r).toHaveLength(2)
    // Chronological order in output (m1 before m3) even though m3
    // has the higher cosine.
    expect(r.map((m) => m.id)).toEqual(['m1', 'm3'])
    // m2's cosine is below 0.55, so it's dropped.
  })

  it('excludes messages already in the recent window', async () => {
    seedMessage({ id: 'old', role: 'user', content: 'old match', embedding: [1, 0, 0], createdAt: 1_000 })
    seedMessage({ id: 'recent', role: 'user', content: 'recent match', embedding: [1, 0, 0], createdAt: 2_000 })
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[1, 0, 0]])
    const r = await findRelevantPastMessages({
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      query: 'q',
      excludeIds: new Set(['recent']),
    })
    expect(r.map((m) => m.id)).toEqual(['old'])
  })

  it('skips messages whose embedding was never persisted', async () => {
    seedMessage({ id: 'embedded', role: 'user', content: 'with vec', embedding: [1, 0, 0] })
    seedMessage({ id: 'plain', role: 'user', content: 'no vec', embedding: null })
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[1, 0, 0]])
    const r = await findRelevantPastMessages({
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      query: 'q',
    })
    expect(r.map((m) => m.id)).toEqual(['embedded'])
  })

  it('returns [] when the query embedding fails', async () => {
    seedMessage({ id: 'm', role: 'user', content: 'x', embedding: [1, 0, 0] })
    vi.spyOn(embedModule, 'embedBatch').mockRejectedValue(new EmbedError('offline'))
    const r = await findRelevantPastMessages({
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      query: 'q',
    })
    expect(r).toEqual([])
  })

  it('filters out anything below the cosine floor', async () => {
    // Orthogonal vector → cosine 0 → dropped.
    seedMessage({ id: 'unrelated', role: 'user', content: 'x', embedding: [0, 1, 0] })
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[1, 0, 0]])
    const r = await findRelevantPastMessages({
      docId: 'docA',
      userId: 'alice',
      threadId: 't1',
      query: 'q',
    })
    expect(r).toEqual([])
  })
})
