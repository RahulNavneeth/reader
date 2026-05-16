import { describe, expect, it } from 'vitest'
import { sha256Of, userCanEdit, userCanRead } from './documents.js'
import type { DocumentMeta } from '../types.js'

type AclPatch = { readers?: string[]; editors?: string[] }

function doc(patch: Omit<Partial<DocumentMeta>, 'acl'> & { acl?: AclPatch } = {}): DocumentMeta {
  const { acl: patchAcl, ...rest } = patch
  return {
    id: 'd1',
    title: 'doc',
    originalFilename: 'doc.md',
    mime: 'text/markdown',
    bytes: 0,
    sha256: '',
    storageKey: 'doc.md',
    owner: 'alice',
    public: false,
    publicExpiresAt: null,
    publicPasswordHash: null,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ingest: { status: 'pending', embedded: false },
    ...rest,
    acl: { readers: patchAcl?.readers ?? [], editors: patchAcl?.editors ?? [] },
  }
}

describe('userCanRead', () => {
  it('admin reads everything', () => {
    expect(userCanRead(doc(), 'someone', 'admin')).toBe(true)
  })

  it('owner reads their own files', () => {
    expect(userCanRead(doc(), 'alice', 'editor')).toBe(true)
  })

  it('listed reader can read', () => {
    expect(userCanRead(doc({ acl: { readers: ['bob'] } }), 'bob', 'editor')).toBe(true)
  })

  it('listed editor implicitly gets read', () => {
    expect(userCanRead(doc({ acl: { editors: ['bob'] } }), 'bob', 'editor')).toBe(true)
  })

  it('readers: ["*"] makes the doc readable by any authed user', () => {
    expect(userCanRead(doc({ acl: { readers: ['*'] } }), 'eve', 'viewer')).toBe(true)
  })

  it('strangers cannot read', () => {
    expect(userCanRead(doc(), 'eve', 'viewer')).toBe(false)
  })
})

describe('userCanEdit', () => {
  it('admin edits everything', () => {
    expect(userCanEdit(doc(), 'someone', 'admin')).toBe(true)
  })

  it('owner edits their own files', () => {
    expect(userCanEdit(doc(), 'alice', 'editor')).toBe(true)
  })

  it('listed editor can edit', () => {
    expect(userCanEdit(doc({ acl: { editors: ['bob'] } }), 'bob', 'editor')).toBe(true)
  })

  it('listed reader cannot edit', () => {
    expect(userCanEdit(doc({ acl: { readers: ['bob'] } }), 'bob', 'editor')).toBe(false)
  })

  it('strangers cannot edit', () => {
    expect(userCanEdit(doc(), 'eve', 'editor')).toBe(false)
  })
})

describe('sha256Of', () => {
  it('produces the canonical hash of a known input', () => {
    expect(sha256Of(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Of(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('is deterministic across calls', () => {
    const buf = Buffer.from('reader test bytes')
    expect(sha256Of(buf)).toBe(sha256Of(buf))
  })
})
