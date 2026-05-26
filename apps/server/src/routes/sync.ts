/**
 * Offline-sync HTTP transport. Two endpoints, both session-gated:
 *
 *   GET  /api/sync/pull?since=<lsn>&limit=<n>
 *     Returns owner-scoped changes after `since`, oldest first.
 *     Caller bumps its tracked lsn after each successful apply.
 *     Pagination via `limit` (default 500, capped 1000) — the
 *     response carries `hasMore` so the client knows to fetch
 *     again before treating itself as up-to-date.
 *
 *   POST /api/sync/push  { ops: [{ clientOpId, ...mutation }] }
 *     Applies a batch of client-queued mutations. Each op is
 *     idempotent via clientOpId, so a retry after a network
 *     failure can't double-apply. Returns per-op results so a
 *     conflict on one op doesn't sink the whole batch.
 *
 * Conflict resolution for body writes uses base_sha — the sha the
 * client *thought* the doc had when it started editing. If the
 * server's current sha doesn't match, the client's content is
 * written to a sibling `<path>.conflict-<unix>.md` rather than
 * lost (and the change log gets BOTH an `upsert` for the conflict
 * sibling AND a `conflict` result back to the caller).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import path from 'node:path'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import {
  isFrozenForArchive,
  listAllDocuments,
  saveMeta,
  sha256Of,
  userCanEdit,
} from '../stores/documents.js'
import { resolveUserVault } from '../lib/userVault.js'
import { ingestDocument } from '../services/ingest.js'
import { invalidateSearchCache } from '../services/search.js'
import { audit } from '../stores/audit.js'
import { dispatch as dispatchWebhook, markExpectedWrite } from '../services/webhooks.js'
import { publish as publishEvent } from '../services/events.js'
import {
  listChangesSince,
  maxLsnFor,
  recordChange,
} from '../services/syncChanges.js'
import { db } from '../db/sqlite.js'
import type { DocumentMeta } from '../types.js'

const PULL_LIMIT_DEFAULT = 500
const PULL_LIMIT_MAX = 1000

const pushOpSchema = z.object({
  /** Client-generated UUID/nanoid; same id retried is a no-op. */
  clientOpId: z.string().min(1).max(64),
  /** Vault-relative path. Matches `storage_key` in the docs table. */
  entityId: z.string().min(1).max(1024),
  /** One of the SyncChangeKind strings, but we only accept the
   *  ones that make sense to come *from* a client today. mkdir /
   *  rmdir / move land later. */
  kind: z.enum([
    'doc.upsert',
    'doc.delete',
    'doc.tags',
    'doc.visibility',
    'doc.archive',
  ]),
  /** For body upserts: sha256 the client had when it started
   *  editing. NULL is interpreted as "I created this doc offline"
   *  — server proceeds only if no doc at that path exists. */
  baseSha: z.string().nullable().optional(),
  /** Inline body for `doc.upsert`. UTF-8. Phase 1 limits this to
   *  markdown / text; binary uploads use the normal upload route
   *  even when offline-resumed. */
  content: z.string().optional(),
  /** New tag list for `doc.tags`. */
  tags: z.array(z.string()).optional(),
  /** New public flag for `doc.visibility`. */
  public: z.boolean().optional(),
  /** New archived flag for `doc.archive`. */
  archived: z.boolean().optional(),
})

type PushResult =
  | { clientOpId: string; result: 'applied'; lsn: number; sha256?: string }
  | { clientOpId: string; result: 'duplicate'; lsn: number }
  | {
      clientOpId: string
      result: 'conflict'
      /** Path the loser landed at; non-null for body conflicts. */
      conflictPath: string
      lsn: number
    }
  | { clientOpId: string; result: 'error'; error: string }

