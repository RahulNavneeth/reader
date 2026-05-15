/**
 * Trash store — when a user deletes a file, we move both the vault file and
 * its index meta (if any) into a per-trash subdirectory keyed by a token, with
 * a small JSON manifest describing what was deleted and when. Sweeper purges
 * anything older than RETENTION_DAYS.
 */
import path from 'node:path'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export const RETENTION_DAYS = 30
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

export type TrashEntry = {
  id: string
  /** Original vault-relative path. */
  storageKey: string
  /** Filename (basename of storageKey). */
  filename: string
  /** Optional document meta id, if the file had an index record. */
  docId?: string
  bytes: number
  trashedAt: number
  trashedBy: string
}

function entryDir(id: string): string {
  return path.join(config.paths.trash, id)
}

function manifestFile(id: string): string {
  return path.join(entryDir(id), 'manifest.json')
}

function blobFile(id: string, filename: string): string {
  // Strip directory traversal characters defensively.
  const safe = filename.replace(/\.\./g, '_').replace(/[\/\\]/g, '_')
  return path.join(entryDir(id), safe)
}

function docMetaDir(id: string): string {
  return path.join(config.paths.documents, id.replace(/[^a-zA-Z0-9_-]/g, '_'))
}

export async function moveToTrash(opts: {
  storageKey: string
  vaultAbs: string
  docId?: string
  bytes: number
  trashedBy: string
}): Promise<TrashEntry> {
  await ensureDir(config.paths.trash)
  const id = nanoid()
  await mkdir(entryDir(id), { recursive: true })
  const filename = path.basename(opts.storageKey)
  // Move file (rename is atomic on same fs; fallback to copy+unlink would need
  // to be added if vault ever lives on a separate volume).
  await rename(opts.vaultAbs, blobFile(id, filename))
  // Move document meta dir if present.
  if (opts.docId) {
    const src = docMetaDir(opts.docId)
    const s = await stat(src).catch(() => null)
    if (s?.isDirectory()) {
      await rename(src, path.join(entryDir(id), '_doc'))
    }
  }
  const entry: TrashEntry = {
    id,
    storageKey: opts.storageKey,
    filename,
    docId: opts.docId,
    bytes: opts.bytes,
    trashedAt: Date.now(),
    trashedBy: opts.trashedBy,
  }
  await writeFile(manifestFile(id), JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

export async function listTrash(): Promise<TrashEntry[]> {
  let names: string[]
  try {
    names = await readdir(config.paths.trash)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out: TrashEntry[] = []
  for (const n of names) {
    const data = await readFile(manifestFile(n), 'utf8').catch(() => null)
    if (!data) continue
    try {
      out.push(JSON.parse(data))
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.trashedAt - a.trashedAt)
  return out
}

/** Permanently remove a trash entry's files. */
export async function purgeTrash(id: string): Promise<void> {
  await rm(entryDir(id), { recursive: true, force: true })
}

/** Sweep trash entries older than RETENTION_DAYS. Returns count purged. */
export async function sweepExpiredTrash(): Promise<number> {
  const all = await listTrash()
  const cutoff = Date.now() - RETENTION_MS
  let purged = 0
  for (const e of all) {
    if (e.trashedAt < cutoff) {
      await purgeTrash(e.id).catch(() => null)
      purged++
    }
  }
  return purged
}
