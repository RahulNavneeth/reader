/**
 * Access control in the per-user vault layout.
 *
 * Every vault path is now scoped to one user's namespace via
 * `resolveUserVault` — there is no shared root anymore. As a result, the
 * old path-level grant system collapses to two cases:
 *
 *   - admin: full access everywhere (still useful for cross-user reads)
 *   - everyone else: full access inside *their own* namespace
 *
 * Cross-user access lives in the share store (Phase 3) and is checked at
 * the share-boundary, not here.
 *
 * The helpers stay around so the existing call sites compile, but they're
 * now trivial — they return true for the path resolver's guarantees plus
 * admin override.
 */
import type { Role } from '../types.js'

export type Op = 'read' | 'write' | 'create'

export function userCan(user: { role: Role }, _op: Op, _vaultRelPath: string): boolean {
  // Path is constrained to the user's namespace by resolveUserVault; if the
  // request got here, the user implicitly owns it.
  void _op
  void _vaultRelPath
  return user.role !== 'viewer' || _op === 'read'
}

export function canNavigateTo(_user: { role: Role }, _vaultRelPath: string): boolean {
  void _user
  void _vaultRelPath
  return true
}

/** Built-in role presets — kept for back-compat with the old user-create flow. */
export const ROLE_PRESETS = {
  admin: [],
  editor: [],
  viewer: [],
} as const

/** Used by the old admin user-patch endpoint; preserved as a no-op shim. */
export function sanitizeGrants(_input: unknown): [] {
  return []
}
