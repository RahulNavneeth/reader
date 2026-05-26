/**
 * Phase 2 CRDT relay smoke tests. We don't run a real WebSocket
 * handshake in jsdom-free vitest; the goal here is to verify
 * the Y.Doc registry's lease/release lifecycle + the persistence
 * round-trip. The HTTP-side WebSocket route gets exercised by hand
 * via a node script in `scripts/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { config } from '../config.js'
import { clearSettingsCache } from '../stores/settings.js'
import { _resetDbForTest } from '../db/sqlite.js'
import { runMigrations } from '../db/migrations.js'
import { loadCrdtState, saveCrdtState } from '../db/crdtRepo.js'
import {
  _registryStats,
  _resetForTest,
  flushAll,
  leaseDoc,
} from '../services/crdtRegistry.js'
import { saveMeta } from '../stores/documents.js'
import type { DocumentMeta } from '../types.js'

let scratch: { data: string; vault: string }
let originals: { dataDir: string; vault: string; paths: typeof config.paths }

beforeEach(async () => {
  _resetForTest()
  _resetDbForTest()
  scratch = {
    data: await mkdtemp(path.join(os.tmpdir(), 'reader-crdt-data-')),
    vault: await mkdtemp(path.join(os.tmpdir(), 'reader-crdt-vault-')),
  }
  originals = {
    dataDir: config.dataDir,
    vault: config.vault.root,
    paths: { ...config.paths },
  }
  ;(config as { dataDir: string }).dataDir = scratch.data
  ;(config.vault as { root: string }).root = scratch.vault
  for (const k of Object.keys(config.paths) as Array<keyof typeof config.paths>) {
    const original = originals.paths[k]
    if (typeof original !== 'string') continue
    ;(config.paths as Record<string, string>)[k] = path.join(
      scratch.data,
      path.basename(original),
    )
  }
  clearSettingsCache()
  runMigrations()
})

afterEach(async () => {
  flushAll()
  _resetForTest()
  ;(config as { dataDir: string }).dataDir = originals.dataDir
  ;(config.vault as { root: string }).root = originals.vault
  Object.assign(config.paths, originals.paths)
  await rm(scratch.data, { recursive: true, force: true })
  await rm(scratch.vault, { recursive: true, force: true })
})

async function seedDoc(id: string): Promise<DocumentMeta> {
  const meta = {
    id,
    owner: 'alice',
    storageKey: `${id}.md`,
    title: id,
    originalFilename: `${id}.md`,
    mime: 'text/markdown',
    bytes: 0,
    sha256: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acl: { readers: [], editors: [] },
    tags: [],
    ingest: { status: 'pending', embedded: false },
  } as unknown as DocumentMeta
  await saveMeta(meta)
  return meta
}

describe('crdtRepo', () => {
  it('returns null state for an unseeded doc', async () => {
    await seedDoc('docA')
    expect(loadCrdtState('docA')).toEqual({
      state: null,
      stateVector: null,
      materialisedAt: null,
    })
  })

  it('persists and reloads a Y.Doc state', async () => {
    await seedDoc('docB')
    const doc = new Y.Doc()
    const text = doc.getText('body')
    text.insert(0, 'hello world')
    saveCrdtState(
      'docB',
      Y.encodeStateAsUpdate(doc),
      Y.encodeStateVector(doc),
    )
    const snapshot = loadCrdtState('docB')
    expect(snapshot.state).toBeTruthy()
    expect(snapshot.stateVector).toBeTruthy()
    // Reconstruct in a fresh Y.Doc and verify text matches.
    const fresh = new Y.Doc()
    Y.applyUpdate(fresh, new Uint8Array(snapshot.state!))
    expect(fresh.getText('body').toString()).toBe('hello world')
  })
})

describe('crdtRegistry', () => {
  it('lazy-creates a Y.Doc on first lease', async () => {
    await seedDoc('docC')
    expect(_registryStats().docs).toBe(0)
    const { doc, release } = leaseDoc('docC')
    expect(_registryStats().docs).toBe(1)
    expect(doc).toBeDefined()
    release()
  })

  it('hydrates from persisted state on second lease', async () => {
    await seedDoc('docD')
    // First lease — seed it with content + flush.
    const a = leaseDoc('docD')
    a.doc.getText('body').insert(0, 'seeded text')
    flushAll()
    a.release()
    _resetForTest() // drop in-memory; force a hydrate from DB.
    const b = leaseDoc('docD')
    expect(b.doc.getText('body').toString()).toBe('seeded text')
    b.release()
  })

  it('refcounts concurrent leases — both must release before flush eligibility', async () => {
    await seedDoc('docE')
    const a = leaseDoc('docE')
    const b = leaseDoc('docE')
    expect(_registryStats().attachments).toBe(2)
    a.release()
    expect(_registryStats().attachments).toBe(1)
    b.release()
    expect(_registryStats().attachments).toBe(0)
  })

  it('idempotent release', async () => {
    await seedDoc('docF')
    const a = leaseDoc('docF')
    a.release()
    a.release()
    expect(_registryStats().attachments).toBe(0)
  })

  it('flushAll persists every dirty doc', async () => {
    await seedDoc('docG')
    const a = leaseDoc('docG')
    a.doc.getText('body').insert(0, 'flushed')
    flushAll()
    const snap = loadCrdtState('docG')
    expect(snap.state).toBeTruthy()
    a.release()
  })

  it('broadcasts updates to peers sharing the same lease', async () => {
    // Two leases against the same docId share the SAME Y.Doc; an
    // update on one is observable on the other. This is what
    // makes the WebSocket relay work — the registry hands every
    // attached client the same in-memory instance.
    await seedDoc('docH')
    const a = leaseDoc('docH')
    const b = leaseDoc('docH')
    expect(a.doc).toBe(b.doc)
    a.doc.getText('body').insert(0, 'shared')
    expect(b.doc.getText('body').toString()).toBe('shared')
    a.release()
    b.release()
  })
})
