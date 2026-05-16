import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { addPin, isPinned, listPins, removePin } from './pins.js'

const originalData = config.dataDir

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-pins-'))
  ;(config as { dataDir: string }).dataDir = dir
})

afterEach(async () => {
  const dir = config.dataDir
  ;(config as { dataDir: string }).dataDir = originalData
  await rm(dir, { recursive: true, force: true })
})

describe('pins store', () => {
  it('starts empty for a new user', async () => {
    expect(await listPins('alice')).toEqual([])
  })

  it('persists a pin and reads it back', async () => {
    await addPin('alice', { owner: 'alice', storageKey: 'notes/foo.md', isFolder: false })
    const pins = await listPins('alice')
    expect(pins.length).toBe(1)
    expect(pins[0]).toMatchObject({
      owner: 'alice',
      storageKey: 'notes/foo.md',
      isFolder: false,
    })
    expect(typeof pins[0].pinnedAt).toBe('number')
  })

  it('deduplicates by (owner, storageKey) and refreshes the timestamp', async () => {
    await addPin('alice', { owner: 'alice', storageKey: 'x', isFolder: false })
    // sleep a tick so the second pin's timestamp would differ.
    await new Promise((r) => setTimeout(r, 10))
    await addPin('alice', { owner: 'alice', storageKey: 'x', isFolder: true })
    const pins = await listPins('alice')
    expect(pins.length).toBe(1)
    expect(pins[0].isFolder).toBe(true) // flag updated
  })

  it('orders pins newest first', async () => {
    await addPin('alice', { owner: 'alice', storageKey: 'a', isFolder: false })
    await new Promise((r) => setTimeout(r, 5))
    await addPin('alice', { owner: 'alice', storageKey: 'b', isFolder: false })
    const pins = await listPins('alice')
    expect(pins.map((p) => p.storageKey)).toEqual(['b', 'a'])
  })

  it('removePin only removes the matching (owner, path)', async () => {
    await addPin('alice', { owner: 'alice', storageKey: 'x', isFolder: false })
    await addPin('alice', { owner: 'bob',   storageKey: 'x', isFolder: false })
    await removePin('alice', 'alice', 'x')
    const pins = await listPins('alice')
    expect(pins.length).toBe(1)
    expect(pins[0].owner).toBe('bob')
  })

  it('isPinned reports membership without mutating', async () => {
    expect(await isPinned('alice', 'alice', 'x')).toBe(false)
    await addPin('alice', { owner: 'alice', storageKey: 'x', isFolder: false })
    expect(await isPinned('alice', 'alice', 'x')).toBe(true)
    expect(await isPinned('alice', 'alice', 'y')).toBe(false)
  })

  it('per-user pins are isolated', async () => {
    await addPin('alice', { owner: 'alice', storageKey: 'a', isFolder: false })
    await addPin('bob',   { owner: 'bob',   storageKey: 'b', isFolder: false })
    expect((await listPins('alice')).length).toBe(1)
    expect((await listPins('bob')).length).toBe(1)
  })
})
