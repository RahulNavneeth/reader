import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { listAllDocuments } from '../stores/documents.js'
import { listFolderMetas } from '../stores/folderMetas.js'
import { listSharesFrom, listSharesTo } from '../stores/userShares.js'
import { listPins } from '../stores/pins.js'
import { resolveUserVault } from '../lib/userVault.js'
import { zipStream } from '../lib/zipStream.js'
import { audit } from '../stores/audit.js'

/**
 * Bulk export: stream a ZIP containing every file the user owns plus a
 * manifest.json describing the metadata you can't reconstruct from
 * filenames alone (tags, public flag, pins, share grants).
 *
 * Streamed end-to-end — the server never buffers the whole archive,
 * so a 50 GB vault uses constant memory.
 */
export async function exportRoutes(app: FastifyInstance) {
  app.get('/api/account/export.zip', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser

    const allDocs = await listAllDocuments()
    const myDocs = allDocs.filter((d) => d.owner === user.username)
    const folderMetas = await listFolderMetas(user.username)
    const sharesFrom = await listSharesFrom(user.username)
    const sharesTo = await listSharesTo(user.username)
    const pins = await listPins(user.username)

    const manifest = {
      version: 1,
      exportedAt: Date.now(),
      user: { username: user.username, role: user.role, createdAt: user.createdAt },
      counts: {
        files: myDocs.length,
        folderMetas: folderMetas.length,
        sharesFrom: sharesFrom.length,
        sharesTo: sharesTo.length,
        pins: pins.length,
      },
      files: myDocs.map((d) => ({
        path: d.storageKey,
        title: d.title,
        mime: d.mime,
        bytes: d.bytes,
        sha256: d.sha256,
        tags: d.tags,
        public: !!d.public,
        publicExpiresAt: d.publicExpiresAt ?? null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      folderMetas: folderMetas.map((m) => ({
        path: m.storageKey,
        tags: m.tags,
        public: !!m.public,
        publicExpiresAt: m.publicExpiresAt ?? null,
      })),
      sharesFrom: sharesFrom.map((s) => ({
        recipient: s.recipient,
        path: s.storageKey,
        isFolder: s.isFolder,
        canEdit: s.canEdit,
        label: s.label,
        createdAt: s.createdAt,
      })),
      sharesTo: sharesTo.map((s) => ({
        owner: s.owner,
        path: s.storageKey,
        isFolder: s.isFolder,
        canEdit: s.canEdit,
        createdAt: s.createdAt,
      })),
      pins,
    }

    // Pre-resolve absolute paths so the generator doesn't redo
    // userVault validation per-file under streaming pressure.
    const filesToZip: Array<{ rel: string; abs: string }> = []
    for (const d of myDocs) {
      let abs: string
      try {
        abs = resolveUserVault(user.username, d.storageKey)
        await stat(abs)
      } catch {
        continue
      }
      filesToZip.push({ rel: d.storageKey, abs })
    }

    const today = new Date().toISOString().slice(0, 10)
    const filename = `reader-${user.username}-${today}.zip`

    reply.raw.setHeader('Content-Type', 'application/zip')
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '')}"`,
    )
    // Suppress Fastify's payload helpers — we're streaming raw bytes.
    reply.hijack()

    async function* entries() {
      // Manifest first so a partial download still has the index.
      yield {
        name: 'manifest.json',
        type: 'buffer' as const,
        data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      }
      for (const f of filesToZip) {
        yield {
          name: path.posix.join('vault', f.rel),
          type: 'file' as const,
          absPath: f.abs,
        }
      }
    }

    try {
      const readable = Readable.from(zipStream(entries()))
      readable.pipe(reply.raw)
      readable.on('end', () => {
        reply.raw.end()
        audit({
          actor: user.username,
          action: 'account.export',
          meta: { files: filesToZip.length },
          ip: req.ip,
        }).catch(() => null)
      })
      readable.on('error', (err) => {
        app.log.warn({ err }, 'export stream failed')
        if (!reply.raw.headersSent) reply.raw.writeHead(500)
        reply.raw.end()
      })
    } catch (err) {
      app.log.warn({ err }, 'export setup failed')
      if (!reply.raw.headersSent) reply.raw.writeHead(500)
      reply.raw.end()
    }
  })
}
