import { readFile, stat } from 'node:fs/promises'
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
import type { DocumentMeta } from '../types.js'

const SUPPORTED_EXTS = new Set([
  '.md', '.markdown', '.mdx',
  '.txt', '.csv', '.json', '.yaml', '.yml', '.toml', '.html', '.htm',
  '.pdf',
  '.docx',
  '.xlsx', '.xls',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
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

function vaultRel(abs: string): string {
  const root = path.resolve(config.vault.root)
  const a = path.resolve(abs)
  if (a === root) return ''
  if (!a.startsWith(root + path.sep)) return ''
  return a.slice(root.length + 1)
}

function isSupported(rel: string): boolean {
  if (!rel) return false
  // Skip hidden files / dotfile components anywhere in the path.
  if (rel.split('/').some((p) => p.startsWith('.'))) return false
  const ext = path.extname(rel).toLowerCase()
  return SUPPORTED_EXTS.has(ext)
}

async function reingestPath(absPath: string, log: FastifyBaseLogger): Promise<void> {
  const rel = vaultRel(absPath)
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
  const existing = docs.find((d) => d.storageKey === rel)
  // No-op if disk content matches stored sha — saves work when the daemon
  // itself triggered the write (uploads, our own ingest writes, etc.).
  if (existing && existing.sha256 === sha) return
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
    owner: existing?.owner ?? 'system',
    acl: existing?.acl ?? { readers: [], editors: [] },
    public: existing?.public,
    tags: existing?.tags ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    ingest: { status: 'pending', embedded: false },
  }
  await saveMeta(meta)
  try {
    await ingestDocument(meta, buffer)
    log.info({ rel }, 'watcher: re-ingested')
  } catch (err) {
    log.warn({ err, rel }, 'watcher: re-ingest failed')
  }
}

async function dropPath(absPath: string, log: FastifyBaseLogger): Promise<void> {
  const rel = vaultRel(absPath)
  if (!rel) return
  const docs = await listAllDocuments()
  const meta = docs.find((d) => d.storageKey === rel)
  if (!meta) return
  await deleteDocument(meta.id)
  invalidateSearchCache()
  log.info({ rel }, 'watcher: dropped index for deleted file')
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
