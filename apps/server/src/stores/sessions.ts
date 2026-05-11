import path from 'node:path'
import { config } from '../config.js'
import { listDirNames, randomToken, readJson, removeFile, safeFileName, writeJson } from '../lib/fs.js'
import type { Session } from '../types.js'

function sessionFile(token: string): string {
  return path.join(config.paths.sessions, safeFileName(token) + '.json')
}

export async function createSession(username: string): Promise<Session> {
  const token = randomToken(32)
  const now = Date.now()
  const session: Session = {
    token,
    username,
    createdAt: now,
    expiresAt: now + config.session.ttlMs,
  }
  await writeJson(sessionFile(token), session)
  return session
}

export async function getSession(token: string): Promise<Session | null> {
  if (!/^[a-f0-9]{32,128}$/.test(token)) return null
  const s = await readJson<Session>(sessionFile(token))
  if (!s) return null
  if (s.expiresAt < Date.now()) {
    await deleteSession(token)
    return null
  }
  return s
}

export async function deleteSession(token: string): Promise<void> {
  if (!/^[a-f0-9]{32,128}$/.test(token)) return
  await removeFile(sessionFile(token))
}

export async function deleteAllSessionsForUser(username: string): Promise<void> {
  const names = await listDirNames(config.paths.sessions)
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const s = await readJson<Session>(path.join(config.paths.sessions, n))
    if (s && s.username === username) {
      await removeFile(path.join(config.paths.sessions, n))
    }
  }
}

/** Best-effort sweep on boot; non-blocking thereafter. */
export async function sweepExpired(): Promise<number> {
  const names = await listDirNames(config.paths.sessions)
  const now = Date.now()
  let removed = 0
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const fp = path.join(config.paths.sessions, n)
    const s = await readJson<Session>(fp)
    if (!s || s.expiresAt < now) {
      await removeFile(fp)
      removed++
    }
  }
  return removed
}
