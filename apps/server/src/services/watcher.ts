import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { nanoid } from 'nanoid'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import {
  deleteDocument,
  listAllDocuments,
  saveMeta,
  sha256Of,
} from '../stores/documents.js'
import { ingestDocument } from './ingest.js'
import { invalidateSearchCache } from './search.js'
import { ownerFromAbs } from '../lib/userVault.js'
import type { DocumentMeta } from '../types.js'

const SUPPORTED_EXTS = new Set([
  '.md', '.markdown', '.mdx',
  '.txt', '.csv', '.json', '.yaml', '.yml', '.toml', '.html', '.htm',
  '.pdf',
  '.docx',
  '.xlsx', '.xls',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.avif', '.bmp', '.ico', '.tiff', '.tif', '.jxl',
  '.heic', '.heif',
  '.mp4', '.mov', '.m4v', '.mkv', '.webm',
  '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
])

const MIMES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

let current: FSWatcher | null = null
let currentRoot: string | null = null
const debounces = new Map<string, NodeJS.Timeout>()

function isSupported(rel: string): boolean {
  if (!rel) return false
  // Skip hidden files / dotfile components anywhere in the path.
  if (rel.split('/').some((p) => p.startsWith('.'))) return false
  const ext = path.extname(rel).toLowerCase()
  return SUPPORTED_EXTS.has(ext)
}

export async function reingestPath(absPath: string, log: FastifyBaseLogger): Promise<void> {
  // Derive the owner from the path's leading username segment. Loose files
  // sitting directly under the shared root (no owner segment) are ignored —
  // they're either marker files or pre-migration leftovers.
  const owned = ownerFromAbs(absPath)
  if (!owned) return
  const { owner, rel } = owned
  if (!isSupported(rel)) return
  let buffer: Buffer
  let s
  try {
    s = await stat(absPath)
    if (!s.isFile()) return
    buffer = await readFile(absPath)
  } catch {
    return
  }
  const sha = sha256Of(buffer)
  const docs = await listAllDocuments()
  const existing = docs.find((d) => d.storageKey === rel && d.owner === owner)
  // No-op if disk content matches stored sha — saves work when the daemon
  // itself triggered the write (uploads, our own ingest writes, etc.).
  //
  // Special case: stub metas created by visibility/tag endpoints write
  // sha256: ''. Those shouldn't trigger a re-ingest on the next
  // chokidar event for an unchanged file. Backfill the real sha into
  // the stub and skip the re-ingest.
  if (existing && existing.sha256 === sha) return
  if (existing && existing.sha256 === '') {
    await saveMeta({ ...existing, sha256: sha, bytes: buffer.length, updatedAt: Date.now() })
    return
  }
  const id = existing?.id ?? nanoid()
  const filename = path.basename(absPath)
  const meta: DocumentMeta = {
    id,
    title: existing?.title ?? filename.replace(/\.[^.]+$/, ''),
    originalFilename: filename,
    mime: MIMES[path.extname(filename).toLowerCase()] || existing?.mime || 'application/octet-stream',
    bytes: buffer.length,
    sha256: sha,
    storageKey: rel,
    owner: existing?.owner ?? owner,
    acl: existing?.acl ?? { readers: [], editors: [] },
    public: existing?.public,
    // Preserve share-link state across in-place file edits — otherwise a
    // user editing the markdown of a published file silently strips the
    // expiry/password.
    publicExpiresAt: existing?.publicExpiresAt ?? null,
    publicPasswordHash: existing?.publicPasswordHash ?? null,
    tags: existing?.tags ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    ingest: { status: 'pending', embedded: false },
  }
  // Snapshot the current meta + text + chunks before we overwrite them. Only
  // for existing docs — first-time ingest has nothing to preserve.
  if (existing) {
    const { snapshotVersion } = await import('../stores/versions.js')
    await snapshotVersion(existing.id).catch(() => null)
  }
  await saveMeta(meta)
  // Distinguish first-time-seen vs. content edit so the activity log shows
  // "Uploaded" vs. "Edited on disk" for the same file. We don't know the
  // editor's identity from the filesystem, so attribute to "system".
  const { audit } = await import('../stores/audit.js')
  await audit({
    actor: 'system',
    action: existing ? 'vault.edit' : 'vault.upload',
    target: rel,
    meta: { source: 'watcher', bytes: buffer.length },
  })
  // Outbound webhook. Audit attributes to "system" (we don't know
  // who saved the file on disk), but for webhook routing we use the
  // file's `owner` so per-user subscriptions still get notified when
  // their own files change.
  //
  // Skip the dispatch if an in-app writer (chat apply-edit, MCP edit
  // op) registered this exact sha as an expected write — they
  // already fired the webhook themselves and we don't want
  // subscribers to see two events for one user action.
  const { dispatch: dispatchWebhook, consumeExpectedWrite } = await import(
    './webhooks.js'
  )
  const dedup = consumeExpectedWrite(absPath, sha)
  if (existing) {
    if (!dedup) {
      dispatchWebhook({
        type: 'edit',
        path: rel,
        actor: owner,
        bytes: buffer.length,
        source: 'watcher',
      }).catch(() => null)
    }
  } else if (!dedup) {
    dispatchWebhook({
      type: 'upload',
      path: rel,
      actor: owner,
      bytes: buffer.length,
    }).catch(() => null)
  }
  try {
    await ingestDocument(meta, buffer)
    log.info({ rel }, 'watcher: re-ingested')
  } catch (err) {
    log.warn({ err, rel }, 'watcher: re-ingest failed')
  }
}