export async function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)

  app.get('/api/sync/pull', async (req) => {
    const user = req.currentUser!
    const q = req.query as { since?: string; limit?: string }
    const since = Number.parseInt(q.since ?? '0', 10) || 0
    const requested = Number.parseInt(q.limit ?? '', 10)
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, PULL_LIMIT_MAX)
        : PULL_LIMIT_DEFAULT
    // Pull one extra row to detect `hasMore` without a second
    // COUNT query — common trick to avoid the awkward "did I get
    // exactly `limit` rows, is there more?" ambiguity.
    const rows = listChangesSince(user.username, since, limit + 1)
    const hasMore = rows.length > limit
    const changes = hasMore ? rows.slice(0, limit) : rows
    return {
      changes,
      hasMore,
      head: maxLsnFor(user.username),
    }
  })

  app.post('/api/sync/push', async (req, reply) => {
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = z.object({ ops: z.array(pushOpSchema).max(200) }).parse(req.body)
    const results: PushResult[] = []
    for (const op of body.ops) {
      try {
        const r = await applyPushOp(op, user.username, user.role)
        results.push(r)
      } catch (e) {
        results.push({
          clientOpId: op.clientOpId,
          result: 'error',
          error: (e as Error).message ?? 'push failed',
        })
      }
    }
    return { results }
  })
}

type PushOp = z.infer<typeof pushOpSchema>

async function applyPushOp(
  op: PushOp,
  username: string,
  role: 'admin' | 'editor' | 'viewer',
): Promise<PushResult> {
  const rel = op.entityId.replace(/^\/+|\/+$/g, '')
  if (!rel) throw new Error('entityId resolves to empty path')
  // Idempotency: if we already saw this clientOpId for this owner,
  // short-circuit. Without this, a retry would walk the conflict
  // path again (meta now exists with the first apply's bytes, the
  // client's baseSha is still the pre-apply value → second call
  // sees a "stale" base and lands a needless conflict file).
  const seen = db()
    .prepare(
      `SELECT lsn FROM sync_changes WHERE owner = ? AND client_op_id = ?`,
    )
    .get(username, op.clientOpId) as { lsn: number } | undefined
  if (seen) return { clientOpId: op.clientOpId, result: 'duplicate', lsn: seen.lsn }

  // Look up the current meta to (a) decide who can edit, (b)
  // compare base_sha for body writes, (c) detect existing-path
  // collisions on offline-created docs.
  const docs = await listAllDocuments()
  const meta = docs.find((d: DocumentMeta) => d.storageKey === rel && d.owner === username)
  if (meta && !userCanEdit(meta, username, role)) {
    return { clientOpId: op.clientOpId, result: 'error', error: 'forbidden' }
  }
  if (meta && isFrozenForArchive(meta) && op.kind !== 'doc.archive') {
    return {
      clientOpId: op.clientOpId,
      result: 'error',
      error: 'document is archived — unarchive to apply offline edits',
    }
  }

  if (op.kind === 'doc.upsert') {
    return await applyUpsert(op, username, meta ?? null, rel)
  }
  if (op.kind === 'doc.tags') {
    if (!meta) return { clientOpId: op.clientOpId, result: 'error', error: 'document not found' }
    const tags = op.tags ?? []
    const next: DocumentMeta = { ...meta, tags, updatedAt: Date.now() }
    await saveMeta(next)
    invalidateSearchCache()
    const r = recordChange({
      owner: username,
      actor: username,
      entityId: rel,
      clientOpId: op.clientOpId,
      payload: { kind: 'doc.tags', tags },
    })
    publishEvent({ type: 'tags', path: rel, tags })
    return { clientOpId: op.clientOpId, result: r.duplicate ? 'duplicate' : 'applied', lsn: r.lsn }
  }
  if (op.kind === 'doc.visibility') {
    if (!meta) return { clientOpId: op.clientOpId, result: 'error', error: 'document not found' }
    const isPublic = !!op.public
    const next: DocumentMeta = { ...meta, public: isPublic, updatedAt: Date.now() }
    await saveMeta(next)
    invalidateSearchCache()
    const r = recordChange({
      owner: username,
      actor: username,
      entityId: rel,
      clientOpId: op.clientOpId,
      payload: { kind: 'doc.visibility', public: isPublic },
    })
    publishEvent({ type: 'visibility', path: rel, public: isPublic })
    return { clientOpId: op.clientOpId, result: r.duplicate ? 'duplicate' : 'applied', lsn: r.lsn }
  }
  if (op.kind === 'doc.archive') {
    if (!meta) return { clientOpId: op.clientOpId, result: 'error', error: 'document not found' }
    const archived = !!op.archived
    const next: DocumentMeta = {
      ...meta,
      archived,
      archivedAt: archived ? Date.now() : null,
      updatedAt: Date.now(),
    }
    await saveMeta(next)
    invalidateSearchCache()
    const r = recordChange({
      owner: username,
      actor: username,
      entityId: rel,
      clientOpId: op.clientOpId,
      payload: { kind: 'doc.archive', archived },
    })
    publishEvent({ type: 'archive', path: rel, archived })
    return { clientOpId: op.clientOpId, result: r.duplicate ? 'duplicate' : 'applied', lsn: r.lsn }
  }
  if (op.kind === 'doc.delete') {
    // Offline trash carries enough side-effects (blob move, snapshot,
    // entries-table row) that we don't reimplement it here. Clients
    // re-issue the delete against /api/file/trash once they're back
    // online; sync only logs the intent so other devices see it.
    return {
      clientOpId: op.clientOpId,
      result: 'error',
      error: 'offline delete not supported in push; use /api/file/trash when online',
    }
  }
  return { clientOpId: op.clientOpId, result: 'error', error: `unsupported kind: ${op.kind}` }
}

