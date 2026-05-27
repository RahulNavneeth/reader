import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveUserVault, userVaultRoot } from '../lib/userVault.js'
import { audit } from '../stores/audit.js'
import { isFrozenForArchive, loadMeta, saveMeta, sha256Of, userCanEdit } from '../stores/documents.js'
import { snapshotVersion } from '../stores/versions.js'
import { publish as publishEvent } from '../services/events.js'
import { broadcastEdit, flushDocSync } from '../services/crdtRegistry.js'
import { invalidateSearchCache } from '../services/search.js'
import { ingestDocument } from '../services/ingest.js'
import { dispatch as dispatchWebhook, markExpectedWrite } from '../services/webhooks.js'
import { nanoid } from 'nanoid'
import type { DocumentMeta } from '../types.js'
import { applyTemplate, applyTemplateAsync } from '../services/templateEngine.js'
import {
  makeVaultIncludeResolver,
  makeUrlFetchResolver,
} from '../services/templateResolvers.js'

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
    const earlyVars = computeBuiltins({
      now: new Date(),
      title: title || 'untitled',
      user: user.username,
      targetRel,
    })
    title = applyTemplate(title, { ...earlyVars, ...(body.vars ?? {}) })
    targetRel = applyTemplate(targetRel, {
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
    let content: string
    try {
      content = await applyTemplateAsync(tplBuf.toString('utf8'), vars, {
        loadInclude: makeVaultIncludeResolver(user.username),
        loadFetch: makeUrlFetchResolver(),
      })
    } catch (e) {
      return reply.code(400).send({
        error: `template: ${(e as Error).message}`,
      })
    }

    // Materialiser-canonical-writer path. Save a stub meta first
    // so `materialise()` has a row to update + the CRDT lease
    // knows the locator, then broadcastEdit the rendered content
    // and force-flush the registry so the file lands + meta gets
    // its real sha + ingest runs. Replaces the writeFile + saveMeta
    // + ingestDocument trio.
    const storageKey = targetRel.replace(/^\/+|\/+$/g, '')
    const id = nanoid()
    const stub: DocumentMeta = {
      id,
      owner: user.username,
      storageKey,
      title: title || path.basename(targetRel, path.extname(targetRel)),
      originalFilename: path.basename(targetRel),
      mime: 'text/markdown',
      bytes: 0,
      sha256: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      acl: { readers: [], editors: [] },
      tags: [],
      ingest: { status: 'pending', embedded: false },
      templateSource: {
        template: templateRel,
        vars: body.vars ?? {},
        title: title || undefined,
      },
    } as unknown as DocumentMeta
    try {
      await saveMeta(stub)
      broadcastEdit(
        id,
        { owner: user.username, storageKey },
        content,
        'template-instantiate',
      )
      await flushDocSync(id)
      const finalMeta = (await loadMeta(id)) ?? stub
      await audit({
        actor: user.username,
        action: 'template.instantiate',
        target: storageKey,
        meta: { template: templateRel },
      })
      dispatchWebhook({
        type: 'template',
        path: storageKey,
        actor: user.username,
        template: templateRel,
        title: finalMeta.title,
      }).catch(() => null)
      return { ok: true, document: finalMeta }
    } catch (e) {
      req.log.error({ err: e }, 'template.instantiate failed')
      return reply.code(500).send({ error: (e as Error).message ?? 'instantiate failed' })
    }
  })

  // Copy an existing doc into `_templates/<name>.md` so the user can
  // re-instantiate it later. Markdown-only — bytes of non-text files
  // wouldn't substitute, and a template can't include an attachment
  // by reference anyway. Refuses to clobber an existing template;
  // the client can rename and retry.
  app.post<{
    Body: { source?: string; name?: string }
  }>('/api/templates/save-as', async (req, reply) => {
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const sourceRel = (req.body?.source ?? '').trim().replace(/^\/+|\/+$/g, '')
    const rawName = (req.body?.name ?? '').trim()
    if (!sourceRel || !rawName) {
      return reply.code(400).send({ error: 'source and name are required' })
    }
    if (!/\.(md|markdown|mdx)$/i.test(sourceRel)) {
      return reply.code(400).send({ error: 'only markdown documents can be saved as templates' })
    }
    // Sanitise the template filename: keep alphanumerics, dashes,
    // underscores, dots, and spaces. Strip everything else so a
    // user pasting a heading line as the name can't smuggle path
    // segments (`../`, leading `/`) or shell metacharacters into
    // the eventual file location.
    let name = rawName.replace(/[^a-zA-Z0-9 ._-]+/g, '').replace(/^[. ]+|[. ]+$/g, '')
    if (!name) return reply.code(400).send({ error: 'name resolves to empty after sanitising' })
    if (!/\.(md|markdown|mdx)$/i.test(name)) name = `${name}.md`
    let sourceAbs: string
    let templateAbs: string
    const templateRel = `${TEMPLATES_DIR}/${name}`
    try {
      sourceAbs = resolveUserVault(user.username, sourceRel)
      templateAbs = resolveUserVault(user.username, templateRel)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    let body: Buffer
    try {
      body = await readFile(sourceAbs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'source not found' })
      }
      throw e
    }
    try {
      await stat(templateAbs)
      return reply.code(409).send({ error: 'template with that name already exists' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    await mkdir(path.dirname(templateAbs), { recursive: true })
    // Pre-register the write so the watcher doesn't fire a duplicate
    // upload webhook for what we're already auditing as a template
    // save.
    markExpectedWrite(templateAbs, sha256Of(body))
    await writeFile(templateAbs, body)
    await audit({
      actor: user.username,
      action: 'template.save_as',
      target: templateRel,
      meta: { source: sourceRel, bytes: body.length },
    })
    return {
      ok: true,
      template: {
        path: templateRel,
        name,
        title: name.replace(/\.(md|markdown|mdx)$/i, ''),
        bytes: body.length,
        updatedAt: Date.now(),
      },
    }
  })

  // Re-render a doc that was originally instantiated from a template.
  // Uses the stashed `templateSource.{template, vars, title}` plus
  // freshly computed built-ins (date / time / uuid are "now"), and
  // overwrites the file. The pre-refresh content is snapshotted to
  // the versions store first, so the user can `restore_version` if
  // the refresh wasn't what they wanted.
  //
  // Refuses on:
  //   - doc not found (404)
  //   - caller can't edit the doc (403)
  //   - doc is archived — read-only freeze applies (409 code:archived)
  //   - doc has no templateSource (400 — refresh has no semantics)
  //   - template no longer exists (404 — user deleted the source)
  app.post<{ Body: { id?: string } }>('/api/templates/refresh', async (req, reply) => {
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const id = String(req.body?.id ?? '').trim()
    if (!id) return reply.code(400).send({ error: 'id required' })
    const meta = await loadMeta(id)
    if (!meta) return reply.code(404).send({ error: 'document not found' })
    if (!userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    if (isFrozenForArchive(meta)) {
      return reply.code(409).send({ error: 'document is archived — unarchive to refresh', code: 'archived' })
    }
    const src = meta.templateSource
    if (!src) {
      return reply.code(400).send({ error: 'document was not created from a template' })
    }
    const templateAbs = (() => {
      try {
        return resolveUserVault(meta.owner, src.template)
      } catch {
        return null
      }
    })()
    if (!templateAbs) return reply.code(400).send({ error: 'template path invalid' })
    let tplBuf: Buffer
    try {
      tplBuf = await readFile(templateAbs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'source template no longer exists' })
      }
      throw e
    }
    const builtins = computeBuiltins({
      now: new Date(),
      title: src.title || meta.title,
      user: user.username,
      targetRel: meta.storageKey,
    })
    const vars = { ...builtins, ...src.vars }
    let content: string
    try {
      content = await applyTemplateAsync(tplBuf.toString('utf8'), vars, {
        loadInclude: makeVaultIncludeResolver(meta.owner),
        loadFetch: makeUrlFetchResolver(),
      })
    } catch (e) {
      return reply.code(400).send({ error: `template: ${(e as Error).message}` })
    }
    // Snapshot BEFORE the overwrite so the user has an undo path.
    await snapshotVersion(meta.id).catch(() => null)
    const targetAbs = resolveUserVault(meta.owner, meta.storageKey)
    const buf = Buffer.from(content, 'utf8')
    markExpectedWrite(targetAbs, sha256Of(buf))
    await writeFile(targetAbs, buf)
    const next: DocumentMeta = {
      ...meta,
      bytes: buf.length,
      sha256: sha256Of(buf),
      updatedAt: Date.now(),
      ingest: { status: 'pending', embedded: false },
    }
    await saveMeta(next)
    const finalMeta = await ingestDocument(next, buf)
    invalidateSearchCache()
    await audit({
      actor: user.username,
      action: 'template.refresh',
      target: meta.storageKey,
      meta: { template: src.template, docId: meta.id },
    })
    dispatchWebhook({
      type: 'edit',
      path: meta.storageKey,
      actor: user.username,
      bytes: buf.length,
      source: 'web',
    }).catch(() => null)
    publishEvent({ type: 'edit', path: meta.storageKey, docId: meta.id })
    broadcastEdit(
      meta.id,
      { owner: meta.owner, storageKey: meta.storageKey },
      content,
      'template-refresh',
    )
    return { ok: true, document: finalMeta }
  })
}
