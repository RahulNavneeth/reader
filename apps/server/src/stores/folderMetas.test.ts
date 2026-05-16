import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import {
  deleteFolderMeta,
  freshFolderMeta,
  getFolderMeta,
  listFolderMetas,
  saveFolderMeta,
  sweepExpiredPublicFolders,
} from './folderMetas.js'

const original = config.paths.folderMetas

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-folder-metas-'))
  ;(config.paths as { folderMetas: string }).folderMetas = dir
})

afterEach(async () => {
  const dir = config.paths.folderMetas
  ;(config.paths as { folderMetas: string }).folderMetas = original
  await rm(dir, { recursive: true, force: true })
})

describe('folderMetas store', () => {
  it('returns null for an unknown folder', async () => {
    expect(await getFolderMeta('alice', 'notes')).toBeNull()
  })

  it('persists and reads back a folder meta', async () => {
    const m = freshFolderMeta('alice', 'investments')
    m.tags = ['finance']
    m.public = true
    await saveFolderMeta(m)
    const got = await getFolderMeta('alice', 'investments')
    expect(got).toMatchObject({
      owner: 'alice',
      storageKey: 'investments',
      tags: ['finance'],
      public: true,
    })
  })

  it('deletes a folder meta', async () => {
    await saveFolderMeta(freshFolderMeta('alice', 'x'))
    expect(await getFolderMeta('alice', 'x')).not.toBeNull()
    await deleteFolderMeta('alice', 'x')
    expect(await getFolderMeta('alice', 'x')).toBeNull()
  })

  it('lists per-owner', async () => {
    await saveFolderMeta(freshFolderMeta('alice', 'a'))
    await saveFolderMeta(freshFolderMeta('alice', 'b'))
    await saveFolderMeta(freshFolderMeta('bob', 'c'))
    expect((await listFolderMetas('alice')).length).toBe(2)
    expect((await listFolderMetas('bob')).length).toBe(1)
    expect((await listFolderMetas()).length).toBe(3)
  })

  describe('sweepExpiredPublicFolders', () => {
    it('flips expired public folders to private', async () => {
      const past = freshFolderMeta('alice', 'old')
      past.public = true
      past.publicExpiresAt = Date.now() - 1000
      await saveFolderMeta(past)
      const fresh = freshFolderMeta('alice', 'new')
      fresh.public = true
      fresh.publicExpiresAt = Date.now() + 60_000
      await saveFolderMeta(fresh)

      const flipped = await sweepExpiredPublicFolders()
      expect(flipped).toBe(1)
      expect((await getFolderMeta('alice', 'old'))?.public).toBe(false)
      expect((await getFolderMeta('alice', 'new'))?.public).toBe(true)
    })

    it('does nothing when no metas are expired', async () => {
      const fresh = freshFolderMeta('alice', 'k')
      fresh.public = true
      fresh.publicExpiresAt = Date.now() + 60_000
      await saveFolderMeta(fresh)
      expect(await sweepExpiredPublicFolders()).toBe(0)
    })
  })

  it('safeKey encodes special characters so meta files are filesystem-safe', async () => {
    // Folder path with slashes — store turns them into __ in the filename.
    const m = freshFolderMeta('alice', 'a/b/c')
    await saveFolderMeta(m)
    const got = await getFolderMeta('alice', 'a/b/c')
    expect(got?.storageKey).toBe('a/b/c')
  })
})