async function applyUpsert(
  op: PushOp,
  username: string,
  meta: DocumentMeta | null,
  rel: string,
): Promise<PushResult> {
  if (typeof op.content !== 'string') {
    return { clientOpId: op.clientOpId, result: 'error', error: 'content required for doc.upsert' }
  }
  if (!/\.(md|markdown|mdx|txt|csv|json)$/i.test(rel)) {
    return {
      clientOpId: op.clientOpId,
      result: 'error',
      error: 'offline upsert only supported for text documents',
    }
  }
  const abs = resolveUserVault(username, rel)
  const buffer = Buffer.from(op.content, 'utf8')
  const newSha = sha256Of(buffer)

  // Case A: client created a new doc offline. Apply only if no
  // doc exists at this path. Anything else is a true collision —
  // route the offline copy to a sibling so neither author loses
  // bytes.
  if (!meta) {
    const existsOnDisk = await stat(abs).catch(() => null)
    if (existsOnDisk) {
      return await landConflict(op, username, rel, buffer, newSha)
    }
    await mkdir(path.dirname(abs), { recursive: true })
    markExpectedWrite(abs, newSha)
    await writeFile(abs, buffer)
    const now = Date.now()
    const fresh: DocumentMeta = {
      id: nanoid(),
      owner: username,
      storageKey: rel,
      title: path.basename(rel, path.extname(rel)),
      originalFilename: path.basename(rel),
      mime: 'text/markdown',
      bytes: buffer.length,
      sha256: newSha,
      createdAt: now,
      updatedAt: now,
      acl: { readers: [], editors: [] },
      tags: [],
      ingest: { status: 'pending', embedded: false },
    } as unknown as DocumentMeta
    await saveMeta(fresh)
    await ingestDocument(fresh, buffer)
    invalidateSearchCache()
    const r = recordChange({
      owner: username,
      actor: username,
      entityId: rel,
      clientOpId: op.clientOpId,
      payload: {
        kind: 'doc.upsert',
        sha256: newSha,
        bytes: buffer.length,
        source: 'web',
      },
    })
    await audit({
      actor: username,
      action: 'sync.create',
      target: rel,
      meta: { bytes: buffer.length, sha256: newSha },
    })
    dispatchWebhook({
      type: 'upload',
      path: rel,
      actor: username,
      bytes: buffer.length,
    }).catch(() => null)
    publishEvent({ type: 'edit', path: rel, docId: fresh.id })
    return {
      clientOpId: op.clientOpId,
      result: r.duplicate ? 'duplicate' : 'applied',
      lsn: r.lsn,
      sha256: newSha,
    }
  }

  // Case B: client edited an existing doc. baseSha must match
  // the server's current sha; otherwise someone else (or the
  // user from a different device) wrote in the meantime —
  // preserve their work, land ours to a conflict sibling.
  if (!op.baseSha || op.baseSha !== meta.sha256) {
    return await landConflict(op, username, rel, buffer, newSha)
  }
  // Fast path: no-op if the content didn't actually change. Keeps
  // the change log clean when a client replays an edit it already
  // had locally.
  if (newSha === meta.sha256) {
    const r = recordChange({
      owner: username,
      actor: username,
      entityId: rel,
      clientOpId: op.clientOpId,
      payload: { kind: 'doc.upsert', sha256: newSha, bytes: buffer.length, source: 'web' },
    })
    return { clientOpId: op.clientOpId, result: r.duplicate ? 'duplicate' : 'applied', lsn: r.lsn, sha256: newSha }
  }
  // Snapshot the pre-edit version so the user has an undo path.
  const { snapshotVersion } = await import('../stores/versions.js')
  await snapshotVersion(meta.id).catch(() => null)
  markExpectedWrite(abs, newSha)
  await writeFile(abs, buffer)
  const next: DocumentMeta = {
    ...meta,
    bytes: buffer.length,
    sha256: newSha,
    updatedAt: Date.now(),
    ingest: { status: 'pending', embedded: false },
  }
  await saveMeta(next)
  await ingestDocument(next, buffer)
  invalidateSearchCache()
  const r = recordChange({
    owner: username,
    actor: username,
    entityId: rel,
    clientOpId: op.clientOpId,
    payload: {
      kind: 'doc.upsert',
      sha256: newSha,
      bytes: buffer.length,
      source: 'web',
    },
  })
  await audit({
    actor: username,
    action: 'sync.edit',
    target: rel,
    meta: { bytes: buffer.length, sha256: newSha, baseSha: op.baseSha },
  })
  dispatchWebhook({
    type: 'edit',
    path: rel,
    actor: username,
    bytes: buffer.length,
    source: 'web',
  }).catch(() => null)
  publishEvent({ type: 'edit', path: rel, docId: meta.id })
  return {
    clientOpId: op.clientOpId,
    result: r.duplicate ? 'duplicate' : 'applied',
    lsn: r.lsn,
    sha256: newSha,
  }
}

