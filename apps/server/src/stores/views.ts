/**
 * Saved views = per-user named filter shortcuts. Each view captures a query
 * (the sidebar filter text) and/or a tag filter. Clicking the view from the
 * sidebar re-applies it.
 *
 * Stored one JSON file per user: data/views/<username>.json.
 */
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export type SavedView = {
  id: string
  name: string
  /** Free-form text typed into the sidebar filter; matches names + tags. */
  query?: string
  /** Specific tag to navigate to (/tags/<tag>). */
  tag?: string
  createdAt: number
}

function fileFor(username: string): string {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(config.paths.views, `${safe}.json`)
}

export async function listViews(username: string): Promise<SavedView[]> {
  try {
    const raw = await readFile(fileFor(username), 'utf8')
    const out = JSON.parse(raw) as SavedView[]
    return Array.isArray(out) ? out : []
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    return []
  }
}

export async function addView(
  username: string,
  v: Omit<SavedView, 'id' | 'createdAt'>,
): Promise<SavedView> {
  await ensureDir(config.paths.views)
  const list = await listViews(username)
  const next: SavedView = { id: nanoid(), createdAt: Date.now(), ...v }
  list.push(next)
  await writeFile(fileFor(username), JSON.stringify(list, null, 2), 'utf8')
  return next
}

export async function deleteView(username: string, id: string): Promise<boolean> {
  const list = await listViews(username)
  const next = list.filter((v) => v.id !== id)
  if (next.length === list.length) return false
  await writeFile(fileFor(username), JSON.stringify(next, null, 2), 'utf8')
  return true
}