async function dropPath(absPath: string, log: FastifyBaseLogger): Promise<void> {
  const owned = ownerFromAbs(absPath)
  if (!owned) return
  const { owner, rel } = owned
  if (!rel) return
  const docs = await listAllDocuments()
  const meta = docs.find((d) => d.storageKey === rel && d.owner === owner)
  if (!meta) return
  await deleteDocument(meta.id)
  invalidateSearchCache()
  log.info({ owner, rel }, 'watcher: dropped index for deleted file')
}

function schedule(absPath: string, action: () => Promise<void>): void {
  const prev = debounces.get(absPath)
  if (prev) clearTimeout(prev)
  // ~250ms debounce per path catches editor save bursts (atomic rename + chmod).
  const t = setTimeout(() => {
    debounces.delete(absPath)
    action().catch(() => null)
  }, 250)
  debounces.set(absPath, t)
}

export async function startVaultWatcher(log: FastifyBaseLogger): Promise<void> {
  const root = path.resolve(config.vault.root)
  if (current && currentRoot === root) return
  await stopVaultWatcher()
  currentRoot = root
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p) => path.basename(p).startsWith('.'),
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  })
  watcher
    .on('add', (p) => schedule(p, () => reingestPath(p, log)))
    .on('change', (p) => schedule(p, () => reingestPath(p, log)))
    .on('unlink', (p) => schedule(p, () => dropPath(p, log)))
    .on('error', (err) => log.warn({ err }, 'vault watcher error'))
  current = watcher
  log.info({ root }, 'vault watcher started')
}

export async function stopVaultWatcher(): Promise<void> {
  if (!current) return
  await current.close().catch(() => null)
  current = null
  currentRoot = null
  for (const t of debounces.values()) clearTimeout(t)
  debounces.clear()
}

/** Restart the watcher; call after the vault-root setting changes. */
export function restartVaultWatcher(log: FastifyBaseLogger): void {
  startVaultWatcher(log).catch((err) => log.warn({ err }, 'vault watcher restart failed'))
}

/**
 * One-shot full reconcile: walk the vault root, find every supported
 * file on disk, and re-ingest anything the documents table doesn't
 * have. Mirrors what `ignoreInitial: false` would do at watcher boot
 * but as an explicit user action — useful for recovering from
 * external file drops (Finder, rsync, git clone) or recovering after
 * a buggy bulk-delete (the previous `/api/account/reembed` path bug
 * that nuked rows for files still on disk).
 *
 * Optionally scoped to a single owner so an admin can reconcile one
 * user's vault without scanning everyone's tree.
 */
export async function reconcileVault(
  log: FastifyBaseLogger,
  opts: { ownerOnly?: string } = {},
): Promise<{ scanned: number; ingested: number; updated: number; skipped: number }> {
  const root = config.vault.root
  const counts = { scanned: 0, ingested: 0, updated: 0, skipped: 0 }

  // Pre-snapshot the documents table so we can detect new-on-disk
  // files vs. already-indexed without a per-file SQL hit.
  const existing = new Map<string, DocumentMeta>()
  for (const d of await listAllDocuments()) {
    existing.set(`${d.owner}::${d.storageKey}`, d)
  }

  // Walk top-level user folders. The vault root holds one directory
  // per username; loose files under root aren't owned by anyone and
  // are ignored (matches `ownerFromAbs` semantics).
  let topEntries: import('node:fs').Dirent[]
  try {
    topEntries = await readdir(root, { withFileTypes: true })
  } catch {
    return counts
  }

  const walk = async (
    dir: string,
    owner: string,
  ): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(abs, owner)
        continue
      }
      if (!e.isFile()) continue
      const rel = path.relative(path.join(root, owner), abs)
      if (!isSupported(rel)) continue
      counts.scanned++
      const key = `${owner}::${rel}`
      const hadRow = existing.has(key)
      try {
        // reingestPath is a no-op when on-disk sha matches stored sha,
        // so already-indexed files cost just a stat + read + sha
        // compare. Missing rows get a fresh ingest.
        await reingestPath(abs, log)
        if (hadRow) counts.updated++
        else counts.ingested++
      } catch (err) {
        log.warn({ err, rel }, 'reconcile: ingest failed')
        counts.skipped++
      }
    }
  }

  for (const top of topEntries) {
    if (!top.isDirectory()) continue
    if (top.name.startsWith('.')) continue
    if (opts.ownerOnly && top.name !== opts.ownerOnly) continue
    await walk(path.join(root, top.name), top.name)
  }
  return counts
}
