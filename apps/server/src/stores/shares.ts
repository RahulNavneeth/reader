/**
 * Share-link store. A share is a token-addressable, time-bounded grant to
 * fetch one file via /s/<token>. Optional password (scrypt-hashed) gates
 * access; `expiresAt` set to null means the link never expires.
 *
 * One JSON file per share: data/shares/<id>.json. Lookups are O(N) but the
 * dataset is small (one entry per active share) and cached implicitly via
 * filesystem.
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export type Share = {
  /** Random URL-safe token, 24+ chars. The "public" identifier. */
  id: string
  /** Vault path the share grants access to. */
  storageKey: string
  /** Document id at the time of share creation (for fast lookup). */
  docId?: string
  /** Free-text label the user picks ("Q3 invoice for John"). Optional. */
  label?: string
  createdBy: string
  createdAt: number
  /** Absolute timestamp or null for no expiry. */
  expiresAt: number | null
  /** scrypt(N=16384,r=8,p=1) hash + salt, "salt:digest" hex. Null = no pwd. */
  passwordHash: string | null
  /** Last successful fetch — useful for the UI to show "used N times". */
  lastAccessAt?: number
  accessCount: number
}

const TOKEN_BYTES = 18

function shareFile(id: string): string {
  return path.join(config.paths.shares, `${id}.json`)
}

export async function createShare(opts: {
  storageKey: string
  docId?: string
  createdBy: string
  label?: string
  expiresAt: number | null
  password?: string
}): Promise<Share> {
  await ensureDir(config.paths.shares)
  // nanoid for the file id, plus a base64url random token for the URL token.
  // The token IS the id — making it brute-resistant.
  const id = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const share: Share = {
    id,
    storageKey: opts.storageKey,
    docId: opts.docId,
    label: opts.label,
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    expiresAt: opts.expiresAt,
    passwordHash: opts.password ? hashPassword(opts.password) : null,
    accessCount: 0,
  }
  await writeFile(shareFile(id), JSON.stringify(share, null, 2), 'utf8')
  return share
}

export async function getShare(id: string): Promise<Share | null> {
  try {
    const raw = await readFile(shareFile(id), 'utf8')
    return JSON.parse(raw) as Share
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    return null
  }
}

export async function listShares(filter?: { storageKey?: string }): Promise<Share[]> {
  let names: string[]
  try {
    names = await readdir(config.paths.shares)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out: Share[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const raw = await readFile(path.join(config.paths.shares, n), 'utf8').catch(() => null)
    if (!raw) continue
    try {
      const s = JSON.parse(raw) as Share
      if (filter?.storageKey && s.storageKey !== filter.storageKey) continue
      out.push(s)
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function deleteShare(id: string): Promise<boolean> {
  try {
    await rm(shareFile(id))
    return true
  } catch (e: any) {
    if (e?.code === 'ENOENT') return false
    throw e
  }
}

export async function recordShareAccess(id: string): Promise<void> {
  const s = await getShare(id)
  if (!s) return
  s.lastAccessAt = Date.now()
  s.accessCount = (s.accessCount ?? 0) + 1
  await writeFile(shareFile(id), JSON.stringify(s, null, 2), 'utf8').catch(() => null)
}

/** Sweep links whose expiry has passed. Returns count purged. */
export async function sweepExpiredShares(): Promise<number> {
  const now = Date.now()
  const all = await listShares()
  let purged = 0
  for (const s of all) {
    if (s.expiresAt != null && s.expiresAt < now) {
      await deleteShare(s.id).catch(() => null)
      purged++
    }
  }
  return purged
}

// ─── password helpers ───────────────────────────────────────────────────────

const SCRYPT_N = 1 << 14
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const digest = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `${salt.toString('hex')}:${digest.toString('hex')}`
}

export function verifySharePassword(stored: string, candidate: string): boolean {
  const [saltHex, digestHex] = stored.split(':')
  if (!saltHex || !digestHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(digestHex, 'hex')
  const actual = crypto.scryptSync(candidate, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// Re-export for tests / future tooling.
export { hashPassword as _hashShareSecret }
// nanoid kept imported to retain consistency with other stores; not used here
// because crypto.randomBytes gives a longer token.
void nanoid
