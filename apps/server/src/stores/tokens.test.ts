import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { createToken, deleteToken, findTokenBySecret, hashToken, listTokens } from './tokens.js'

const original = config.paths.tokens

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-tokens-'))
  ;(config.paths as { tokens: string }).tokens = dir
})

afterEach(async () => {
  const dir = config.paths.tokens
  ;(config.paths as { tokens: string }).tokens = original
  // findTokenBySecret fires a fire-and-forget update to lastUsedAt;
  // wait a tick so the write lands before we wipe the dir, otherwise
  // rm races against it and trips ENOTEMPTY.
  await new Promise((r) => setTimeout(r, 20))
  await rm(dir, { recursive: true, force: true })
})

describe('tokens store', () => {
  it('hashToken is stable and bytes-deterministic', () => {
    expect(hashToken('rkn_abc')).toBe(hashToken('rkn_abc'))
    expect(hashToken('rkn_abc')).not.toBe(hashToken('rkn_xyz'))
  })

  it('createToken returns the plaintext secret once and persists only the hash', async () => {
    const r = await createToken({
      name: 'cli', role: 'editor', createdBy: 'alice', expiresInDays: null,
    })
    expect(r.secret.startsWith('rkn_')).toBe(true)
    expect(r.record.hash).toBe(hashToken(r.secret))
    expect((r.record as { secret?: string }).secret).toBeUndefined()
  })

  it('findTokenBySecret returns the record only for the right secret', async () => {
    const r = await createToken({ name: 'a', role: 'admin', createdBy: 'admin' })
    expect((await findTokenBySecret(r.secret))?.id).toBe(r.record.id)
    expect(await findTokenBySecret('rkn_not-real')).toBeNull()
  })

  it('findTokenBySecret rejects expired tokens', async () => {
    const r = await createToken({
      name: 'short', role: 'editor', createdBy: 'alice', expiresInDays: null,
    })
    // Forge the on-disk record to be expired.
    const { writeJson, readJson } = await import('../lib/fs.js')
    const file = path.join(config.paths.tokens, r.record.hash + '.json')
    const m = await readJson<Record<string, unknown>>(file)
    await writeJson(file, { ...m, expiresAt: Date.now() - 1000 })
    expect(await findTokenBySecret(r.secret)).toBeNull()
  })

  it('findTokenBySecret rejects disabled tokens', async () => {
    const r = await createToken({ name: 'x', role: 'editor', createdBy: 'a' })
    const { writeJson, readJson } = await import('../lib/fs.js')
    const file = path.join(config.paths.tokens, r.record.hash + '.json')
    const m = await readJson<Record<string, unknown>>(file)
    await writeJson(file, { ...m, disabled: true })
    expect(await findTokenBySecret(r.secret)).toBeNull()
  })

  it('lists tokens newest-first and deletes by id', async () => {
    const a = await createToken({ name: 'a', role: 'editor', createdBy: 'u' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await createToken({ name: 'b', role: 'editor', createdBy: 'u' })
    const all = await listTokens()
    expect(all[0].id).toBe(b.record.id) // newer first
    expect(await deleteToken(a.record.id)).toBe(true)
    expect((await listTokens()).length).toBe(1)
    expect(await deleteToken('no-such-id')).toBe(false)
  })
})
