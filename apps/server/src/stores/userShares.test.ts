import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import {
  createUserShare,
  deleteUserShare,
  findShareForPath,
  getUserShare,
  listAllUserShares,
  listSharesFrom,
  listSharesTo,
} from './userShares.js'

// Each test gets its own scratch user-shares dir so they can run in
// parallel and not see each other's records. The store reads/writes
// `config.paths.userShares`, which we point at a tempdir per-test
// and restore afterward.
const originalPath = config.paths.userShares

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-shares-'))
  ;(config.paths as { userShares: string }).userShares = dir
})

afterEach(async () => {
  const dir = config.paths.userShares
  ;(config.paths as { userShares: string }).userShares = originalPath
  await rm(dir, { recursive: true, force: true })
})

describe('userShares store', () => {
  it('creates a share and reads it back by id', async () => {
    const s = await createUserShare({
      owner: 'alice',
      recipient: 'bob',
      storageKey: 'notes/foo.md',
      isFolder: false,
      canEdit: false,
    })
    const fetched = await getUserShare(s.id)
    expect(fetched).toMatchObject({
      owner: 'alice',
      recipient: 'bob',
      storageKey: 'notes/foo.md',
      isFolder: false,
      canEdit: false,
    })
  })

  it('dedupes by (owner, recipient, storageKey) — re-share updates in place', async () => {
    const a = await createUserShare({
      owner: 'alice', recipient: 'bob', storageKey: 'x/y.md',
      isFolder: false, canEdit: false,
    })
    const b = await createUserShare({
      owner: 'alice', recipient: 'bob', storageKey: 'x/y.md',
      isFolder: false, canEdit: true, label: 'updated',
    })
    expect(a.id).toBe(b.id)
    expect(b.canEdit).toBe(true)
    expect(b.label).toBe('updated')
    const all = await listAllUserShares()
    expect(all.length).toBe(1)
  })

  it('lists shares filtered by owner and by recipient', async () => {
    await createUserShare({ owner: 'alice', recipient: 'bob', storageKey: 'a', isFolder: false, canEdit: false })
    await createUserShare({ owner: 'alice', recipient: 'carol', storageKey: 'b', isFolder: false, canEdit: false })
    await createUserShare({ owner: 'dave', recipient: 'bob', storageKey: 'c', isFolder: false, canEdit: false })
    expect((await listSharesFrom('alice')).length).toBe(2)
    expect((await listSharesTo('bob')).length).toBe(2)
    expect((await listSharesTo('eve')).length).toBe(0)
  })

  it('deletes a share', async () => {
    const s = await createUserShare({
      owner: 'a', recipient: 'b', storageKey: 'x', isFolder: false, canEdit: false,
    })
    expect(await deleteUserShare(s.id)).toBe(true)
    expect(await getUserShare(s.id)).toBeNull()
  })

  describe('findShareForPath', () => {
    it('matches an exact file share', async () => {
      await createUserShare({
        owner: 'alice', recipient: 'bob', storageKey: 'notes/foo.md',
        isFolder: false, canEdit: false,
      })
      const grant = await findShareForPath('bob', 'alice', 'notes/foo.md')
      expect(grant?.storageKey).toBe('notes/foo.md')
    })

    it('matches a folder ancestor (subtree share cascades)', async () => {
      await createUserShare({
        owner: 'alice', recipient: 'bob', storageKey: 'investments',
        isFolder: true, canEdit: false,
      })
      expect(await findShareForPath('bob', 'alice', 'investments/cdsl/x.pdf')).not.toBeNull()
      expect(await findShareForPath('bob', 'alice', 'investments')).not.toBeNull()
    })

    it('does NOT match a folder share for a sibling path', async () => {
      await createUserShare({
        owner: 'alice', recipient: 'bob', storageKey: 'a/b',
        isFolder: true, canEdit: false,
      })
      // 'a/bc' is NOT under 'a/b'.
      expect(await findShareForPath('bob', 'alice', 'a/bc')).toBeNull()
    })

    it('does NOT match cross-owner shares (alice→bob ≠ dave→bob)', async () => {
      await createUserShare({
        owner: 'alice', recipient: 'bob', storageKey: 'x.md',
        isFolder: false, canEdit: false,
      })
      expect(await findShareForPath('bob', 'dave', 'x.md')).toBeNull()
    })

    it('does NOT match for a non-recipient', async () => {
      await createUserShare({
        owner: 'alice', recipient: 'bob', storageKey: 'x.md',
        isFolder: false, canEdit: false,
      })
      expect(await findShareForPath('carol', 'alice', 'x.md')).toBeNull()
    })

    it('whole-vault share (storageKey === "") cascades to everything', async () => {
      await createUserShare({
        owner: 'alice', recipient: 'bob', storageKey: '',
        isFolder: true, canEdit: true,
      })
      const g = await findShareForPath('bob', 'alice', 'any/path/here.md')
      expect(g?.canEdit).toBe(true)
    })
  })
})
