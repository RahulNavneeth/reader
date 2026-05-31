/**
 * Trash store — when a user deletes a file, we move both the vault file and
 * its index meta (if any) into a per-trash subdirectory keyed by a token, with
 * a small JSON manifest describing what was deleted and when. Sweeper purges
 * anything older than RETENTION_DAYS.
 */
import path from 'node:path'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { ensureDir, moveAcrossDevices } from '../lib/fs.js'

export const RETENTION_DAYS = 30
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Per-file metadata captured at trash time so folder entries can
 *  be restored as a unit (vault tree + each file's doc-meta dir +
 *  the SQLite document row). Keyed off vault-relative path. */
export type TrashChild = {
  storageKey: string
  docId?: string
  bytes: number
}

export type TrashEntry = {
  id: string
  /** 'file' (default, legacy) for single-file entries; 'folder'
   *  when the whole subtree was moved as one unit. */
  kind?: 'file' | 'folder'
  /** Original vault-relative path inside `owner`'s namespace. For
   *  folder entries this is the folder path. */
  storageKey: string
  /** Filename (basename of storageKey). For folder entries this is
   *  the folder's basename. */
  filename: string
  /** File-only: document meta id, if the file had an index record. */
  docId?: string
  /** Username whose vault the file came out of (so restore puts it back). */
  owner: string
  /** File: file size in bytes. Folder: sum of all child bytes. */
  bytes: number
  trashedAt: number
  trashedBy: string
  /** Folder-only: per-file manifest, so the restore path can put
   *  every doc-meta dir back and re-seed the SQLite rows. */
  children?: TrashChild[]
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
  owner: string
  bytes: number
  trashedBy: string
}): Promise<TrashEntry> {
  await ensureDir(config.paths.trash)
  const id = nanoid()
  await mkdir(entryDir(id), { recursive: true })
  const filename = path.basename(opts.storageKey)
  // moveAcrossDevices uses rename (atomic, same-fs) and falls back
  // to copy+remove on EXDEV. In docker-compose / podman-compose
  // deployments /vault and /data are typically separate volumes,
  // so the EXDEV path is the common case there — not the edge.
  await moveAcrossDevices(opts.vaultAbs, blobFile(id, filename))
  // Move document meta dir if present. Always under /data so usually
  // same-fs as the trash dir, but we use the cross-device helper
  // anyway so a user who bind-mounts /data/documents separately
  // doesn't break here either.
  if (opts.docId) {
    const src = docMetaDir(opts.docId)
    const s = await stat(src).catch(() => null)
    if (s?.isDirectory()) {
      await moveAcrossDevices(src, path.join(entryDir(id), '_doc'))
    }
  }
  const entry: TrashEntry = {
    id,
    kind: 'file',
    storageKey: opts.storageKey,
    filename,
    docId: opts.docId,
    owner: opts.owner,
    bytes: opts.bytes,
    trashedAt: Date.now(),
    trashedBy: opts.trashedBy,
  }
  await writeFile(manifestFile(id), JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

/**
 * Move an entire folder subtree into trash as ONE entry. The
 * folder's vault directory is renamed into `trash/<id>/<folder>/...`
 * verbatim, and every child file's doc-meta dir is moved alongside
 * (under `trash/<id>/_docs/<docId>/`). On restore the whole tree
 * goes back at once and every doc row is re-seeded — same semantics
 * as the file path, just scaled to a folder.
 *
 * Mirrors the archive feature's "folder as a unit" treatment so the
 * Trash UI shows one folder entry, not N file entries.
 */
export async function moveFolderToTrash(opts: {
  storageKey: string
  vaultAbs: string
  owner: string
  trashedBy: string
  children: TrashChild[]
}): Promise<TrashEntry> {
  await ensureDir(config.paths.trash)
  const id = nanoid()
  await mkdir(entryDir(id), { recursive: true })
  const filename = path.basename(opts.storageKey)
  const safeFolderName = filename
    .replace(/\.\./g, '_')
    .replace(/[\/\\]/g, '_') || '_root'
  const treeDest = path.join(entryDir(id), safeFolderName)
  // Move the whole vault subtree in one operation. EXDEV-safe via
  // the copy+remove fallback in moveAcrossDevices for split mounts.
  await moveAcrossDevices(opts.vaultAbs, treeDest)
  // Move each indexed child's doc-meta dir alongside, so restore
  // can re-seed the SQLite row from on-disk meta.json without
  // re-ingesting (which would lose templateSource, version history,
  // tags, ACL, etc).
  for (const child of opts.children) {
    if (!child.docId) continue
    const src = docMetaDir(child.docId)
    const s = await stat(src).catch(() => null)
    if (!s?.isDirectory()) continue
    const dest = path.join(
      entryDir(id),
      '_docs',
      child.docId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    )
    await mkdir(path.dirname(dest), { recursive: true })
    await moveAcrossDevices(src, dest).catch(() => null)
  }
  const totalBytes = opts.children.reduce((sum, c) => sum + (c.bytes || 0), 0)
  const entry: TrashEntry = {
    id,
    kind: 'folder',
    storageKey: opts.storageKey,
    filename,
    owner: opts.owner,
    bytes: totalBytes,
    trashedAt: Date.now(),
    trashedBy: opts.trashedBy,
    children: opts.children,
  }
  await writeFile(manifestFile(id), JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

/** Where the folder subtree lives inside a folder trash entry.
 *  Exported so the restore route can find it without re-deriving
 *  the safe-folder-name munging. */
export function folderEntryTreePath(entry: TrashEntry): string {
  const safe = entry.filename
    .replace(/\.\./g, '_')
    .replace(/[\/\\]/g, '_') || '_root'
  return path.join(entryDir(entry.id), safe)
}

/** Where a folder entry's per-doc meta dir was stashed at trash
 *  time. Returns the trash-side path; restore moves it back to
 *  the canonical docMetaDir. */
export function folderEntryDocMetaPath(entryId: string, docId: string): string {
  return path.join(
    entryDir(entryId),
    '_docs',
    docId.replace(/[^a-zA-Z0-9_-]/g, '_'),
  )
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
