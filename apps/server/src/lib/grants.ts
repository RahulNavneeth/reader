import type { Grant, Role, User } from '../types.js'

export type Op = 'read' | 'write' | 'create'

function normalize(p: string): string {
  return (p ?? '').replace(/^\/+|\/+$/g, '')
}

function matches(grantPath: string, target: string): boolean {
  const g = normalize(grantPath)
  const t = normalize(target)
  if (g === '') return true
  if (g === t) return true
  return t.startsWith(g + '/')
}

/**
 * Resolve effective grants for a user. Admins implicitly have full access. For
 * non-admins, grants come from the user record; legacy users without a grants
 * field get a sensible role-based default so the system stays usable.
 */
export function effectiveGrants(user: { role: Role; grants?: Grant[] | null }): Grant[] {
  if (user.role === 'admin') return [{ path: '', read: true, write: true, create: true }]
  if (user.grants && user.grants.length) return user.grants
  if (user.role === 'editor') return [{ path: '', read: true, write: true, create: true }]
  if (user.role === 'viewer') return [{ path: '', read: true, write: false, create: false }]
  return []
}

export function userCan(user: { role: Role; grants?: Grant[] | null }, op: Op, vaultRelPath: string): boolean {
  const grants = effectiveGrants(user)
  for (const g of grants) {
    if (matches(g.path, vaultRelPath) && g[op]) return true
  }
  return false
}

/**
 * True if the user can at least navigate to `vaultRelPath` — i.e. they can
 * read it directly, an ancestor grants read, or a descendant grants read
 * (so the user needs the parent listing to reach the descendant).
 */
export function canNavigateTo(user: { role: Role; grants?: Grant[] | null }, vaultRelPath: string): boolean {
  const grants = effectiveGrants(user)
  const t = normalize(vaultRelPath)
  for (const g of grants) {
    if (!g.read) continue
    const gp = normalize(g.path)
    if (gp === '') return true
    if (t === '') return true
    if (gp === t) return true
    if (t.startsWith(gp + '/')) return true
    if (gp.startsWith(t + '/')) return true
  }
  return false
}

/** Built-in presets used by the role dropdown. */
export const ROLE_PRESETS: Record<Role, Grant[]> = {
  admin: [],
  editor: [{ path: '', read: true, write: true, create: true }],
  viewer: [{ path: '', read: true, write: false, create: false }],
}

export function sanitizeGrants(input: unknown): Grant[] {
  if (!Array.isArray(input)) return []
  const out: Grant[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const path = typeof r.path === 'string' ? normalize(r.path) : ''
    if (seen.has(path)) continue
    seen.add(path)
    out.push({
      path,
      read: r.read === true,
      write: r.write === true,
      create: r.create === true,
    })
  }
  return out
}

export function publicUserWithGrants(u: User) {
  const { passwordHash: _ph, ...rest } = u
  void _ph
  return rest
}
