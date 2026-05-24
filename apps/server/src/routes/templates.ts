import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveUserVault, userVaultRoot } from '../lib/userVault.js'
import { audit } from '../stores/audit.js'
import { saveMeta, sha256Of } from '../stores/documents.js'
import { ingestDocument } from '../services/ingest.js'
import { dispatch as dispatchWebhook, markExpectedWrite } from '../services/webhooks.js'
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
 * Instantiation substitutes built-ins (see `computeBuiltins`)
 * plus any user-supplied vars (body.vars) — `{{my_var}}` is
 * replaced with `body.vars.my_var`. Unknown placeholders are
 * left intact so a template author can include literal `{{X}}`
 * by misspelling on purpose. User-supplied vars win on key
 * conflict so a template author can override a built-in default.
 */
const TEMPLATES_DIR = '_templates'

/** ISO 8601 week number for a date. Week starts on Monday; the
 *  first week of the year contains the year's first Thursday. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNr = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - dayNr + 3)
  const firstThursday = t.getTime()
  t.setUTCMonth(0, 1)
  if (t.getUTCDay() !== 4) {
    t.setUTCMonth(0, 1 + ((4 - t.getUTCDay()) + 7) % 7)
  }
  return 1 + Math.ceil((firstThursday - t.getTime()) / 604800000)
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Built-in placeholders auto-filled at instantiate time. Order
 * here matches the docstring + list-API response so the client
 * can render a "Available placeholders" hint without re-deriving.
 *
 * Date/time:
 *   date       → YYYY-MM-DD
 *   datetime   → ISO-8601 with offset
 *   time       → HH:MM (24-hour, local)
 *   year       → 2026
 *   month      → 05 (zero-padded)
 *   month_name → May
 *   day        → 23 (zero-padded)
 *   weekday    → Saturday
 *   week       → 21 (ISO week, zero-padded)
 *   quarter    → Q2
 *   timestamp  → unix epoch seconds
 *
 * Scope:
 *   title    → the target file's title
 *   slug     → slugified title (a-z0-9 + hyphens)
 *   user     → caller's username
 *   filename → basename of target, no extension
 *   folder   → parent dir of target (empty for vault root)
 *
 * Identity:
 *   uuid → short random ID
 */
export function computeBuiltins(opts: {
  now: Date
  title: string
  user: string
  targetRel: string
}): Record<string, string> {
  const { now, title, user, targetRel } = opts
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const month_name = now.toLocaleDateString('en-US', { month: 'long' })
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const folder = path.dirname(targetRel.replace(/^\/+/, ''))
  return {
    date: `${yyyy}-${mm}-${dd}`,
    datetime: now.toISOString(),
    time: `${hh}:${mi}`,
    year: String(yyyy),
    month: mm,
    month_name,
    day: dd,
    weekday,
    week: String(isoWeek(now)).padStart(2, '0'),
    quarter: `Q${Math.floor(now.getMonth() / 3) + 1}`,
    timestamp: String(Math.floor(now.getTime() / 1000)),
    title,
    slug: slugify(title) || 'untitled',
    user,
    filename: path.basename(targetRel, path.extname(targetRel)),
    folder: folder === '.' ? '' : folder,
    uuid: nanoid(10),
  }
}

/** Stable ordering used for both the list-API hint and tests. */
export const BUILTIN_KEYS = [
  'date', 'datetime', 'time', 'year', 'month', 'month_name', 'day',
  'weekday', 'week', 'quarter', 'timestamp',
  'title', 'slug', 'user', 'filename', 'folder', 'uuid',
] as const

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
    return { templates, builtins: BUILTIN_KEYS }
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
    let targetRel = (body.target ?? '').trim()
    let title = (body.title ?? '').trim()
    if (!templateRel || !targetRel) {
      return reply.code(400).send({ error: 'template and target are required' })
    }
    if (!templateRel.startsWith(`${TEMPLATES_DIR}/`)) {
      return reply.code(400).send({ error: `template must be under ${TEMPLATES_DIR}/` })
    }
    // Substitute placeholders in the title + target path BEFORE
    // path validation, so a user can type
    // `journal/{{date}}-{{slug}}.md` and have it land at
    // `journal/2026-05-23-my-doc.md`. Path resolution still goes
    // through resolveUserVault so the substituted values can't be
    // used to escape the user's vault.
    const subst = (s: string, vars: Record<string, string>) =>
      s.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (m, key: string) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m,
      )
    const earlyVars = computeBuiltins({
      now: new Date(),
      title: title || 'untitled',
      user: user.username,
      targetRel,
    })
    title = subst(title, { ...earlyVars, ...(body.vars ?? {}) })
    targetRel = subst(targetRel, {
      // After title substitution, slug derives from the resolved
      // title — so `{{slug}}` in the target path uses the final
      // title, not the raw template.
      ...computeBuiltins({
        now: new Date(),
        title: title || 'untitled',
        user: user.username,
        targetRel,
      }),
      ...(body.vars ?? {}),
    })
    // Reject empty target after substitution (e.g. user typed
    // only `{{unknownvar}}` which left the field literally empty
    // after resolution).
    if (!targetRel) {
      return reply.code(400).send({ error: 'target resolves to empty path' })
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
    const builtins = computeBuiltins({
      now: new Date(),
      title: title || path.basename(targetRel, path.extname(targetRel)),
      user: user.username,
      targetRel,
    })
    const vars = { ...builtins, ...(body.vars ?? {}) }
    let content = tplBuf.toString('utf8')
    content = content.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (m, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m,
    )

    await mkdir(path.dirname(targetAbs), { recursive: true })
    const buf = Buffer.from(content, 'utf8')
    // Pre-mark so the watcher's `add` event doesn't fire a duplicate
    // upload webhook — we dispatch our own `template` event below and
    // ingest synchronously here.
    markExpectedWrite(targetAbs, sha256Of(buf))
    await writeFile(targetAbs, content)
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
      // Newly-instantiated template doc joins the searchable corpus;
      // flush so the next search reflects it.
      const { invalidateSearchCache } = await import('../services/search.js')
      invalidateSearchCache()
      await audit({
        actor: user.username,
        action: 'template.instantiate',
        target: meta.storageKey,
        meta: { template: templateRel },
      })
      dispatchWebhook({
        type: 'template',
        path: meta.storageKey,
        actor: user.username,
        template: templateRel,
        title: meta.title,
      }).catch(() => null)
      return { ok: true, document: finalMeta }
    } catch (e) {
      req.log.error({ err: e }, 'template.instantiate failed')
      return reply.code(500).send({ error: (e as Error).message ?? 'instantiate failed' })
    }
  })
}
