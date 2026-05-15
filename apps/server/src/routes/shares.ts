import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { config } from '../config.js'
import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  recordShareAccess,
  verifySharePassword,
  type Share,
} from '../stores/shares.js'
import {
  listAllDocuments,
  readPreview,
  readText as readDocText,
  readThumbnail,
  userCanEdit,
  writePreview,
} from '../stores/documents.js'
import { audit } from '../stores/audit.js'
import { userCan } from '../lib/grants.js'
import { dispatch as dispatchWebhook } from '../services/webhooks.js'

/**
 * Share-link routes.
 *
 *  - POST /api/file/shares        — owner creates a share token.
 *  - GET  /api/file/shares        — list shares the caller owns (or for a path).
 *  - DELETE /api/file/shares/:id  — revoke.
 *  - GET  /s/:id                  — anonymous redemption; serves the file
 *                                   bytes if expiry/password check passes.
 *                                   Password supplied as either ?p=<pw> or
 *                                   X-Share-Password header.
 *
 * Tokens are opaque (cryptographic random) so they can be safely emailed
 * without leaking the underlying file path.
 */
export async function sharesRoutes(app: FastifyInstance) {
  // ---- create/list/delete ------------------------------------------------

  app.post('/api/file/shares', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    const body = req.body as {
      path?: string
      expiresInSeconds?: number | null
      password?: string
      label?: string
    }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })

    // Must own / be an editor / have a write grant on the file.
    const abs = path.join(config.vault.root, body.path)
    const st = await stat(abs).catch(() => null)
    if (!st || !st.isFile()) return reply.code(404).send({ error: 'not found' })
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === body.path)
    const canShare = meta
      ? userCanEdit(meta, user.username, user.role)
      : userCan(user, 'write', body.path) || user.role === 'admin'
    if (!canShare) return reply.code(403).send({ error: 'forbidden' })

    const exp =
      body.expiresInSeconds === null || body.expiresInSeconds === undefined
        ? null
        : Date.now() + Math.max(60, Math.floor(body.expiresInSeconds)) * 1000

    const share = await createShare({
      storageKey: body.path,
      docId: meta?.id,
      createdBy: user.username,
      label: body.label?.trim() || undefined,
      expiresAt: exp,
      password: body.password ? body.password : undefined,
    })
    await audit({
      actor: user.username,
      action: 'share.create',
      target: body.path,
      meta: { shareId: share.id, hasPassword: !!share.passwordHash, expiresAt: share.expiresAt },
    })
    dispatchWebhook({
      type: 'share',
      path: body.path,
      actor: user.username,
      shareId: share.id,
      expiresAt: share.expiresAt,
    }).catch(() => null)
    return reply.code(201).send({ share: redact(share) })
  })

  app.get('/api/file/shares', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    const { path: rel } = req.query as { path?: string }
    const all = await listShares(rel ? { storageKey: rel } : undefined)
    // Non-admins only see their own shares.
    const visible = user.role === 'admin' ? all : all.filter((s) => s.createdBy === user.username)
    return { shares: visible.map(redact) }
  })

  app.delete('/api/file/shares/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    const { id } = req.params as { id: string }
    const share = await getShare(id)
    if (!share) return reply.code(404).send({ error: 'not found' })
    if (share.createdBy !== user.username && user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await deleteShare(id)
    await audit({
      actor: user.username,
      action: 'share.revoke',
      target: share.storageKey,
      meta: { shareId: id },
    })
    return { ok: true }
  })

  // ---- redemption --------------------------------------------------------

  /**
   * Top-level redemption URL. Browser navigations get the SPA shell (which
   * mounts the rich viewer at /s/:id and handles password prompts in-app),
   * curl / wget / Accept: ! text/html callers get the raw bytes directly.
   * `?raw=1` is the explicit "always give me bytes" escape hatch — used by
   * the in-app download button when the viewer mounts.
   */
  app.get('/s/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const { raw, p } = req.query as { raw?: string; p?: string }
    const wantsBytes =
      raw === '1' ||
      !((req.headers.accept || '').includes('text/html') ||
        (req.headers['sec-fetch-mode'] || '') === 'navigate')

    if (wantsBytes) {
      return serveRaw(req, reply, id, p)
    }

    // SPA shell: let the React app at /s/:id render the rich viewer + handle
    // password prompt. Only works when the build dir is wired up; in dev,
    // Vite proxies us back through to its index.html via the proxy config.
    if (!config.webDir) {
      // No SPA bundle available (API-only build) — fall back to the bytes path.
      return serveRaw(req, reply, id, p)
    }
    return reply.sendFile('index.html', path.resolve(config.webDir))
  })

  /**
   * Share metadata. The SPA calls this first to figure out what to render
   * and to validate any password the user typed. Returns 401 with
   * passwordRequired:true if the share needs a password.
   */
  app.get('/api/share/:id/info', async (req, reply) => {
    const share = await resolveShare(req, reply, req.params as { id: string })
    if (!share) return
    return {
      id: share.id,
      filename: path.basename(share.storageKey),
      ext: path.extname(share.storageKey).toLowerCase(),
      mime: mimeFor(path.join(config.vault.root, share.storageKey)),
      label: share.label,
      hasPassword: !!share.passwordHash,
      expiresAt: share.expiresAt,
    }
  })

  app.get('/api/share/:id/text', async (req, reply) => {
    const share = await resolveShare(req, reply, req.params as { id: string })
    if (!share) return
    const abs = path.join(config.vault.root, share.storageKey)
    const ext = path.extname(abs).toLowerCase()
    // Native text types — read straight from disk so md edits are live.
    if (['.md', '.markdown', '.mdx', '.txt', '.csv', '.json', '.html', '.htm', '.yaml', '.yml', '.toml'].includes(ext)) {
      try {
        const buf = await readFile(abs)
        const st = await stat(abs)
        return { content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs }
      } catch {
        return reply.code(404).send({ error: 'file missing' })
      }
    }
    // For binary types, return the extracted text if we have one.
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === share.storageKey)
    const text = meta ? (await readDocText(meta.id)) ?? '' : ''
    const st = await stat(abs).catch(() => null)
    return { content: text, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 }
  })

  app.get('/api/share/:id/raw', async (req, reply) => {
    return serveRaw(req, reply, (req.params as { id: string }).id, (req.query as { p?: string }).p)
  })

  app.get('/api/share/:id/thumbnail', async (req, reply) => {
    const share = await resolveShare(req, reply, req.params as { id: string })
    if (!share) return
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === share.storageKey)
    if (meta) {
      const png = await readThumbnail(meta.id)
      if (png) {
        return reply
          .header('Content-Type', 'image/png')
          .header('Cache-Control', 'private, max-age=86400')
          .send(png)
      }
    }
    return reply.code(404).send({ error: 'no thumbnail' })
  })

  app.get('/api/share/:id/preview', async (req, reply) => {
    const share = await resolveShare(req, reply, req.params as { id: string })
    if (!share) return
    const abs = path.join(config.vault.root, share.storageKey)
    const st = await stat(abs).catch(() => null)
    if (!st || !st.isFile()) return reply.code(404).send({ error: 'file missing' })
    const ext = path.extname(abs).toLowerCase()
    const { isImageNeedingTranscode, isVideo, transcodeImageToJpeg, videoFrameAt } =
      await import('../services/media.js')
    const needsServerPreview = isImageNeedingTranscode(abs) || isVideo(abs)
    if (!needsServerPreview) {
      // Browser-renderable: just stream the bytes.
      return reply
        .header('Content-Type', mimeFor(abs))
        .header('Content-Length', String(st.size))
        .send(createReadStream(abs))
    }
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === share.storageKey)
    if (meta) {
      const cached = await readPreview(meta.id)
      if (cached) {
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'private, max-age=86400')
          .send(cached)
      }
    }
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
      void ext
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message ?? 'preview failed' })
    }
  })
}

