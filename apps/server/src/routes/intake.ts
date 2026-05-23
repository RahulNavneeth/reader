import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { findTokenBySecret } from '../stores/tokens.js'
import { ensureUserVault, resolveUserVault } from '../lib/userVault.js'
import { sha256Of, saveMeta } from '../stores/documents.js'
import { ingestDocument } from '../services/ingest.js'
import { audit } from '../stores/audit.js'
import { invalidateSearchCache } from '../services/search.js'
import type { ApiToken, DocumentMeta } from '../types.js'

/**
 * HTTP intake for forwarded email (or any external capture system).
 * Authenticated via the same Bearer-token mechanism as /mcp so a
 * single token can power both an AI agent AND an email-forwarder
 * webhook.
 *
 * Wired up: point your email service's "incoming message" webhook
 * (Cloudflare Email Workers, Mailgun routes, SES, SendGrid Inbound
 * Parse) at this endpoint with the token in the Authorization
 * header. Each delivered email becomes one markdown doc under
 * `Inbox/YYYY-MM-DD-<slug>.md` with frontmatter for `from`,
 * `subject`, and `received`. Attachments land at
 * `Inbox/attachments/<unique-name>` and are linked from the parent
 * doc so the AI chat / search can find them together.
 *
 *   POST /api/intake/email
 *   Authorization: Bearer rkn_...
 *   Content-Type: application/json
 *   {
 *     subject?: string,
 *     from?: string,
 *     body?: string,                  // text/plain or text/markdown
 *     html?: string,                  // optional fallback
 *     received?: number,              // epoch ms; defaults to now
 *     attachments?: [
 *       { name: string, mime?: string, content: string (base64) }
 *     ]
 *   }
 */

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_BODY_BYTES = 1 * 1024 * 1024

async function authHeaderToken(req: FastifyRequest): Promise<ApiToken | null> {
  const h = req.headers.authorization
  if (!h || !h.toLowerCase().startsWith('bearer ')) return null
  const secret = h.slice('bearer '.length).trim()
  if (!secret) return null
  return await findTokenBySecret(secret)
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  )
}

function dayPrefix(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function uniquePath(base: string): Promise<string> {
  let p = base
  let n = 1
  while (true) {
    try {
      await stat(p)
    } catch {
      return p
    }
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    p = `${stem}-${n}${ext}`
    n++
  }
}

export async function intakeRoutes(app: FastifyInstance) {
  app.post(
    '/api/intake/email',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = await authHeaderToken(req)
      if (!token) return reply.code(401).send({ error: 'authentication required' })
      // Viewers can't write — same posture as MCP upload tools.
      if (token.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })

      const body = req.body as {
        subject?: string
        from?: string
        body?: string
        html?: string
        received?: number
        attachments?: Array<{ name?: string; mime?: string; content?: string }>
      }
      if (!body || typeof body !== 'object') {
        return reply.code(400).send({ error: 'JSON body required' })
      }
      const subject = (body.subject ?? '').trim()
      const from = (body.from ?? '').trim()
      const textBody = (body.body ?? '').trim()
      const html = (body.html ?? '').trim()
      const received =
        typeof body.received === 'number' && Number.isFinite(body.received)
          ? body.received
          : Date.now()
      const content = textBody || html
      if (!content) {
        return reply.code(400).send({ error: 'body or html is required' })
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
        return reply.code(413).send({ error: 'body exceeds 1 MB' })
      }

      await ensureUserVault(token.createdBy).catch(() => null)

      // Save attachments first so we can reference them in the
      // doc body. Each lands at Inbox/attachments/<unique-name>.
      const attDir = resolveUserVault(token.createdBy, 'Inbox/attachments')
      await mkdir(attDir, { recursive: true })
      const savedAttachments: Array<{ name: string; rel: string; bytes: number }> = []
      for (const a of body.attachments ?? []) {
        const name = (a.name ?? 'attachment').replace(/[/\\]/g, '_').trim()
        if (!name || !a.content) continue
        let buf: Buffer
        try {
          buf = Buffer.from(a.content, 'base64')
        } catch {
          continue
        }
        if (buf.length === 0) continue
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return reply.code(413).send({ error: `attachment ${name} > 20 MB` })
        }
        const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_')
        const abs = await uniquePath(path.join(attDir, safeName))
        await writeFile(abs, buf)
        const rootLen = resolveUserVault(token.createdBy, '').length
        const rel = abs.slice(rootLen + 1)
        savedAttachments.push({ name, rel, bytes: buf.length })
      }

      // Compose the parent doc as markdown with YAML-ish
      // frontmatter that downstream search / chat can introspect.
      const fm: string[] = ['---']
      fm.push(`from: ${JSON.stringify(from || '(unknown)')}`)
      fm.push(`subject: ${JSON.stringify(subject || '(no subject)')}`)
      fm.push(`received: ${new Date(received).toISOString()}`)
      fm.push(`source: email-intake`)
      if (token.name) fm.push(`intake_token: ${JSON.stringify(token.name)}`)
      fm.push('---')
      fm.push('')
      const sections: string[] = [fm.join('\n')]
      if (subject) sections.push(`# ${subject}`)
      sections.push(content)
      if (savedAttachments.length > 0) {
        sections.push('')
        sections.push('## Attachments')
        for (const a of savedAttachments) {
          // Vault-relative path, owner-side; the markdown asset
          // resolver in PathViewer rewrites to /api/file/raw.
          sections.push(`- [${a.name}](/${a.rel})`)
        }
      }
      const docBody = sections.join('\n')
      const docBuf = Buffer.from(docBody, 'utf8')

      // Filename: Inbox/YYYY-MM-DD-<slug>.md with collision suffix.
      const inboxDir = resolveUserVault(token.createdBy, 'Inbox')
      await mkdir(inboxDir, { recursive: true })
      const slugBase = `${dayPrefix(received)}-${slugify(subject || 'untitled')}.md`
      const docAbs = await uniquePath(path.join(inboxDir, slugBase))
      await writeFile(docAbs, docBuf)
      const rootLen = resolveUserVault(token.createdBy, '').length
      const docRel = docAbs.slice(rootLen + 1)

      const id = nanoid()
      const now = Date.now()
      const meta: DocumentMeta = {
        id,
        owner: token.createdBy,
        storageKey: docRel,
        title: subject || `(no subject) ${dayPrefix(received)}`,
        originalFilename: path.basename(docAbs),
        mime: 'text/markdown',
        bytes: docBuf.length,
        sha256: sha256Of(docBuf),
        createdAt: received,
        updatedAt: now,
        acl: { readers: [], editors: [] },
        tags: [],
        ingest: { status: 'pending', embedded: false },
      } as unknown as DocumentMeta
      await saveMeta(meta)
      const finalMeta = await ingestDocument(meta, docBuf)
      invalidateSearchCache()

      await audit({
        actor: token.createdBy,
        action: 'intake.email',
        target: docRel,
        meta: {
          subject: subject || undefined,
          from: from || undefined,
          attachments: savedAttachments.length,
          via: 'http',
          tokenName: token.name,
        },
      })

      return {
        ok: true,
        document: finalMeta,
        attachments: savedAttachments.map((a) => ({ path: a.rel, bytes: a.bytes })),
      }
    },
  )
}
