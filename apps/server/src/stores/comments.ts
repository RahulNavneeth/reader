/**
 * Inline comments anchored to text ranges inside a doc body.
 *
 * Each comment carries the selected text + character offsets so the
 * viewer can re-locate the highlight on render. Offsets are best-
 * effort against the current body (CRDT edits drift them); the
 * stored `quote` string is the fallback used to relocate if the
 * range no longer matches.
 *
 * Stored one JSON per doc at `data/comments/<docId>.json` (an array
 * of CommentRow). The dataset is tiny — comments per doc fit
 * comfortably in memory — so we don't bother with SQLite.
 */
import path from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export type Comment = {
  id: string
  docId: string
  /** Username of whoever wrote this comment. */
  author: string
  /** Comment body — plain text, no markdown rendering by design. */
  text: string
  /** Selected text the comment is anchored to. Stored verbatim so
   *  the viewer can fall back to text-search relocation when the
   *  offsets drift past the actual range (e.g. someone edited the
   *  paragraph above). */
  quote: string
  /** Character offsets into the doc body at write time. Best-effort
   *  on read — see `quote` above. */
  rangeStart: number
  rangeEnd: number
  createdAt: number
  /** Resolution flag. Resolved comments stay in the store (so the
   *  history is visible) but render in a muted style. */
  resolved: boolean
  resolvedAt: number | null
  resolvedBy: string | null
}

function commentsFile(docId: string): string {
  const safe = docId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(config.paths.comments, `${safe}.json`)
}

export async function listComments(docId: string): Promise<Comment[]> {
  try {
    const raw = await readFile(commentsFile(docId), 'utf8')
    const arr = JSON.parse(raw) as Comment[]
    return Array.isArray(arr) ? arr : []
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    return []
  }
}

async function writeComments(docId: string, rows: Comment[]): Promise<void> {
  await ensureDir(config.paths.comments)
  await writeFile(commentsFile(docId), JSON.stringify(rows, null, 2), 'utf8')
}

export async function createComment(input: {
  docId: string
  author: string
  text: string
  quote: string
  rangeStart: number
  rangeEnd: number
}): Promise<Comment> {
  const row: Comment = {
    id: nanoid(),
    docId: input.docId,
    author: input.author,
    text: input.text,
    quote: input.quote,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    createdAt: Date.now(),
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
  }
  const existing = await listComments(input.docId)
  await writeComments(input.docId, [...existing, row])
  return row
}

export async function deleteComment(
  docId: string,
  id: string,
): Promise<boolean> {
  const existing = await listComments(docId)
  const next = existing.filter((c) => c.id !== id)
  if (next.length === existing.length) return false
  if (next.length === 0) {
    await rm(commentsFile(docId), { force: true })
  } else {
    await writeComments(docId, next)
  }
  return true
}

export async function setCommentResolved(
  docId: string,
  id: string,
  resolved: boolean,
  actor: string,
): Promise<Comment | null> {
  const existing = await listComments(docId)
  const idx = existing.findIndex((c) => c.id === id)
  if (idx === -1) return null
  const updated: Comment = {
    ...existing[idx],
    resolved,
    resolvedAt: resolved ? Date.now() : null,
    resolvedBy: resolved ? actor : null,
  }
  const next = [...existing]
  next[idx] = updated
  await writeComments(docId, next)
  return updated
}

/** Delete every comment file for `docId`. Called when a doc is
 *  hard-deleted so the comments don't outlive the doc they
 *  anchored to. */
export async function dropAllCommentsForDoc(docId: string): Promise<void> {
  await rm(commentsFile(docId), { force: true })
}
