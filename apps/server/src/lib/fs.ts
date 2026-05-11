import {
  mkdir,
  rename,
  readFile,
  writeFile,
  unlink,
  readdir,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Atomically write JSON. Same filesystem only. */
export async function writeJson<T>(file: string, value: T): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.tmp.${crypto.randomBytes(6).toString('hex')}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

export async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
  }
}

export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file))
  await writeFile(file, line + '\n', { flag: 'a', encoding: 'utf8' })
}

export async function listDirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Hex token. Caller pays for entropy. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

/** Slug-safe filenames; refuses '/'. */
export function safeFileName(s: string): string {
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw new Error('unsafe filename')
  }
  return s
}
