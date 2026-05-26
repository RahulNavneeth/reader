/**
 * Phase 1 LWW sync surface — pull, push, idempotency, conflict
 * routing. Pure unit-level: stubs the bare minimum repo interactions
 * the route uses, so we can assert HTTP semantics without spinning
 * up a full app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../index.js'
import { config } from '../config.js'
import { clearSettingsCache } from '../stores/settings.js'
import { _resetDbForTest } from '../db/sqlite.js'
import { appendChange, listChangesSince, maxLsnFor } from '../db/syncChangesRepo.js'

let app: FastifyInstance
let scratch: { data: string; vault: string }
let originals: { dataDir: string; vault: string; paths: typeof config.paths }

async function scratchDirs() {
  const data = await mkdtemp(path.join(os.tmpdir(), 'reader-sync-data-'))
  const vault = await mkdtemp(path.join(os.tmpdir(), 'reader-sync-vault-'))
  return { data, vault }
}

beforeEach(async () => {
  // Drop the cached sqlite connection BEFORE we change config.dataDir
  // so the next `db()` call opens a file in our fresh tempdir
  // instead of the (now-deleted) previous one.
  _resetDbForTest()
  scratch = await scratchDirs()
  originals = {
    dataDir: config.dataDir,
    vault: config.vault.root,
    paths: { ...config.paths },
  }
  ;(config as { dataDir: string }).dataDir = scratch.data
  ;(config.vault as { root: string }).root = scratch.vault
  // (debug logging removed)
  for (const k of Object.keys(config.paths) as Array<keyof typeof config.paths>) {
    const original = originals.paths[k]
    if (typeof original !== 'string') continue
    const leaf = path.basename(original)
    ;(config.paths as Record<string, string>)[k] = path.join(scratch.data, leaf)
  }
  ;(config.signup as { allowOpen: boolean }).allowOpen = true
  clearSettingsCache()
  app = await buildApp({ skipBackground: true, silent: true })
  // buildApp -> loadSettings -> applyOverrides snaps config.vault.root
  // back to ENV.vaultRoot (the at-import-time value, ie the user's
  // real vault). Re-pin it AFTER buildApp so route handlers see the
  // tempdir we just created.
  ;(config.vault as { root: string }).root = scratch.vault
  await app.ready()
})

afterEach(async () => {
  await app.close()
  ;(config as { dataDir: string }).dataDir = originals.dataDir
  ;(config.vault as { root: string }).root = originals.vault
  Object.assign(config.paths, originals.paths)
  await rm(scratch.data, { recursive: true, force: true })
  await rm(scratch.vault, { recursive: true, force: true })
})

function cookieFromSetCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('no set-cookie header')
  return raw.split(';')[0]
}

async function signupAlice(): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { username: 'alice', password: 'password-123' },
  })
  expect(r.statusCode).toBe(200)
  return cookieFromSetCookie(r.headers['set-cookie'])
}

describe('sync repo', () => {
  it('appendChange returns monotonic lsn', () => {
    const a = appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'notes/a.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: ['x'] },
      actor: 'alice',
    })
    const b = appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'notes/b.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: ['y'] },
      actor: 'alice',
    })
    expect(b.lsn).toBeGreaterThan(a.lsn)
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(false)
  })

  it('clientOpId collision returns the original lsn marked duplicate', () => {
    const a = appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'a.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: [] },
      actor: 'alice',
      clientOpId: 'op-1',
    })
    const b = appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'a.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: [] },
      actor: 'alice',
      clientOpId: 'op-1',
    })
    expect(b.lsn).toBe(a.lsn)
    expect(b.duplicate).toBe(true)
  })

  it('listChangesSince is owner-scoped and ordered ASC', () => {
    appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'a.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: [] },
      actor: 'alice',
    })
    appendChange({
      owner: 'bob',
      entityType: 'doc',
      entityId: 'b.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: [] },
      actor: 'bob',
    })
    appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'c.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: [] },
      actor: 'alice',
    })
    const alice = listChangesSince('alice', 0, 100)
    expect(alice.map((c) => c.entityId)).toEqual(['a.md', 'c.md'])
    const bob = listChangesSince('bob', 0, 100)
    expect(bob.map((c) => c.entityId)).toEqual(['b.md'])
  })

  it('maxLsnFor returns 0 for a fresh owner', () => {
    expect(maxLsnFor('nobody')).toBe(0)
  })
})

describe('sync HTTP routes', () => {
  it('pull returns owner-scoped changes after since=lsn', async () => {
    const cookie = await signupAlice()
    // Seed a couple of changes directly through the repo so the
    // test doesn't have to drive a full mutation route.
    const first = appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'one.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: ['a'] },
      actor: 'alice',
    })
    const second = appendChange({
      owner: 'alice',
      entityType: 'doc',
      entityId: 'two.md',
      kind: 'doc.tags',
      payload: { kind: 'doc.tags', tags: ['b'] },
      actor: 'alice',
    })
    const r = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0',
      headers: { cookie },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.changes.map((c: { entityId: string }) => c.entityId)).toEqual(['one.md', 'two.md'])
    expect(body.head).toBe(second.lsn)
    expect(body.hasMore).toBe(false)

    const r2 = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since=${first.lsn}`,
      headers: { cookie },
    })
    const body2 = JSON.parse(r2.body)
    expect(body2.changes.map((c: { entityId: string }) => c.entityId)).toEqual(['two.md'])
  })

  it('pull hasMore flags when limit hits the cap', async () => {
    const cookie = await signupAlice()
    for (let i = 0; i < 4; i++) {
      appendChange({
        owner: 'alice',
        entityType: 'doc',
        entityId: `doc-${i}.md`,
        kind: 'doc.tags',
        payload: { kind: 'doc.tags', tags: [] },
        actor: 'alice',
      })
    }
    const r = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0&limit=2',
      headers: { cookie },
    })
    const body = JSON.parse(r.body)
    expect(body.changes.length).toBe(2)
    expect(body.hasMore).toBe(true)
  })

  it('push creates a new offline doc when none exists at the path', async () => {
    const cookie = await signupAlice()
    const r = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload: {
        ops: [
          {
            clientOpId: 'op-create-1',
            entityId: 'notes/offline.md',
            kind: 'doc.upsert',
            baseSha: null,
            content: '# Offline note\n\nI typed this on the plane.',
          },
        ],
      },
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.results[0]).toMatchObject({
      clientOpId: 'op-create-1',
      result: 'applied',
    })
    const onDisk = await readFile(
      path.join(config.vault.root, 'alice', 'notes/offline.md'),
      'utf8',
    )
    expect(onDisk).toMatch(/Offline note/)
  })

  it('push is idempotent: same clientOpId twice → second is duplicate', async () => {
    const cookie = await signupAlice()
    const payload = {
      ops: [
        {
          clientOpId: 'op-dup-1',
          entityId: 'notes/idem.md',
          kind: 'doc.upsert' as const,
          baseSha: null,
          content: 'hello',
        },
      ],
    }
    const first = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload,
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload,
    })
    const firstBody = JSON.parse(first.body)
    const secondBody = JSON.parse(second.body)
    expect(firstBody.results[0].result).toBe('applied')
    expect(secondBody.results[0].result).toBe('duplicate')
    expect(secondBody.results[0].lsn).toBe(firstBody.results[0].lsn)
  })

  it('push lands a conflict file when baseSha is stale', async () => {
    const cookie = await signupAlice()
    // Seed an on-disk doc via the normal vault path so meta + sha are populated.
    const dir = path.join(config.vault.root, 'alice', 'notes')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'shared.md'), 'original body')
    // Force the server to ingest it. Easiest path: hit /api/file/text
    // which triggers auto-ingest for own-vault files that aren't
    // indexed yet.
    const ingest = await app.inject({
      method: 'GET',
      url: '/api/file/text?path=notes/shared.md',
      headers: { cookie },
    })
    expect(ingest.statusCode).toBe(200)
    // Now push with a stale baseSha. The server should keep the
    // existing bytes on disk untouched and land ours to a sibling.
    const r = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload: {
        ops: [
          {
            clientOpId: 'op-conflict-1',
            entityId: 'notes/shared.md',
            kind: 'doc.upsert',
            baseSha: 'sha-from-some-stale-cache',
            content: 'offline edits from device B',
          },
        ],
      },
    })
    const body = JSON.parse(r.body)
    const res = body.results[0]
    expect(res.result).toBe('conflict')
    expect(res.conflictPath).toMatch(/notes\/shared\.conflict-\d+\.md$/)
    // Original bytes preserved.
    const original = await readFile(path.join(dir, 'shared.md'), 'utf8')
    expect(original).toBe('original body')
    // Conflict sibling has our offline content.
    const conflict = await readFile(
      path.join(config.vault.root, 'alice', res.conflictPath),
      'utf8',
    )
    expect(conflict).toBe('offline edits from device B')
  })

  it('push applies when baseSha matches the current sha', async () => {
    const cookie = await signupAlice()
    const dir = path.join(config.vault.root, 'alice', 'notes')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'apply.md'), 'starting body')
    // Ingest + fetch meta to capture the current sha256.
    await app.inject({
      method: 'GET',
      url: '/api/file/text?path=notes/apply.md',
      headers: { cookie },
    })
    const metaRes = await app.inject({
      method: 'GET',
      url: '/api/file/meta?path=notes/apply.md',
      headers: { cookie },
    })
    const meta = JSON.parse(metaRes.body).meta
    const r = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload: {
        ops: [
          {
            clientOpId: 'op-apply-1',
            entityId: 'notes/apply.md',
            kind: 'doc.upsert',
            baseSha: meta.sha256,
            content: 'updated body — offline edit',
          },
        ],
      },
    })
    const body = JSON.parse(r.body)
    expect(body.results[0].result).toBe('applied')
    const onDisk = await readFile(path.join(dir, 'apply.md'), 'utf8')
    expect(onDisk).toBe('updated body — offline edit')
  })

  it('push doc.archive flips meta and surfaces in pull', async () => {
    const cookie = await signupAlice()
    const dir = path.join(config.vault.root, 'alice', 'notes')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'archiveme.md'), 'body')
    await app.inject({
      method: 'GET',
      url: '/api/file/text?path=notes/archiveme.md',
      headers: { cookie },
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload: {
        ops: [
          {
            clientOpId: 'op-arch-1',
            entityId: 'notes/archiveme.md',
            kind: 'doc.archive',
            archived: true,
          },
        ],
      },
    })
    expect(JSON.parse(r.body).results[0].result).toBe('applied')
    const pull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0',
      headers: { cookie },
    })
    const archiveChange = JSON.parse(pull.body).changes.find(
      (c: { entityId: string; kind: string }) =>
        c.entityId === 'notes/archiveme.md' && c.kind === 'doc.archive',
    )
    expect(archiveChange).toBeTruthy()
    expect(archiveChange.payload.archived).toBe(true)
  })

  it('pull requires auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/sync/pull?since=0' })
    expect(r.statusCode).toBe(401)
  })

  it('push requires auth', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { 'content-type': 'application/json' },
      payload: { ops: [] },
    })
    expect(r.statusCode).toBe(401)
  })
})

