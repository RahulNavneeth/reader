import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import {
  createSession,
  deleteAllSessionsForUser,
  deleteSession,
  getSession,
  listSessionsForUser,
  sweepExpired,
} from './sessions.js'

const original = config.paths.sessions

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-sessions-'))
  ;(config.paths as { sessions: string }).sessions = dir
})

afterEach(async () => {
  const dir = config.paths.sessions
  ;(config.paths as { sessions: string }).sessions = original
  await rm(dir, { recursive: true, force: true })
})

describe('sessions store', () => {
  it('creates a session with a unique token and a future expiry', async () => {
    const a = await createSession('alice')
    const b = await createSession('alice')
    expect(a.token).not.toBe(b.token)
    expect(a.expiresAt).toBeGreaterThan(Date.now())
    expect(a.username).toBe('alice')
  })

  it('reads a session by token and returns null for unknown / deleted', async () => {
    const s = await createSession('alice')
    expect((await getSession(s.token))?.username).toBe('alice')
    await deleteSession(s.token)
    expect(await getSession(s.token)).toBeNull()
    expect(await getSession('no-such-token')).toBeNull()
  })

  it('lists active sessions for a user', async () => {
    await createSession('alice')
    await createSession('alice')
    await createSession('bob')
    expect((await listSessionsForUser('alice')).length).toBe(2)
    expect((await listSessionsForUser('bob')).length).toBe(1)
  })

  it('deleteAllSessionsForUser revokes every token at once', async () => {
    await createSession('alice')
    await createSession('alice')
    await deleteAllSessionsForUser('alice')
    expect((await listSessionsForUser('alice')).length).toBe(0)
  })

  describe('sweepExpired', () => {
    it('drops sessions whose expiresAt is in the past', async () => {
      const fresh = await createSession('alice')
      const stale = await createSession('alice')
      // Forge the on-disk meta to be expired.
      const { writeJson, readJson } = await import('../lib/fs.js')
      const m = await readJson<{ expiresAt: number; [k: string]: unknown }>(
        path.join(config.paths.sessions, stale.token + '.json'),
      )
      if (!m) throw new Error('failed to load fixture session')
      await writeJson(path.join(config.paths.sessions, stale.token + '.json'), {
        ...m,
        expiresAt: Date.now() - 1000,
      })
      const removed = await sweepExpired()
      expect(removed).toBe(1)
      expect(await getSession(fresh.token)).not.toBeNull()
      expect(await getSession(stale.token)).toBeNull()
    })
  })
})
