/**
 * Per-user vault namespacing. Every user gets a personal subdir under
 * `config.vault.root`:
 *
 *   <vault-root>/<username>/<vault-relative path>
 *
 * All vault-route path resolution flows through these helpers so a request
 * for "investments/foo.md" from user X always maps to
 * <root>/X/investments/foo.md and never crosses into another user's space.
 *
 * Admins still operate on their own namespace by default; cross-user reads
 * happen exclusively through share grants (Phase 3) — not through the path
 * resolver.
 */
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { config } from '../config.js'

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Validate + return the absolute path to a user's vault root. Throws on
 * unsafe usernames so a malformed input can never escape the parent dir.
 */
export function userVaultRoot(username: string): string {
  if (!USERNAME_RE.test(username)) {
    throw new Error(`unsafe username: ${username}`)
  }
  return path.resolve(config.vault.root, username)
}

/** Ensure the user's vault dir exists. Idempotent — safe to call on every boot. */
export async function ensureUserVault(username: string): Promise<string> {
  const root = userVaultRoot(username)
  await mkdir(root, { recursive: true })
  return root
}

/**
 * Resolve a vault-relative path inside a user's namespace. Refuses traversal
 * and rejects absolute paths so requests can't reach outside the user's dir.
 */
export function resolveUserVault(username: string, rel: string | undefined): string {
  const userRoot = userVaultRoot(username)
  const r = (rel ?? '').replace(/^\/+/, '')
  if (r.includes('..')) {
    const err = new Error('invalid path') as Error & { statusCode: number }
    err.statusCode = 400
    throw err
  }
  const abs = path.resolve(userRoot, r)
  if (abs !== userRoot && !abs.startsWith(userRoot + path.sep)) {
    const err = new Error('path outside vault') as Error & { statusCode: number }
    err.statusCode = 403
    throw err
  }
  return abs
}

/** Strip the user's vault prefix from an absolute path, yielding the vault-rel. */
export function userVaultRel(username: string, abs: string): string {
  const userRoot = userVaultRoot(username)
  const a = path.resolve(abs)
  if (a === userRoot) return ''
  if (!a.startsWith(userRoot + path.sep)) {
    throw new Error(`path ${a} is not inside ${username}'s vault`)
  }
  return a.slice(userRoot.length + 1)
}

/**
 * Given an absolute path anywhere under the shared vault root, return
 * { owner, rel } describing which user's namespace it lives in. Returns
 * null when the path doesn't sit under any recognizable user dir (e.g.,
 * pre-migration loose files in the parent).
 */
export function ownerFromAbs(abs: string): { owner: string; rel: string } | null {
  const root = path.resolve(config.vault.root)
  const a = path.resolve(abs)
  if (!a.startsWith(root + path.sep)) return null
  const rest = a.slice(root.length + 1)
  const slash = rest.indexOf(path.sep)
  const owner = slash < 0 ? rest : rest.slice(0, slash)
  if (!USERNAME_RE.test(owner)) return null
  const rel = slash < 0 ? '' : rest.slice(slash + 1)
  return { owner, rel }
}

/** Sentinel marker used to flag a user dir as already-migrated. */
export const MIGRATION_MARKER = '.reader-migrated'
