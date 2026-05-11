import path from 'node:path'
import { config } from '../config.js'
import { listDirNames, readJson, removeFile, safeFileName, writeJson } from '../lib/fs.js'
import type { User } from '../types.js'

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/

export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u)
}

function userFile(username: string): string {
  return path.join(config.paths.users, safeFileName(username) + '.json')
}

export async function getUser(username: string): Promise<User | null> {
  if (!isValidUsername(username)) return null
  return readJson<User>(userFile(username))
}

export async function saveUser(user: User): Promise<void> {
  if (!isValidUsername(user.username)) {
    throw new Error('invalid username')
  }
  await writeJson(userFile(user.username), user)
}

export async function deleteUser(username: string): Promise<void> {
  if (!isValidUsername(username)) return
  await removeFile(userFile(username))
}

export async function listUsers(): Promise<User[]> {
  const names = await listDirNames(config.paths.users)
  const users: User[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const u = await readJson<User>(path.join(config.paths.users, n))
    if (u) users.push(u)
  }
  users.sort((a, b) => a.createdAt - b.createdAt)
  return users
}

export async function userCount(): Promise<number> {
  const names = await listDirNames(config.paths.users)
  return names.filter((n) => n.endsWith('.json')).length
}

export function publicUser(u: User) {
  const { passwordHash, ...rest } = u
  void passwordHash
  return rest
}