/** When a client's offline write loses the race, drop its bytes
 *  to a sibling `<path>.conflict-<unix>.md` so neither author's
 *  work disappears. The user resolves manually — open both, merge
 *  what they want, delete the conflict file. */
async function landConflict(
  op: PushOp,
  username: string,
  rel: string,
  buffer: Buffer,
  sha: string,
): Promise<PushResult> {
  const ext = path.extname(rel) || '.md'
  const stem = rel.slice(0, rel.length - ext.length)
  const ts = Math.floor(Date.now() / 1000)
  const conflictRel = `${stem}.conflict-${ts}${ext}`
  const abs = resolveUserVault(username, conflictRel)
  await mkdir(path.dirname(abs), { recursive: true })
  markExpectedWrite(abs, sha)
  await writeFile(abs, buffer)
  const now = Date.now()
  const conflictMeta: DocumentMeta = {
    id: nanoid(),
    owner: username,
    storageKey: conflictRel,
    title: `${path.basename(stem)} (conflict)`,
    originalFilename: path.basename(conflictRel),
    mime: 'text/markdown',
    bytes: buffer.length,
    sha256: sha,
    createdAt: now,
    updatedAt: now,
    acl: { readers: [], editors: [] },
    tags: ['conflict'],
    ingest: { status: 'pending', embedded: false },
  } as unknown as DocumentMeta
  await saveMeta(conflictMeta)
  await ingestDocument(conflictMeta, buffer)
  invalidateSearchCache()
  // Record under the ORIGINAL path so the client knows which
  // doc the conflict relates to; the conflict file's own upsert
  // also gets emitted so a different client can pull it.
  const r = recordChange({
    owner: username,
    actor: username,
    entityId: rel,
    clientOpId: op.clientOpId,
    payload: {
      kind: 'doc.upsert',
      sha256: sha,
      bytes: buffer.length,
      source: 'web',
    },
  })
  recordChange({
    owner: username,
    actor: username,
    entityId: conflictRel,
    payload: {
      kind: 'doc.upsert',
      sha256: sha,
      bytes: buffer.length,
      source: 'web',
    },
  })
  await audit({
    actor: username,
    action: 'sync.conflict',
    target: rel,
    meta: {
      conflictPath: conflictRel,
      baseSha: op.baseSha ?? null,
      newSha: sha,
    },
  })
  publishEvent({ type: 'edit', path: conflictRel, docId: conflictMeta.id })
  return {
    clientOpId: op.clientOpId,
    result: 'conflict',
    conflictPath: conflictRel,
    lsn: r.lsn,
  }
}
