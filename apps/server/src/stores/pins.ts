/**
 * Per-user pinned items (files or folders). A pin records what to keep
 * within reach in the sidebar; nothing on disk moves.
 *
 * Layout: data/pins/<sanitized-user>.json — one file per user, holding
 * the full ordered list (newest pin first). Dataset is small enough that
 * rewriting the whole file per mutation is fine.
 */
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export type Pin = {
  /** Vault owner whose namespace holds the target. Usually = user, but
   *  may differ when the user pins a path shared with them. */
  owner: string
  /** Vault-relative path inside `owner`'s namespace. */
  storageKey: string
  isFolder: boolean
  pinnedAt: number
  /** Optional friendly label; falls back to basename in UI. */
  label?: string
}

// Resolve the dir per-call rather than at module load. Tests swap
// `config.dataDir` in beforeEach so they get isolated scratch dirs;
// the same dynamic resolution also lets the admin "move data dir at
// runtime" feature work without a server restart.
function pinsDir(): string {
  return path.join(config.dataDir, 'pins')
}

function fileFor(user: string): string {
  const safe = user.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(pinsDir(), `${safe}.json`)
}

export async function listPins(user: string): Promise<Pin[]> {
  try {
    const raw = await readFile(fileFor(user), 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as Pin[]) : []
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    return []
  }
}

async function writePins(user: string, pins: Pin[]): Promise<void> {
  await ensureDir(pinsDir())
  await writeFile(fileFor(user), JSON.stringify(pins, null, 2), 'utf8')
}

/** Idempotent: re-pinning the same (owner, storageKey) just refreshes its
 *  timestamp + label. The `isFolder` flag updates so a renamed-to-folder
 *  doesn't get stuck classified as a file. */
export async function addPin(
  user: string,
  pin: Omit<Pin, 'pinnedAt'>,
): Promise<Pin[]> {
  const all = await listPins(user)
  const idx = all.findIndex(
    (p) => p.owner === pin.owner && p.storageKey === pin.storageKey,
  )
  const next: Pin = { ...pin, pinnedAt: Date.now() }
  if (idx >= 0) all.splice(idx, 1)
  all.unshift(next)
  await writePins(user, all)
  return all
}

export async function removePin(
  user: string,
  owner: string,
  storageKey: string,
): Promise<Pin[]> {
  const all = await listPins(user)
  const next = all.filter((p) => !(p.owner === owner && p.storageKey === storageKey))
  if (next.length === all.length) return all
  await writePins(user, next)
  return next
}

export async function isPinned(
  user: string,
  owner: string,
  storageKey: string,
): Promise<boolean> {
  const all = await listPins(user)
  return all.some((p) => p.owner === owner && p.storageKey === storageKey)
}
