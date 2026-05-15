/**
 * Vault routes — Obsidian-style. The vault is a normal directory on disk;
 * every path the API surfaces is vault-relative ("foo/bar.pdf"). Resolved
 * paths are validated to stay inside the vault before any I/O.
 *
 * Endpoints:
 *   GET    /api/home                    → vault root + separator (still useful for the UI)
 *   GET    /api/list?path=<rel>         → tree contents at <rel> (default = vault root)
 *   GET    /api/file/text?path=<rel>    → utf-8 text (md / txt / extracted text for binaries if indexed)
 *   GET    /api/file/raw?path=<rel>     → raw bytes with proper Content-Type
 *   POST   /api/file/upload             → multipart, optional `path` field = target dir, runs ingest
 *   POST   /api/file/index              → re-run ingest for an existing vault file
 *   DELETE /api/file?path=<rel>         → delete file from vault + drop its index
 *   POST   /api/folder?path=<rel>       → mkdir
 */
import path from 'node:path'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { nanoid } from 'nanoid'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { audit } from '../stores/audit.js'
import {
  deleteDocument,
  listAllDocuments,
  readText as readExtracted,
  readThumbnail,
  readPreview,
  saveMeta,
  sha256Of,
  userCanRead,
  userCanEdit,
} from '../stores/documents.js'
import { generateThumbnail } from '../services/thumbnail.js'
import { writeThumbnail, writePreview } from '../stores/documents.js'
import { moveToTrash } from '../stores/trash.js'
import { ingestDocument } from '../services/ingest.js'
import { userCan, canNavigateTo } from '../lib/grants.js'
import { invalidateSearchCache } from '../services/search.js'
import type { DocumentMeta } from '../types.js'

// ─── path helpers ───────────────────────────────────────────────────────────

function resolveVault(rel: string | undefined): string {
  const r = (rel ?? '').replace(/^\/+/, '')
  // Refuse traversal explicitly even though resolve() normalizes it.
  if (r.includes('..')) throw httpErr(400, 'invalid path')
  const abs = path.resolve(config.vault.root, r)
  const root = path.resolve(config.vault.root)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw httpErr(403, 'path outside vault')
  }
  return abs
}

function toVaultRel(abs: string): string {
  const root = path.resolve(config.vault.root)
  const a = path.resolve(abs)
  if (a === root) return ''
  if (!a.startsWith(root + path.sep)) throw new Error('not inside vault')
  return a.slice(root.length + 1)
}

function httpErr(status: number, message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number }
  e.statusCode = status
  return e
}

// ─── tree types ─────────────────────────────────────────────────────────────

const SUPPORTED_EXTS = new Set([
  // text & docs
  '.md', '.markdown', '.mdx',
  '.txt', '.csv', '.json', '.yaml', '.yml', '.toml', '.html', '.htm',
  '.pdf',
  '.docx',
  '.xlsx', '.xls',
  // images
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.avif', '.bmp', '.ico', '.tiff', '.tif', '.jxl',
  '.heic', '.heif',
  // videos
  '.mp4', '.mov', '.m4v', '.mkv', '.webm',
  '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
])

function shouldSkipName(name: string): boolean {
  if (name.startsWith('.')) return true
  if (name === 'node_modules' || name === 'dist' || name === 'build') return true
  return false
}

type TreeNode = {
  name: string
  /** vault-relative path, "" for root */
  path: string
  type: 'dir' | 'file'
  ext?: string
  size?: number
  mtime?: number
  hasChildren?: boolean
  /** populated when an index exists for this file */
  docId?: string
  ingestStatus?: string
  embedded?: boolean
  public?: boolean
}

// ─── filename helpers ───────────────────────────────────────────────────────

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\- ()]+/g, '_').replace(/^[ ._]+/, '')
  if (!base || base === '.' || base === '..') return 'file'
  return base
}

async function uniquePath(targetDir: string, filename: string): Promise<string> {
  const ext = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length) || 'file'
  let attempt = 0
  while (true) {
    const candidate = attempt === 0 ? filename : `${stem} (${attempt})${ext}`
    const full = path.join(targetDir, candidate)
    try {
      await stat(full)
      attempt++
    } catch (e: any) {
      if (e?.code === 'ENOENT') return full
      throw e
    }
  }
}

