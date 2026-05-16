import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { listDirNames, readJson, removeFile, safeFileName, writeJson } from '../lib/fs.js'
import type { ApiToken, Role } from '../types.js'

function tokenFile(hashHex: string): string {
  return path.join(config.paths.tokens, safeFileName(hashHex) + '.json')
}

export function hashToken(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

/** Returns the plaintext secret to show ONCE; the hash is what's stored. */
export async function createToken(opts: {
  name: string
  role: Role
  createdBy: string
  /** Token expiry. Defaults to 90 days; pass `null` for non-expiring. */
  expiresInDays?: number | null
}): Promise<{ secret: string; record: ApiToken }> {
  const secret = 'rkn_' + crypto.randomBytes(24).toString('base64url')
  const id = secret.slice(0, 12)
  const hash = hashToken(secret)
  const expiresIn = opts.expiresInDays === undefined ? 90 : opts.expiresInDays
  const rec: ApiToken = {
    id,
    name: opts.name,
    hash,
    role: opts.role,
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    expiresAt:
      expiresIn === null ? null : Date.now() + expiresIn * 24 * 60 * 60 * 1000,
    useCount: 0,
  }
  await writeJson(tokenFile(hash), rec)
  return { secret, record: rec }
}

export async function findTokenBySecret(secret: string): Promise<ApiToken | null> {
  const hash = hashToken(secret)
  const rec = await readJson<ApiToken>(tokenFile(hash))
  if (!rec || rec.disabled) return null
  // Reject expired tokens; non-expiring (expiresAt === null) is fine.
  if (rec.expiresAt != null && rec.expiresAt < Date.now()) return null
  // Touch lastUsedAt + bump useCount async, fire and forget.
  void writeJson(tokenFile(hash), {
    ...rec,
    lastUsedAt: Date.now(),
    useCount: (rec.useCount ?? 0) + 1,
  }).catch(() => {})
  return rec
}

export async function listTokens(): Promise<ApiToken[]> {
  const names = await listDirNames(config.paths.tokens)
  const out: ApiToken[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const rec = await readJson<ApiToken>(path.join(config.paths.tokens, n))
    if (rec) out.push(rec)
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function deleteToken(idOrHash: string): Promise<boolean> {
  // Accept either token-id prefix or full hash.
  const tokens = await listTokens()
  const target = tokens.find((t) => t.id === idOrHash || t.hash === idOrHash)
  if (!target) return false
  await removeFile(tokenFile(target.hash))
  return true
}
