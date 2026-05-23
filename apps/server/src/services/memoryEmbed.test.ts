import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { db, _resetDbForTest } from '../db/sqlite.js'
import { runMigrations } from '../db/migrations.js'
import {
  addUserMemory,
  addDocMemory,
  listUserMemories,
  listDocMemories,
} from '../db/memoriesRepo.js'
import * as embedModule from './embed.js'
import { EmbedError } from './embed.js'
import {
  embedMemoryFact,
  backfillMissingMemoryEmbeddings,
} from './memoryEmbed.js'

const originalData = config.dataDir

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-memembed-'))
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

/**
 * Tests for the memory embedding service. The embed call is stubbed
 * via vi.spyOn on the imported embed module so we never hit Ollama
 * from CI. We exercise:
 *
 *   • embedMemoryFact happy path + empty input + null vec.
 *   • backfill picks up only rows with NULL embeddings.
 *   • backfill swallows EmbedError so a stopped Ollama doesn't
 *     bring down the server boot path.
 *   • backfill batches in chunks of 32 (regression guard: a
 *     single user with 50 memories shouldn't send 50 round-trips).
 */
describe('embedMemoryFact', () => {
  it('returns null for whitespace-only input', async () => {
    expect(await embedMemoryFact('   ')).toBeNull()
  })

  it('returns a Float32Array on a non-empty fact', async () => {
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[0.1, 0.2, 0.3]])
    const vec = await embedMemoryFact('a useful fact')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec!.length).toBe(3)
    expect(vec![0]).toBeCloseTo(0.1, 4)
    expect(vec![2]).toBeCloseTo(0.3, 4)
  })

  it('returns null when embed returns an empty vector', async () => {
    vi.spyOn(embedModule, 'embedBatch').mockResolvedValue([[]])
    expect(await embedMemoryFact('anything')).toBeNull()
  })

  it('propagates an EmbedError to the caller', async () => {
    // Memory create paths catch this themselves and fall through
    // to a NULL row, but embedMemoryFact itself shouldn't swallow.
    vi.spyOn(embedModule, 'embedBatch').mockRejectedValue(new EmbedError('offline'))
    await expect(embedMemoryFact('x')).rejects.toThrow('offline')
  })
})

describe('backfillMissingMemoryEmbeddings', () => {
  it('returns 0/0 counts when no memories are missing embeddings', async () => {
    const out = await backfillMissingMemoryEmbeddings()
    expect(out).toEqual({
      user: { attempted: 0, succeeded: 0 },
      doc: { attempted: 0, succeeded: 0 },
    })
  })

  it('processes only user+doc rows whose embedding is NULL', async () => {
    addUserMemory({
      id: 'u1', userId: 'alice', fact: 'fact one',
      source: 'user_command', createdAt: Date.now(), alwaysInject: false,
    })
    addUserMemory({
      id: 'u2', userId: 'alice', fact: 'fact two',
      source: 'user_command', createdAt: Date.now(), alwaysInject: false,
    })
    addDocMemory({
      id: 'd1', docId: 'docA', userId: 'alice', fact: 'doc fact',
      createdAt: Date.now(), alwaysInject: false,
    })
    vi.spyOn(embedModule, 'embedBatch').mockImplementation(
      async (inputs: string[]) => inputs.map(() => [0.5, 0.6]),
    )
    const out = await backfillMissingMemoryEmbeddings()
    expect(out.user.attempted).toBe(2)
    expect(out.user.succeeded).toBe(2)
    expect(out.doc.attempted).toBe(1)
    expect(out.doc.succeeded).toBe(1)

    expect(listUserMemories('alice').every((r) => r.embedding != null)).toBe(true)
    expect(listDocMemories('docA', 'alice').every((r) => r.embedding != null)).toBe(true)
  })

  it('swallows EmbedError so server boot continues', async () => {
    addUserMemory({
      id: 'u-err', userId: 'alice', fact: 'fact',
      source: 'user_command', createdAt: Date.now(), alwaysInject: false,
    })
    vi.spyOn(embedModule, 'embedBatch').mockRejectedValue(new EmbedError('ollama offline'))
    // Should NOT throw — that's the contract.
    const out = await backfillMissingMemoryEmbeddings()
    expect(out.user.attempted).toBe(1)
    expect(out.user.succeeded).toBe(0)
  })

  it('lets a non-EmbedError bubble (caller can decide)', async () => {
    addUserMemory({
      id: 'u-throw', userId: 'alice', fact: 'fact',
      source: 'user_command', createdAt: Date.now(), alwaysInject: false,
    })
    vi.spyOn(embedModule, 'embedBatch').mockRejectedValue(new Error('unexpected'))
    await expect(backfillMissingMemoryEmbeddings()).rejects.toThrow('unexpected')
  })

  it('batches in chunks of 32', async () => {
    for (let i = 0; i < 40; i++) {
      addUserMemory({
        id: `u-${i}`, userId: 'alice', fact: `fact ${i}`,
        source: 'user_command', createdAt: Date.now(), alwaysInject: false,
      })
    }
    const calls: number[] = []
    vi.spyOn(embedModule, 'embedBatch').mockImplementation(
      async (inputs: string[]) => {
        calls.push(inputs.length)
        return inputs.map(() => [1, 0])
      },
    )
    const out = await backfillMissingMemoryEmbeddings()
    expect(out.user.attempted).toBe(40)
    expect(out.user.succeeded).toBe(40)
    expect(calls).toEqual([32, 8])
  })

  it('counts only rows whose embed call returned a usable vector', async () => {
    // Two rows; the embed backend returns one good vec and one
    // empty (e.g. tokenizer dropped it all). attempted=2 but
    // succeeded=1.
    addUserMemory({
      id: 'u-ok', userId: 'alice', fact: 'good',
      source: 'user_command', createdAt: Date.now(), alwaysInject: false,
    })
    addUserMemory({
      id: 'u-empty', userId: 'alice', fact: 'meh',
      source: 'user_command', createdAt: Date.now(), alwaysInject: false,
    })
    vi.spyOn(embedModule, 'embedBatch').mockImplementation(
      async () => [[0.1, 0.2], []],
    )
    const out = await backfillMissingMemoryEmbeddings()
    expect(out.user.attempted).toBe(2)
    expect(out.user.succeeded).toBe(1)
  })
})