function inferMime(filename: string, fallback?: string): string {
  const ext = path.extname(filename).toLowerCase()
  const m: Record<string, string> = {
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
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.jxl': 'image/jxl',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.3gp': 'video/3gpp',
    '.3gpp': 'video/3gpp',
    '.mts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.ogv': 'video/ogg',
  }
  return m[ext] || fallback || 'application/octet-stream'
}

// ─── routes ─────────────────────────────────────────────────────────────────

export async function vaultRoutes(app: FastifyInstance) {
  // Tiny inline auth helper for routes we don't want behind the global preHandler
  // (raw / text / meta are publicly readable when meta.public === true).
  const requireAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!req.currentUser) {
      reply.code(401).send({ error: 'auth required' })
      return false
    }
    return true
  }

  // ---- meta -----------------------------------------------------------------

  app.get('/api/home', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    return { vault: config.vault.root, separator: path.sep }
  })

  // Recursive list of every folder path in the vault — used by client-side
  // autocomplete in the ⌘K palette (new-folder mode).
  app.get('/api/folders', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const out: string[] = []
    async function walk(absDir: string, rel: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (shouldSkipName(e.name)) continue
        if (!e.isDirectory()) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        out.push(childRel)
        await walk(path.join(absDir, e.name), childRel)
      }
    }
    await walk(config.vault.root, '')
    out.sort()
    return { folders: out }
  })

  // Full vault tree (folders + files) — used by the permission picker UI so
  // admins can grant access on either a folder or an individual file.
  app.get('/api/vault-tree', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const folders: string[] = []
    const files: string[] = []
    async function walk(absDir: string, rel: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (shouldSkipName(e.name)) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          folders.push(childRel)
          await walk(path.join(absDir, e.name), childRel)
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase()
          if (!SUPPORTED_EXTS.has(ext)) continue
          files.push(childRel)
        }
      }
    }
    await walk(config.vault.root, '')
    folders.sort()
    files.sort()
    return { folders, files }
  })

  // ---- list -----------------------------------------------------------------

  app.get('/api/list', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { path: rel = '' } = req.query as { path?: string }
    if (!canNavigateTo(user, rel)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const dir = resolveVault(rel)

    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { path: rel, items: [] }
      throw e
    }

    // Build a map of vault-rel path → indexed-doc meta so we can decorate the tree.
    const docs = await listAllDocuments()
    const indexedByPath = new Map<string, DocumentMeta>()
    for (const d of docs) {
      if (d.storageKey) indexedByPath.set(d.storageKey, d)
    }

    const items: TreeNode[] = []
    for (const e of entries) {
      if (shouldSkipName(e.name)) continue
      const abs = path.join(dir, e.name)
      const childRel = toVaultRel(abs)
      if (e.isDirectory()) {
        // Hide subfolders the user can't read or navigate into.
        if (!canNavigateTo(user, childRel)) continue
        items.push({ name: e.name, path: childRel, type: 'dir', hasChildren: true })
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!SUPPORTED_EXTS.has(ext)) continue
        // Hide files the user can't read (unless they're public).
        const indexed = indexedByPath.get(childRel)
        if (!userCan(user, 'read', childRel) && !indexed?.public) continue
        let size: number | undefined, mtime: number | undefined
        try {
          const s = await stat(abs)
          size = s.size
          mtime = s.mtimeMs
        } catch { /* skip */ }
        items.push({
          name: e.name,
          path: childRel,
          type: 'file',
          ext,
          size,
          mtime,
          docId: indexed?.id,
          ingestStatus: indexed?.ingest.status,
          embedded: indexed?.ingest.embedded,
          public: indexed?.public ?? false,
        })
      }
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { path: rel, items }
  })

  // ---- read -----------------------------------------------------------------

  app.get('/api/file/text', async (req, reply) => {
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)

    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)

    // Allow without auth if explicitly public; otherwise require user + read access
    // (grant on the path OR file ACL).
    if (!meta?.public) {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      const aclOk = !meta || userCanRead(meta, u.username, u.role)
      const grantOk = userCan(u, 'read', rel)
      if (!aclOk && !grantOk) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }

    const ext = path.extname(abs).toLowerCase()
    // Native text types — read from disk directly so md/txt edits show without re-ingest.
    if (['.md', '.markdown', '.mdx', '.txt', '.csv', '.json', '.html', '.htm', '.yaml', '.yml', '.toml'].includes(ext)) {
      const buffer = await readFile(abs)
      const text = buffer.toString('utf8')
      const s = await stat(abs)
      // First-read auto-ingest: if this vault file has never been embedded, kick
      // off a background ingest so it shows up in semantic search next time.
      if ((!meta || !meta.ingest.embedded) && req.currentUser) {
        const u = req.currentUser
        ;(async () => {
          try {
            const docsNow = await listAllDocuments()
            const existing = docsNow.find((d) => d.storageKey === rel)
            const id = existing?.id ?? nanoid()
            const filename = path.basename(abs)
            const seed: DocumentMeta = {
              id,
              title: existing?.title ?? filename.replace(/\.[^.]+$/, ''),
              originalFilename: filename,
              mime: inferMime(filename),
              bytes: buffer.length,
              sha256: sha256Of(buffer),
              storageKey: rel,
              owner: existing?.owner ?? u.username,
              acl: existing?.acl ?? { readers: [], editors: [] },
              public: existing?.public,
              tags: existing?.tags ?? [],
              createdAt: existing?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
              ingest: { status: 'pending', embedded: false },
            }
            await saveMeta(seed)
            await ingestDocument(seed, buffer)
          } catch (e) {
            req.log?.warn({ err: e }, `auto-ingest failed for ${rel}`)
          }
        })()
      }
      return { path: rel, content: text, size: s.size, mtime: s.mtimeMs }
    }
    // Binary types — return extracted text from the index, if any.
    if (!meta) return reply.code(404).send({ error: 'not indexed; use /api/file/raw' })
    const text = (await readExtracted(meta.id)) ?? ''
    const s = await stat(abs)
    return { path: rel, content: text, size: s.size, mtime: s.mtimeMs, docId: meta.id }
  })

  app.get('/api/file/raw', async (req, reply) => {
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })

    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (!meta?.public) {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }

    const mime = inferMime(abs)
    const disposition = `inline; filename="${path.basename(abs).replace(/"/g, '')}"`

    // Range support — needed for HTML5 <video>, which sends `Range: bytes=...`
    // to seek. Without 206 responses Safari refuses to play altogether.
    const range = (req.headers.range || '') as string
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      const total = s.size
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${total}`)
          .send({ error: 'range not satisfiable' })
      }
      return reply
        .code(206)
        .header('Content-Type', mime)
        .header('Content-Length', String(end - start + 1))
        .header('Content-Range', `bytes ${start}-${end}/${total}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Disposition', disposition)
        .send(createReadStream(abs, { start, end }))
    }

    return reply
      .header('Content-Type', mime)
      .header('Content-Length', String(s.size))
      .header('Accept-Ranges', 'bytes')
      .header('Content-Disposition', disposition)
      .send(createReadStream(abs))
  })

  // Display-friendly version of a file. For HEIC this returns the JPEG we
  // generated at ingest so browsers can render it; for everything else it
  // streams the raw bytes. Use /api/file/raw when you want the original
  // (e.g., download links).
  app.get('/api/file/preview', async (req, reply) => {
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })

    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (!meta?.public) {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }

    const { isImageNeedingTranscode, isVideo, transcodeImageToJpeg, videoFrameAt } =
      await import('../services/media.js')
    const needsServerPreview = isImageNeedingTranscode(abs) || isVideo(abs)

    if (needsServerPreview) {
      if (meta) {
        const cached = await readPreview(meta.id)
        if (cached) {
          return reply
            .header('Content-Type', 'image/jpeg')
            .header('Cache-Control', 'private, max-age=86400')
            .send(cached)
        }
      }
      // On-demand for files ingested before preview generation was wired.
      try {
        const buffer = await readFile(abs)
        const jpeg = isVideo(abs)
          ? await videoFrameAt(buffer, abs)
          : await transcodeImageToJpeg(buffer, abs)
        if (!jpeg) return reply.code(415).send({ error: 'preview decode failed' })
        if (meta) await writePreview(meta.id, jpeg).catch(() => null)
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'private, max-age=86400')
          .send(jpeg)
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message ?? 'preview failed' })
      }
    }

    // Browser-renderable: just stream the original bytes inline.
    return reply
      .header('Content-Type', inferMime(abs))
      .header('Content-Length', String(s.size))
      .header('Content-Disposition', `inline; filename="${path.basename(abs).replace(/"/g, '')}"`)
      .send(createReadStream(abs))
  })

  // Tiny PNG preview for the folder grid. Cached on disk per doc. If the
  // thumbnail hasn't been generated yet, we render-on-demand and persist.
  app.get('/api/file/thumbnail', async (req, reply) => {
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)

    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (!meta?.public) {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }

    if (meta) {
      const cached = await readThumbnail(meta.id)
      if (cached) {
        return reply
          .header('Content-Type', 'image/png')
          .header('Cache-Control', 'private, max-age=86400')
          .send(cached)
      }
    }
    // Generate on demand (covers files indexed before thumbnails were added).
    try {
      const buffer = await readFile(abs)
      const png = await generateThumbnail(buffer, path.basename(abs))
      if (!png) return reply.code(404).send({ error: 'no thumbnail for this type' })
      if (meta) await writeThumbnail(meta.id, png).catch(() => null)
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'private, max-age=86400')
        .send(png)
    } catch (e: any) {
      return reply.code(404).send({ error: e?.message ?? 'thumbnail failed' })
    }
  })

  // ---- write ---------------------------------------------------------------

  app.post('/api/file/upload', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'viewers cannot upload' })

    const part = await req.file({ limits: { fileSize: config.ingest.maxFileBytes, files: 1 } })
    if (!part) return reply.code(400).send({ error: 'no file uploaded' })

    const buffer = await part.toBuffer()
    if (buffer.length === 0) return reply.code(400).send({ error: 'empty file' })

    const fields = part.fields as Record<string, { value: string } | undefined>
    const targetRel = ((fields?.path as any)?.value as string | undefined) || ''
    const tagsCSV = ((fields?.tags as any)?.value as string | undefined) || ''
    const titleField = ((fields?.title as any)?.value as string | undefined) || ''

    const targetDir = resolveVault(targetRel)
    await mkdir(targetDir, { recursive: true })

    const filename = safeFilename(part.filename || 'upload.bin')
    const finalAbs = await uniquePath(targetDir, filename)
    const finalRel = toVaultRel(finalAbs)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(finalAbs, buffer))

    const mime = inferMime(filename, part.mimetype || undefined)
    const sha256 = sha256Of(buffer)
    const now = Date.now()
    const meta: DocumentMeta = {
      id: nanoid(),
      title: titleField.trim() || filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      mime,
      bytes: buffer.length,
      sha256,
      storageKey: finalRel, // vault-relative path doubles as the storage key
      owner: user.username,
      acl: { readers: [], editors: [] },
      tags: tagsCSV.split(',').map((s) => s.trim()).filter(Boolean),
      createdAt: now,
      updatedAt: now,
      ingest: { status: 'pending', embedded: false },
    }
    await saveMeta(meta)
    const finalMeta = await ingestDocument(meta, buffer)

    await audit({
      actor: user.username,
      action: 'vault.upload',
      target: finalRel,
      meta: { bytes: buffer.length, mime },
    })
    return reply.code(201).send({ document: finalMeta, path: finalRel })
  })

  app.post('/api/file/index', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { path: rel } = req.body as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })

    const buffer = await readFile(abs)
    const sha256 = sha256Of(buffer)
    const now = Date.now()

    // Replace any existing index for this path.
    const docs = await listAllDocuments()
    const existing = docs.find((d) => d.storageKey === rel)
    const id = existing?.id ?? nanoid()
    if (existing) await deleteDocument(existing.id)

    const filename = path.basename(abs)
    const meta: DocumentMeta = {
      id,
      title: existing?.title ?? filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      mime: inferMime(filename),
      bytes: s.size,
      sha256,
      storageKey: rel,
      owner: existing?.owner ?? user.username,
      acl: existing?.acl ?? { readers: [], editors: [] },
      tags: existing?.tags ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ingest: { status: 'pending', embedded: false },
    }
    await saveMeta(meta)
    const finalMeta = await ingestDocument(meta, buffer)
    await audit({ actor: user.username, action: 'vault.index', target: rel })
    return { document: finalMeta }
  })

  app.delete('/api/file', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)

    // ACL: if an index exists, only owner / admin / listed editor can delete.
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (meta && !userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    void userCanRead

    // Soft-delete: move the vault file + index meta into trash. Sweeper purges
    // after 30 days; user can restore from Settings → Trash.
    const s = await stat(abs).catch(() => null)
    if (s?.isFile()) {
      await moveToTrash({
        storageKey: rel,
        vaultAbs: abs,
        docId: meta?.id,
        bytes: s.size,
        trashedBy: user.username,
      }).catch((err) => {
        req.log.warn({ err, rel }, 'trash move failed; hard-deleting')
        return rm(abs, { force: true }).catch(() => null)
      })
    }
    invalidateSearchCache()
    await audit({ actor: user.username, action: 'vault.trash', target: rel })
    return { ok: true }
  })

  // ─── trash ─────────────────────────────────────────────────────────────

  app.get('/api/trash', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const { listTrash } = await import('../stores/trash.js')
    const entries = await listTrash()
    return { entries }
  })

  app.post('/api/trash/:id/restore', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { id } = req.params as { id: string }
    const { listTrash, purgeTrash } = await import('../stores/trash.js')
    const all = await listTrash()
    const entry = all.find((e) => e.id === id)
    if (!entry) return reply.code(404).send({ error: 'not found in trash' })
    // Restore vault file.
    const targetAbs = resolveVault(entry.storageKey)
    await mkdir(path.dirname(targetAbs), { recursive: true })
    const blobName = entry.filename.replace(/\.\./g, '_').replace(/[\/\\]/g, '_')
    const src = path.join(config.paths.trash, entry.id, blobName)
    try {
      await rename(src, targetAbs)
    } catch (e: any) {
      return reply.code(500).send({ error: `restore failed: ${e?.message ?? e}` })
    }
    // Restore doc meta dir if present.
    if (entry.docId) {
      const docSrc = path.join(config.paths.trash, entry.id, '_doc')
      const docDest = path.join(config.paths.documents, entry.docId)
      const s = await stat(docSrc).catch(() => null)
      if (s?.isDirectory()) {
        await rename(docSrc, docDest).catch(() => null)
      }
    }
    await purgeTrash(entry.id)
    invalidateSearchCache()
    await audit({ actor: user.username, action: 'trash.restore', target: entry.storageKey })
    return { ok: true }
  })

  app.delete('/api/trash/:id', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { id } = req.params as { id: string }
    const { purgeTrash } = await import('../stores/trash.js')
    await purgeTrash(id)
    await audit({ actor: user.username, action: 'trash.purge', target: id })
    return { ok: true }
  })

  // Bulk operations: visibility + delete. Per-file ACL still applies inside.
  app.post('/api/file/bulk-visibility', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as { paths?: string[]; public?: boolean }
    if (!Array.isArray(body?.paths) || typeof body.public !== 'boolean') {
      return reply.code(400).send({ error: 'paths[] and public required' })
    }
    const docs = await listAllDocuments()
    let ok = 0
    let failed = 0
    for (const rel of body.paths) {
      try {
        const abs = resolveVault(rel)
        const s = await stat(abs).catch(() => null)
        if (!s?.isFile()) {
          failed++
          continue
        }
        let meta = docs.find((d) => d.storageKey === rel)
        if (!meta) {
          // Create stub meta so the public flag has somewhere to live.
          const filename = path.basename(abs)
          meta = {
            id: nanoid(),
            title: filename.replace(/\.[^.]+$/, ''),
            originalFilename: filename,
            mime: inferMime(filename),
            bytes: s.size,
            sha256: '',
            storageKey: rel,
            owner: user.username,
            acl: { readers: [], editors: [] },
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ingest: { status: 'pending', embedded: false },
          }
        } else if (!userCanEdit(meta, user.username, user.role)) {
          failed++
          continue
        }
        const next: DocumentMeta = { ...meta, public: body.public, updatedAt: Date.now() }
        await saveMeta(next)
        ok++
      } catch {
        failed++
      }
    }
    invalidateSearchCache()
    await audit({
      actor: user.username,
      action: 'vault.bulk-visibility',
      meta: { count: body.paths.length, public: body.public, ok, failed },
    })
    return { ok, failed }
  })

  app.post('/api/file/bulk-delete', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as { paths?: string[] }
    if (!Array.isArray(body?.paths)) {
      return reply.code(400).send({ error: 'paths[] required' })
    }
    const docs = await listAllDocuments()
    let ok = 0
    let failed = 0
    for (const rel of body.paths) {
      try {
        const abs = resolveVault(rel)
        const meta = docs.find((d) => d.storageKey === rel)
        if (meta && !userCanEdit(meta, user.username, user.role)) {
          failed++
          continue
        }
        const s = await stat(abs).catch(() => null)
        if (s?.isFile()) {
          await moveToTrash({
            storageKey: rel,
            vaultAbs: abs,
            docId: meta?.id,
            bytes: s.size,
            trashedBy: user.username,
          })
          ok++
        }
      } catch {
        failed++
      }
    }
    invalidateSearchCache()
    await audit({
      actor: user.username,
      action: 'vault.bulk-trash',
      meta: { count: body.paths.length, ok, failed },
    })
    return { ok, failed }
  })

  app.post('/api/folder', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { path: rel } = req.body as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)
    await mkdir(abs, { recursive: true })
    await audit({ actor: user.username, action: 'vault.mkdir', target: rel })
    return { ok: true, path: rel }
  })

  app.post('/api/file/move', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { from, to } = req.body as { from?: string; to?: string }
    if (!from || !to) return reply.code(400).send({ error: 'missing from/to' })
    const absFrom = resolveVault(from)
    const absTo = resolveVault(to)
    await mkdir(path.dirname(absTo), { recursive: true })
    await rename(absFrom, absTo)

    // If indexed, update the storageKey.
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === from)
    if (meta) {
      await saveMeta({ ...meta, storageKey: to, updatedAt: Date.now() })
    }
    await audit({ actor: user.username, action: 'vault.move', target: from, meta: { to } })
    return { ok: true }
  })

  // Resolve a raw path → docId. Public-aware: anonymous callers can fetch
  // metadata for a file that has `public: true`. For vault files without an
  // index record (e.g. markdown read straight from disk) we return a stub so
  // the client can render the visibility toggle on the first open.
  app.get('/api/file/meta', async (req, reply) => {
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel)
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (meta) {
      if (meta.public) return { meta }
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (!userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      return { meta }
    }
    // No persisted meta — synthesize a stub if the file exists in the vault.
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return { meta: null }
    if (!requireAuth(req, reply)) return
    const u = req.currentUser!
    const filename = path.basename(abs)
    const stub: DocumentMeta = {
      id: '',
      title: filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      mime: inferMime(filename),
      bytes: s.size,
      sha256: '',
      storageKey: rel,
      owner: u.username,
      acl: { readers: [], editors: [] },
      public: false,
      tags: [],
      createdAt: s.birthtimeMs || Date.now(),
      updatedAt: s.mtimeMs || Date.now(),
      ingest: { status: 'pending', embedded: false },
    }
    return { meta: stub }
  })

  // Flip a file's public flag. Only owner / admin / listed editor may change
  // it. Creates an index record on the fly for vault files that haven't been
  // ingested yet (markdown, txt, etc.) so visibility works for every file.
  app.post('/api/file/visibility', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const body = req.body as { path?: string; public?: boolean }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })
    if (typeof body.public !== 'boolean') return reply.code(400).send({ error: 'missing public flag' })
    const abs = resolveVault(body.path)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })
    const docs = await listAllDocuments()
    let meta = docs.find((d) => d.storageKey === body.path)
    if (!meta) {
      // Create a minimal record — no ingest, just enough to track visibility.
      const filename = path.basename(abs)
      meta = {
        id: nanoid(),
        title: filename.replace(/\.[^.]+$/, ''),
        originalFilename: filename,
        mime: inferMime(filename),
        bytes: s.size,
        sha256: '',
        storageKey: body.path,
        owner: user.username,
        acl: { readers: [], editors: [] },
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ingest: { status: 'pending', embedded: false },
      }
    } else if (!userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const next: DocumentMeta = { ...meta, public: body.public, updatedAt: Date.now() }
    await saveMeta(next)
    await audit({
      actor: user.username,
      action: 'vault.visibility',
      target: body.path,
      meta: { public: body.public },
    })
    return { document: next }
  })
}
