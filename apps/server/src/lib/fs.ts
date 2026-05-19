import {
  cp,
  mkdir,
  rename,
  readFile,
  writeFile,
  unlink,
  readdir,
  rm,
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

/**
 * Move a file or directory across filesystems.
 *
 * `fs.rename` is atomic, fast, and works in-place — when the source
 * and destination sit on the same filesystem. In containerized
 * deployments `/vault` and `/data/trash` are commonly two separate
 * bind mounts, in which case `rename` fails with `EXDEV: cross-device
 * link not permitted`. This helper catches that specific error and
 * falls back to a recursive copy followed by a remove, which works
 * regardless of filesystem boundaries.
 *
 * Trade-off vs a plain `rename`: the fallback isn't atomic (a crash
 * between cp and rm leaves the source intact AND a copy at the dest).
 * For our trash flow that's acceptable — the copy at the dest is the
 * canonical record after the move, and a stale source at the vault
 * path just means the user can re-attempt the delete. We don't use
 * this for index writes where atomicity is load-bearing.
 */
export async function moveAcrossDevices(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
    return
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err?.code !== 'EXDEV') throw e
  }
  // Cross-device fallback. `cp` with recursive: true handles both
  // files and directories. `force: true` overwrites the dest if a
  // partial run left something behind; callers are expected to do
  // their own collision check beforehand when that matters.
  await cp(src, dest, { recursive: true, force: true, errorOnExist: false })
  await rm(src, { recursive: true, force: true })
}
