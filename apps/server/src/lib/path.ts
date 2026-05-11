import path from 'node:path'

/** Returns true iff target is the root or a descendant of it. */
export function isUnderRoot(target: string, root: string): boolean {
  const r = path.resolve(root)
  const t = path.resolve(target)
  return t === r || t.startsWith(r + path.sep)
}
