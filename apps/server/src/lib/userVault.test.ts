import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { ownerFromAbs, resolveUserVault, userVaultRel, userVaultRoot } from './userVault.js'
import { config } from '../config.js'

const root = config.vault.root

describe('resolveUserVault', () => {
  it('resolves a normal path into the user namespace', () => {
    expect(resolveUserVault('alice', 'notes/foo.md')).toBe(
      path.join(root, 'alice', 'notes/foo.md'),
    )
  })

  it('treats undefined/empty as the user vault root', () => {
    expect(resolveUserVault('alice', '')).toBe(path.join(root, 'alice'))
    expect(resolveUserVault('alice', undefined)).toBe(path.join(root, 'alice'))
  })

  it('strips leading slashes (path is always vault-relative)', () => {
    expect(resolveUserVault('alice', '/notes/foo.md')).toBe(
      path.join(root, 'alice', 'notes/foo.md'),
    )
  })

  it('rejects path traversal with ..', () => {
    expect(() => resolveUserVault('alice', '../bob/secret')).toThrow(/invalid/i)
    expect(() => resolveUserVault('alice', 'notes/../../bob')).toThrow(/invalid/i)
  })

  it('rejects unsafe usernames so a forged input cannot escape', () => {
    expect(() => resolveUserVault('../bob', 'foo.md')).toThrow(/unsafe username/i)
    expect(() => resolveUserVault('a/b', 'foo.md')).toThrow(/unsafe username/i)
    expect(() => resolveUserVault('', 'foo.md')).toThrow(/unsafe username/i)
  })

  it('round-trips through userVaultRel', () => {
    const abs = resolveUserVault('alice', 'notes/foo.md')
    expect(userVaultRel('alice', abs)).toBe('notes/foo.md')
    expect(userVaultRel('alice', userVaultRoot('alice'))).toBe('')
  })
})

describe('ownerFromAbs', () => {
  it('decomposes an absolute path into owner + rel', () => {
    const abs = path.join(root, 'alice', 'notes', 'foo.md')
    expect(ownerFromAbs(abs)).toEqual({ owner: 'alice', rel: 'notes/foo.md' })
  })

  it('returns null for a path outside the vault', () => {
    expect(ownerFromAbs('/etc/passwd')).toBeNull()
  })

  it('returns null when the leading segment is not a valid username', () => {
    expect(ownerFromAbs(path.join(root, '..-evil', 'foo'))).toBeNull()
  })
})