/**
 * Shared password/expiry guard for the /api/share/:id/* endpoints. Returns
 * the validated share if access is allowed, or `null` after writing the
 * appropriate error response on `reply`.
 */
async function resolveShare(
  req: FastifyRequest,
  reply: FastifyReply,
  params: { id: string },
): Promise<Share | null> {
  const share = await getShare(params.id)
  if (!share) {
    reply.code(404).send({ error: 'invalid or expired link' })
    return null
  }
  if (share.expiresAt != null && share.expiresAt < Date.now()) {
    reply.code(410).send({ error: 'link expired' })
    return null
  }
  if (share.passwordHash) {
    const { p } = req.query as { p?: string }
    const headerPwd = (req.headers['x-share-password'] as string | undefined) ?? undefined
    const pwd = p ?? headerPwd
    if (!pwd) {
      reply.code(401).send({ error: 'password required', passwordRequired: true })
      return null
    }
    if (!verifySharePassword(share.passwordHash, pwd)) {
      reply.code(401).send({ error: 'incorrect password', passwordRequired: true })
      return null
    }
  }
  return share
}

async function serveRaw(
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  password: string | undefined,
): Promise<FastifyReply | void> {
  const share = await getShare(id)
  if (!share) return reply.code(404).send({ error: 'invalid or expired link' })
  if (share.expiresAt != null && share.expiresAt < Date.now()) {
    return reply.code(410).send({ error: 'link expired' })
  }
  if (share.passwordHash) {
    const pwd = password ?? (req.headers['x-share-password'] as string | undefined)
    if (!pwd) {
      // For browser navigations without a password (rare — SPA handles this
      // path), fall back to the inline HTML prompt so the user has something
      // usable even if the SPA bundle is broken.
      if ((req.headers.accept || '').includes('text/html')) {
        return reply
          .header('Content-Type', 'text/html; charset=utf-8')
          .code(401)
          .send(passwordPromptHtml(id))
      }
      return reply.code(401).send({ error: 'password required' })
    }
    if (!verifySharePassword(share.passwordHash, pwd)) {
      return reply.code(401).send({ error: 'incorrect password' })
    }
  }
  const abs = path.join(config.vault.root, share.storageKey)
  const st = await stat(abs).catch(() => null)
  if (!st || !st.isFile()) return reply.code(404).send({ error: 'file missing' })
  await recordShareAccess(id)
  const filename = path.basename(abs).replace(/"/g, '')
  return reply
    .header('Content-Type', mimeFor(abs))
    .header('Content-Length', String(st.size))
    .header('Content-Disposition', `inline; filename="${filename}"`)
    .send(createReadStream(abs))
}

function redact(s: Awaited<ReturnType<typeof getShare>>) {
  if (!s) return s
  // Never leak the password hash to the client.
  const { passwordHash, ...rest } = s
  return { ...rest, hasPassword: !!passwordHash }
}

function mimeFor(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase()
  const m: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.json': 'application/json',
  }
  return m[ext] || 'application/octet-stream'
}

function passwordPromptHtml(id: string): string {
  // Minimal HTML — keeps the share page lightweight and decoupled from the
  // SPA so the link works even when the static bundle is broken.
  const escId = id.replace(/[^A-Za-z0-9_-]/g, '')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Password required</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#FAFBFC;color:#172B4D;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  form{background:#fff;padding:28px;border-radius:8px;box-shadow:0 4px 12px -4px rgba(9,30,66,.08);width:340px}
  h1{font-size:16px;margin:0 0 16px}
  input{width:100%;padding:8px 10px;border:1px solid #DFE1E6;border-radius:4px;font-size:14px;box-sizing:border-box}
  button{margin-top:12px;width:100%;padding:8px 10px;border:0;border-radius:4px;
         background:#0052CC;color:#fff;font-size:14px;cursor:pointer}
  .err{margin-top:8px;color:#BF2600;font-size:12px;display:none}
</style></head><body>
<form method="get" action="/s/${escId}">
  <h1>This share is password-protected</h1>
  <input type="password" name="p" autofocus placeholder="Password" />
  <button type="submit">Open file</button>
</form>
</body></html>`
}
