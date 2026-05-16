/**
 * User-to-user shares. Owner grants a recipient read (or read+write) access
 * to a specific file or folder inside their own vault namespace.
 *
 * Stored one JSON per share at `data/user-shares/<id>.json`. The dataset is
 * small (one entry per active share); lookups are O(N) but cheap. Sharing a
 * folder grants access to the whole subtree.
 */
import path from 'node:path'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export type UserShare = {
  id: string
  /** Vault owner (username whose namespace holds the file). */
  owner: string
  /** Username receiving access. */
  recipient: string
  /** Vault-relative path inside `owner`'s namespace. */
  storageKey: string
  /** True if the storageKey refers to a directory (subtree share). */
  isFolder: boolean
  /** Read-only by default; if true the recipient can upload/rename/delete inside. */
  canEdit: boolean
  /** Free-text label the owner can attach (optional). */
  label?: string
  createdAt: number
}

function shareFile(id: string): string {
  return path.join(config.paths.userShares, `${id}.json`)
}

export async function createUserShare(opts: {
  owner: string
  recipient: string
  storageKey: string
  isFolder: boolean
  canEdit: boolean
  label?: string
}): Promise<UserShare> {
  await ensureDir(config.paths.userShares)
  // De-dupe by (owner, recipient, storageKey). Without this the share
  // popover happily makes a second record every time the user clicks
  // Share with the same recipient, and the recipient's sidebar ends up
  // with "cdsl" twice. Re-share updates the existing grant in-place
  // (e.g. flipping canEdit) and returns it.
  const all = await listAllUserShares()
  const existing = all.find(
    (s) =>
      s.owner === opts.owner &&
      s.recipient === opts.recipient &&
      s.storageKey === opts.storageKey,
  )
  if (existing) {
    const updated: UserShare = {
      ...existing,
      isFolder: opts.isFolder,
      canEdit: opts.canEdit,
      label: opts.label?.trim() || existing.label,
    }
    await writeFile(shareFile(updated.id), JSON.stringify(updated, null, 2), 'utf8')
    return updated
  }
  const share: UserShare = {
    id: nanoid(),
    owner: opts.owner,
    recipient: opts.recipient,
    storageKey: opts.storageKey,
    isFolder: opts.isFolder,
    canEdit: opts.canEdit,
    label: opts.label?.trim() || undefined,
    createdAt: Date.now(),
  }
  await writeFile(shareFile(share.id), JSON.stringify(share, null, 2), 'utf8')
  return share
}

export async function getUserShare(id: string): Promise<UserShare | null> {
  try {
    const raw = await readFile(shareFile(id), 'utf8')
    return JSON.parse(raw) as UserShare
  } catch {
    return null
  }
}

export async function listAllUserShares(): Promise<UserShare[]> {
  let names: string[]
  try {
    names = await readdir(config.paths.userShares)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out: UserShare[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const raw = await readFile(path.join(config.paths.userShares, n), 'utf8').catch(() => null)
    if (!raw) continue
    try {
      out.push(JSON.parse(raw) as UserShare)
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function listSharesFrom(owner: string): Promise<UserShare[]> {
  return (await listAllUserShares()).filter((s) => s.owner === owner)
}

export async function listSharesTo(recipient: string): Promise<UserShare[]> {
  return (await listAllUserShares()).filter((s) => s.recipient === recipient)
}

export async function deleteUserShare(id: string): Promise<boolean> {
  try {
    await rm(shareFile(id))
    return true
  } catch (e: any) {
    if (e?.code === 'ENOENT') return false
    throw e
  }
}

/**
 * Does `recipient` have a share covering `<owner>/<storageKey>`?
 *
 *   - direct share matching the path → yes
 *   - share on a folder ancestor → yes
 *
 * Folders cascade: sharing "investments/" with Bob lets Bob read everything
 * under it.
 */
export async function findShareForPath(
  recipient: string,
  owner: string,
  storageKey: string,
): Promise<UserShare | null> {
  const shares = await listSharesTo(recipient)
  const target = storageKey.replace(/^\/+|\/+$/g, '')
  for (const s of shares) {
    if (s.owner !== owner) continue
    const sk = s.storageKey.replace(/^\/+|\/+$/g, '')
    if (s.isFolder) {
      if (sk === '' || target === sk || target.startsWith(sk + '/')) return s
    } else {
      if (target === sk) return s
    }
  }
  return null
}
