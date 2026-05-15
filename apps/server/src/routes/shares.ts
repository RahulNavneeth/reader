import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { config } from '../config.js'
import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  recordShareAccess,
  verifySharePassword,
} from '../stores/shares.js'
import { listAllDocuments, userCanEdit } from '../stores/documents.js'
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

  app.get('/s/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const share = await getShare(id)
    if (!share) return reply.code(404).send({ error: 'invalid or expired link' })
    if (share.expiresAt != null && share.expiresAt < Date.now()) {
      return reply.code(410).send({ error: 'link expired' })
    }
    if (share.passwordHash) {
      const { p } = req.query as { p?: string }
      const headerPwd = (req.headers['x-share-password'] as string | undefined) ?? undefined
      const pwd = p ?? headerPwd
      if (!pwd) {
        // Plain HTML password prompt for browser users; JSON for API callers.
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
  })
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
