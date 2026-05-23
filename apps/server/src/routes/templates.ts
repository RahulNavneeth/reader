import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveUserVault, userVaultRoot } from '../lib/userVault.js'
import { audit } from '../stores/audit.js'
import { saveMeta, sha256Of } from '../stores/documents.js'
import { ingestDocument } from '../services/ingest.js'
import { nanoid } from 'nanoid'
import type { DocumentMeta } from '../types.js'

/**
 * Document templates. Templates live as plain `.md` files under
 * the user's vault at `_templates/*.md`. Storing them in-vault
 * (rather than a separate templates table) means:
 *   - no migration needed
 *   - users can edit templates with any tool (vim, Obsidian)
 *   - templates are sync-able / backup-able just like any other doc
 *
 * Two endpoints:
 *   GET  /api/templates                  — list available templates
 *   POST /api/templates/instantiate      — create a new doc from one
 *
 * Instantiation substitutes a small set of placeholders:
 *   {{date}}      → YYYY-MM-DD (today, local)
 *   {{datetime}}  → ISO-8601 local datetime
 *   {{title}}     → the target file's title (passed in body)
 *   {{user}}      → caller's username
 *  Plus any user-supplied vars (body.vars) — `{{my_var}}` is
 *  replaced with `body.vars.my_var`. Unknown placeholders are
 *  left intact so a template author can include literal `{{X}}`
 *  by misspelling on purpose.
 */
const TEMPLATES_DIR = '_templates'

export async function templatesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)

  app.get('/api/templates', async (req) => {
    const user = req.currentUser!
    const dir = path.join(userVaultRoot(user.username), TEMPLATES_DIR)
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (e) {
      // No templates dir yet — return empty list cleanly so the
      // client can render the "create your first template" CTA.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { templates: [] }
      throw e
    }
    const templates: Array<{
      path: string
      name: string
      title: string
      bytes: number
      updatedAt: number
      preview: string
    }> = []
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!/\.(md|markdown|mdx)$/i.test(e.name)) continue
      const abs = path.join(dir, e.name)
      let s: import('node:fs').Stats
      try {
        s = await stat(abs)
      } catch {
        continue
      }
      // 4 KB preview — enough to show the user what's in the
      // template without loading the full body for a list view.
      let preview = ''
      try {
        const head = await readFile(abs, { encoding: 'utf8' })
        preview = head.slice(0, 4096)
      } catch {/* skip on read error */}
      templates.push({
        path: `${TEMPLATES_DIR}/${e.name}`,
        name: e.name,
        title: e.name.replace(/\.(md|markdown|mdx)$/i, ''),
        bytes: s.size,
        updatedAt: s.mtimeMs,
        preview,
      })
    }
    templates.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return { templates }
  })

  app.post<{
    Body: {
      template?: string
      target?: string
      title?: string
      vars?: Record<string, string>
    }
  }>('/api/templates/instantiate', async (req, reply) => {
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body ?? {}
    const templateRel = (body.template ?? '').trim()
    const targetRel = (body.target ?? '').trim()
    const title = (body.title ?? '').trim()
    if (!templateRel || !targetRel) {
      return reply.code(400).send({ error: 'template and target are required' })
    }
    if (!templateRel.startsWith(`${TEMPLATES_DIR}/`)) {
      return reply.code(400).send({ error: `template must be under ${TEMPLATES_DIR}/` })
    }
    // Resolve through userVault so `..` traversal can't escape
    // either the template or the target out of the user's vault.
    let templateAbs: string
    let targetAbs: string
    try {
      templateAbs = resolveUserVault(user.username, templateRel)
      targetAbs = resolveUserVault(user.username, targetRel)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    let tplBuf: Buffer
    try {
      tplBuf = await readFile(templateAbs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'template not found' })
      }
      throw e
    }
    // Refuse to clobber an existing file at the target — same
    // semantic as /api/file/move.
    try {
      await stat(targetAbs)
      return reply.code(409).send({ error: 'destination already exists' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    // Build placeholder map. Built-ins are computed at instantiate
    // time so a template can carry a literal `{{date}}` that
    // resolves to "now". User-supplied `vars` win on key conflict
    // so they can override defaults if needed.
    const now = new Date()
    const builtins: Record<string, string> = {
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      datetime: now.toISOString(),
      title: title || path.basename(targetRel, path.extname(targetRel)),
      user: user.username,
    }
    const vars = { ...builtins, ...(body.vars ?? {}) }
    let content = tplBuf.toString('utf8')
    content = content.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (m, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m,
    )

    await mkdir(path.dirname(targetAbs), { recursive: true })
    await writeFile(targetAbs, content)
    const buf = Buffer.from(content, 'utf8')
    const id = nanoid()
    const meta: DocumentMeta = {
      id,
      owner: user.username,
      storageKey: targetRel.replace(/^\/+|\/+$/g, ''),
      title: title || path.basename(targetRel, path.extname(targetRel)),
      originalFilename: path.basename(targetRel),
      mime: 'text/markdown',
      bytes: buf.length,
      sha256: sha256Of(buf),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // ACL defaults — owner-only, matches the upload path.
      acl: { readers: [], editors: [] },
      tags: [],
      ingest: { status: 'pending', embedded: false },
    } as unknown as DocumentMeta
    try {
      await saveMeta(meta)
      const finalMeta = await ingestDocument(meta, buf)
      await audit({
        actor: user.username,
        action: 'template.instantiate',
        target: meta.storageKey,
        meta: { template: templateRel },
      })
      return { ok: true, document: finalMeta }
    } catch (e) {
      req.log.error({ err: e }, 'template.instantiate failed')
      return reply.code(500).send({ error: (e as Error).message ?? 'instantiate failed' })
    }
  })
}
