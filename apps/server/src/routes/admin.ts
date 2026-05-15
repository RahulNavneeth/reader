import os from 'node:os'
import path from 'node:path'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config, ANCHOR_PATH } from '../config.js'
import { audit } from '../stores/audit.js'
import {
  deleteUser,
  getUser,
  isValidUsername,
  listUsers,
  publicUser,
  saveUser,
} from '../stores/users.js'
import { ROLE_PRESETS, sanitizeGrants } from '../lib/grants.js'
import { createToken, deleteToken, listTokens } from '../stores/tokens.js'
import { loadSettings, saveSettings, RESTART_REQUIRED_KEYS, type WorkspaceSettings } from '../stores/settings.js'
import { hashPassword } from '../services/auth.js'
import type { Role, User } from '../types.js'
import { isAvailable as isOllamaAvailable } from '../services/embed.js'
import { invalidateMailCache, sendMail, verifySmtp } from '../services/mail.js'
import { restartVaultWatcher } from '../services/watcher.js'
import { ingestDocument } from '../services/ingest.js'
import { deleteDocument, listAllDocuments } from '../stores/documents.js'
import { invalidateSearchCache } from '../services/search.js'
import { readFile } from 'node:fs/promises'

const roleSchema = z.enum(['admin', 'editor', 'viewer'])

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin)

  app.get('/api/admin/users', async () => {
    const users = await listUsers()
    return { users: users.map(publicUser) }
  })

  app.patch('/api/admin/users/:username', async (req, reply) => {
    const { username } = req.params as { username: string }
    const u = await getUser(username)
    if (!u) return reply.code(404).send({ error: 'not found' })
    const body = z
      .object({
        role: roleSchema.optional(),
        disabled: z.boolean().optional(),
        quotaBytes: z.number().int().min(0).nullable().optional(),
        grants: z
          .array(
            z.object({
              path: z.string(),
              read: z.boolean(),
              write: z.boolean(),
              create: z.boolean(),
            }),
          )
          .optional(),
      })
      .parse(req.body)
    const next: User = {
      ...u,
      role: (body.role ?? u.role) as Role,
      disabled: body.disabled ?? u.disabled,
      grants: body.grants ? sanitizeGrants(body.grants) : u.grants,
      quotaBytes:
        body.quotaBytes === undefined ? u.quotaBytes : body.quotaBytes ?? undefined,
    }
    await saveUser(next)
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.user.patch',
      target: username,
      meta: { ...body, grants: body.grants ? body.grants.length : undefined },
    })
    return { user: publicUser(next) }
  })

  app.post('/api/admin/users', async (req, reply) => {
    const grantSchema = z
      .array(
        z.object({
          path: z.string(),
          read: z.boolean(),
          write: z.boolean(),
          create: z.boolean(),
        }),
      )
      .optional()
    const body = z
      .object({
        username: z.string().min(2).max(32),
        password: z.string().min(8).max(256),
        role: roleSchema.default('viewer'),
        grants: grantSchema,
      })
      .parse(req.body)
    if (!isValidUsername(body.username)) {
      return reply.code(400).send({ error: 'invalid username' })
    }
    if (await getUser(body.username)) {
      return reply.code(409).send({ error: 'username taken' })
    }
    const grants = body.grants ? sanitizeGrants(body.grants) : ROLE_PRESETS[body.role]
    const user: User = {
      username: body.username,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      createdAt: Date.now(),
      grants,
    }
    await saveUser(user)
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.user.create',
      target: user.username,
      meta: { role: user.role, grantCount: grants.length },
    })
    return reply.code(201).send({ user: publicUser(user) })
  })

  app.delete('/api/admin/users/:username', async (req, reply) => {
    const { username } = req.params as { username: string }
    if (username === req.currentUser!.username) {
      return reply.code(400).send({ error: 'cannot delete the currently signed-in user' })
    }
    const u = await getUser(username)
    if (!u) return reply.code(404).send({ error: 'not found' })
    await deleteUser(username)
    await audit({ actor: req.currentUser!.username, action: 'admin.user.delete', target: username })
    return { ok: true }
  })

  app.get('/api/admin/settings', async () => {
    const s = await loadSettings()
    return { settings: s }
  })

  app.patch('/api/admin/settings', async (req, reply) => {
    const grantArr = z.array(
      z.object({
        path: z.string(),
        read: z.boolean(),
        write: z.boolean(),
        create: z.boolean(),
      }),
    )
    const body = z
      .object({
        allowOpenSignup: z.boolean().optional(),
        defaultGrants: grantArr.optional(),
        vaultRoot: z.string().optional(),
        ingest: z
          .object({
            maxFileBytes: z.number().int().positive().optional(),
            chunkChars: z.number().int().positive().optional(),
            chunkOverlap: z.number().int().min(0).optional(),
          })
          .optional(),
        ollama: z
          .object({
            enabled: z.boolean().optional(),
            baseUrl: z.string().optional(),
            embedModel: z.string().optional(),
          })
          .optional(),
        storage: z
          .object({
            backend: z.enum(['local', 's3']).optional(),
            s3: z
              .object({
                endpoint: z.string().optional(),
                bucket: z.string().optional(),
                accessKey: z.string().optional(),
                secretKey: z.string().optional(),
                region: z.string().optional(),
                forcePathStyle: z.boolean().optional(),
              })
              .optional(),
          })
          .optional(),
        session: z
          .object({
            ttlDays: z.number().int().positive().optional(),
            cookieSecure: z.boolean().optional(),
            cookieSameSite: z.enum(['lax', 'strict', 'none']).optional(),
          })
          .optional(),
        server: z
          .object({
            host: z.string().optional(),
            port: z.number().int().positive().optional(),
          })
          .optional(),
        smtp: z
          .object({
            enabled: z.boolean().optional(),
            host: z.string().optional(),
            port: z.number().int().positive().optional(),
            user: z.string().optional(),
            pass: z.string().optional(),
            from: z.string().optional(),
            secure: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(req.body)
    const current = await loadSettings()
    // Deep-merge each known section so PATCH doesn't blow away sibling keys.
    const next: WorkspaceSettings = {
      ...current,
      ...(body.allowOpenSignup !== undefined && { allowOpenSignup: body.allowOpenSignup }),
      ...(body.vaultRoot !== undefined && { vaultRoot: body.vaultRoot }),
      ...(body.defaultGrants !== undefined && { defaultGrants: sanitizeGrants(body.defaultGrants) }),
      ingest: { ...(current.ingest ?? {}), ...(body.ingest ?? {}) },
      ollama: { ...(current.ollama ?? {}), ...(body.ollama ?? {}) },
      storage: {
        ...(current.storage ?? {}),
        ...(body.storage ?? {}),
        s3: { ...(current.storage?.s3 ?? {}), ...(body.storage?.s3 ?? {}) },
      },
      session: { ...(current.session ?? {}), ...(body.session ?? {}) },
      server: { ...(current.server ?? {}), ...(body.server ?? {}) },
      smtp: { ...(current.smtp ?? {}), ...(body.smtp ?? {}) },
    }
    try {
      await saveSettings(next)
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? String(e) })
    }
    // SMTP transport caches the connection; invalidate so the next sendMail()
    // rebuilds with the new host/credentials.
    if (body.smtp) invalidateMailCache()
    // Vault root may have moved — re-arm the file watcher against the new path.
    if (body.vaultRoot !== undefined) restartVaultWatcher(req.server.log)
    await audit({ actor: req.currentUser!.username, action: 'admin.settings.patch', meta: { ...body, smtp: body.smtp ? { ...body.smtp, pass: body.smtp.pass ? '***' : undefined } : undefined } })
    const touchedRestartKey = RESTART_REQUIRED_KEYS.some((k) => k in body)
    return { settings: next, restartRequired: touchedRestartKey }
  })

  // Re-index every document: read the original file from disk, re-extract text
  // (so OCR / extractor improvements apply), re-chunk, re-embed. Use after
  // changing the embedding model or expanding the extractor (e.g. OCR added).
  app.post('/api/admin/reembed-all', async (req) => {
    const docs = await listAllDocuments()
    let ok = 0
    let failed = 0
    let removed = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const d of docs) {
      try {
        const abs = path.join(config.vault.root, d.storageKey)
        const buffer = await readFile(abs)
        const updated = await ingestDocument(d, buffer)
        if (updated.ingest.embedded) ok++
        else failed++
      } catch (e: any) {
        // Orphan: meta references a file that's no longer on disk (vault moved,
        // file deleted externally, etc.). Drop the stale record so it doesn't
        // keep showing up in searches.
        if (e?.code === 'ENOENT') {
          await deleteDocument(d.id).catch(() => null)
          removed++
          continue
        }
        failed++
        errors.push({ id: d.id, error: e?.message ?? String(e) })
      }
    }
    invalidateSearchCache()
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.reindex-all',
      meta: { total: docs.length, ok, removed, failed },
    })
    return { total: docs.length, ok, removed, failed, errors: errors.slice(0, 10) }
  })

  app.post('/api/admin/smtp/test', async (req, reply) => {
    const body = z
      .object({ to: z.string().email() })
      .parse(req.body)
    const v = await verifySmtp()
    if (!v.ok) return reply.code(400).send({ error: v.error })
    const r = await sendMail({
      to: body.to,
      subject: 'Reader — SMTP test message',
      text: 'Your SMTP configuration works. This is an automated test email from Reader.',
      html: '<p>Your SMTP configuration works.</p><p>This is an automated test email from Reader.</p>',
    })
    if (!r.ok) return reply.code(400).send({ error: r.error })
    await audit({ actor: req.currentUser!.username, action: 'admin.smtp.test', meta: { to: body.to } })
    return { ok: true, id: r.id }
  })

  // Look up absolute paths that match a folder name under common roots ($HOME,
  // /Volumes). Used by the native folder picker — the browser only gives us the
  // folder name from a webkitdirectory pick, never the absolute path, so we
  // recover candidates server-side.
  app.get('/api/admin/find-folder', async (req, reply) => {
    const { name } = req.query as { name?: string }
    const target = (name ?? '').trim()
    if (!target) return reply.code(400).send({ error: 'name required' })
    if (target.includes('/') || target === '.' || target === '..') {
      return reply.code(400).send({ error: 'invalid folder name' })
    }
    const matches: string[] = []
    const SKIP = new Set(['node_modules', 'Library', 'Trash', '.Trash'])
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth <= 0 || matches.length >= 25) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (matches.length >= 25) return
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue
        if (SKIP.has(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.name === target) matches.push(full)
        await walk(full, depth - 1)
      }
    }
    const roots = [os.homedir(), '/Volumes']
    for (const root of roots) {
      await walk(root, 5)
    }
    return { matches }
  })

  // Browse server-side directories. Used by the workspace-settings folder
  // picker to choose a new vault root.
  app.get('/api/admin/browse', async (req, reply) => {
    const { path: rel } = req.query as { path?: string }
    const target = (rel && rel.trim()) || os.homedir()
    if (!path.isAbsolute(target)) {
      return reply.code(400).send({ error: 'absolute path required' })
    }
    const s = await stat(target).catch(() => null)
    if (!s || !s.isDirectory()) {
      return reply.code(404).send({ error: 'not found' })
    }
    let entries
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (e: any) {
      return reply.code(403).send({ error: e?.message ?? 'cannot read directory' })
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const parent = path.dirname(target)
    return {
      current: target,
      parent: parent === target ? null : parent,
      home: os.homedir(),
      entries: dirs,
    }
  })

  // Persist a new data-dir override. A separate "anchor" file holds it (outside
  // dataDir itself) so the server can read it at startup before any other path
  // is derived. Takes effect on next restart — existing data is NOT migrated.
  app.post('/api/admin/data-dir', async (req, reply) => {
    const body = z.object({ dataDir: z.string() }).parse(req.body)
    const target = body.dataDir.trim()
    if (!target) {
      // Clear the override → fall back to env / default on next restart.
      try {
        const { rm } = await import('node:fs/promises')
        await rm(ANCHOR_PATH, { force: true })
      } catch {}
      await audit({ actor: req.currentUser!.username, action: 'admin.data-dir.reset' })
      return { ok: true, dataDir: null, restartRequired: true }
    }
    if (!path.isAbsolute(target)) {
      return reply.code(400).send({ error: 'absolute path required' })
    }
    const s = await stat(target).catch(() => null)
    if (s && !s.isDirectory()) {
      return reply.code(400).send({ error: 'path exists but is not a directory' })
    }
    if (!s) {
      try {
        await mkdir(target, { recursive: true })
      } catch (e: any) {
        return reply.code(400).send({ error: `cannot create directory: ${e?.message ?? e}` })
      }
    }
    await mkdir(path.dirname(ANCHOR_PATH), { recursive: true })
    await writeFile(ANCHOR_PATH, JSON.stringify({ dataDir: target }, null, 2), 'utf8')
    await audit({ actor: req.currentUser!.username, action: 'admin.data-dir.set', meta: { dataDir: target } })
    return { ok: true, dataDir: target, restartRequired: true }
  })

  // Live list of models installed on the Ollama daemon. Used by the embed
  // model picker in workspace settings.
  app.get('/api/admin/ollama/models', async () => {
    try {
      const res = await fetch(`${config.ollama.baseUrl.replace(/\/+$/, '')}/api/tags`)
      if (!res.ok) {
        return { models: [] as string[], error: `ollama responded ${res.status}` }
      }
      const data = (await res.json()) as { models?: Array<{ name?: string }> }
      const names = (data.models ?? [])
        .map((m) => m.name ?? '')
        .filter((n) => n.length > 0)
        .sort((a, b) => a.localeCompare(b))
      return { models: names }
    } catch (e: any) {
      return { models: [] as string[], error: e?.message ?? String(e) }
    }
  })

  app.get('/api/admin/system', async () => {
    const ollamaUp = await isOllamaAvailable()
    return {
      vaultRoot: config.vault.root,
      dataDir: config.dataDir,
      ingest: {
        maxFileBytes: config.ingest.maxFileBytes,
        chunkChars: config.ingest.chunkChars,
        chunkOverlap: config.ingest.chunkOverlap,
      },
      ollama: {
        enabled: config.ollama.enabled,
        baseUrl: config.ollama.baseUrl,
        embedModel: config.ollama.embedModel,
        available: ollamaUp,
      },
      storage: {
        backend: config.storage.backend,
        s3: {
          endpoint: config.storage.s3.endpoint,
          bucket: config.storage.s3.bucket,
          accessKey: config.storage.s3.accessKey,
          region: config.storage.s3.region,
          forcePathStyle: config.storage.s3.forcePathStyle,
        },
      },
      session: {
        ttlDays: Math.round(config.session.ttlMs / (24 * 60 * 60 * 1000)),
        cookieSecure: config.session.secure,
        cookieSameSite: config.session.sameSite,
      },
      server: { host: config.server.host, port: config.server.port },
      smtp: {
        enabled: config.smtp.enabled,
        host: config.smtp.host,
        port: config.smtp.port,
        user: config.smtp.user,
        from: config.smtp.from,
        secure: config.smtp.secure,
        // never leak `pass`
        passSet: !!config.smtp.pass,
      },
      // backward-compat field
      maxFileBytes: config.ingest.maxFileBytes,
    }
  })

  app.get('/api/admin/tokens', async () => {
    const tokens = await listTokens()
    // Never leak hashes through the API surface.
    return {
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        createdBy: t.createdBy,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        disabled: t.disabled,
      })),
    }
  })

  app.post('/api/admin/tokens', async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(64),
        role: roleSchema.default('viewer'),
      })
      .parse(req.body)
    const { secret, record } = await createToken({ name: body.name, role: body.role, createdBy: req.currentUser!.username })
    await audit({ actor: req.currentUser!.username, action: 'admin.token.create', target: record.id })
    // Plain secret returned ONCE; never persisted.
    return reply.code(201).send({
      secret,
      token: {
        id: record.id,
        name: record.name,
        role: record.role,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
      },
    })
  })

  app.delete('/api/admin/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const ok = await deleteToken(id)
    if (!ok) return reply.code(404).send({ error: 'not found' })
    await audit({ actor: req.currentUser!.username, action: 'admin.token.delete', target: id })
    return { ok: true }
  })

  // Aggregate corpus stats — powers the admin Stats panel.
  app.get('/api/admin/stats', async () => {
    const docs = await listAllDocuments()
    let totalBytes = 0
    const byStatus: Record<string, number> = {}
    const byExt: Record<string, number> = {}
    const byOwner: Record<string, number> = {}
    let publicCount = 0
    let embeddedCount = 0
    const recent: Array<{ id: string; title: string; storageKey: string; createdAt: number }> = []
    for (const d of docs) {
      totalBytes += d.bytes || 0
      const status = d.ingest?.status ?? 'unknown'
      byStatus[status] = (byStatus[status] ?? 0) + 1
      const ext = path.extname(d.storageKey || d.originalFilename).toLowerCase() || '<none>'
      byExt[ext] = (byExt[ext] ?? 0) + 1
      byOwner[d.owner] = (byOwner[d.owner] ?? 0) + 1
      if (d.public) publicCount++
      if (d.ingest?.embedded) embeddedCount++
      recent.push({ id: d.id, title: d.title, storageKey: d.storageKey, createdAt: d.createdAt })
    }
    recent.sort((a, b) => b.createdAt - a.createdAt)
    const users = await listUsers()
    return {
      totals: {
        documents: docs.length,
        bytes: totalBytes,
        users: users.length,
        publicDocs: publicCount,
        embeddedDocs: embeddedCount,
      },
      byStatus,
      byExt: Object.entries(byExt)
        .map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count),
      byOwner: Object.entries(byOwner)
        .map(([owner, count]) => ({ owner, count }))
        .sort((a, b) => b.count - a.count),
      recent: recent.slice(0, 20),
    }
  })

  // Groups of documents sharing a sha256. The "keep" candidate is the oldest;
  // the admin can trash the rest from the UI.
  app.get('/api/admin/duplicates', async () => {
    const docs = await listAllDocuments()
    const groups = new Map<string, typeof docs>()
    for (const d of docs) {
      if (!d.sha256) continue
      const arr = groups.get(d.sha256) ?? []
      arr.push(d)
      groups.set(d.sha256, arr)
    }
    const out: Array<{
      sha256: string
      bytes: number
      docs: Array<{ id: string; storageKey: string; title: string; bytes: number; createdAt: number; owner: string }>
    }> = []
    for (const [sha256, arr] of groups) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.createdAt - b.createdAt)
      out.push({
        sha256,
        bytes: arr[0].bytes,
        docs: arr.map((d) => ({
          id: d.id,
          storageKey: d.storageKey,
          title: d.title,
          bytes: d.bytes,
          createdAt: d.createdAt,
          owner: d.owner,
        })),
      })
    }
    out.sort((a, b) => b.docs.length - a.docs.length || b.bytes - a.bytes)
    return { groups: out }
  })

  // Webhook config CRUD. Stored in workspace settings — global, not per-user.
  app.get('/api/admin/webhooks', async () => {
    const s = await loadSettings()
    return { webhooks: s.webhooks ?? [] }
  })

  app.post('/api/admin/webhooks', async (req, reply) => {
    const body = z
      .object({
        url: z.string().url(),
        events: z.array(z.enum(['upload', 'edit', 'delete', 'share', 'tags', 'visibility'])).min(1),
        secret: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const s = await loadSettings()
    const id = (await import('nanoid')).nanoid()
    const hook = {
      id,
      url: body.url,
      events: body.events,
      secret: body.secret,
      enabled: body.enabled ?? true,
      createdAt: Date.now(),
    }
    const next = { ...s, webhooks: [...(s.webhooks ?? []), hook] }
    await saveSettings(next)
    await audit({ actor: req.currentUser!.username, action: 'admin.webhook.create', target: id })
    return reply.code(201).send({ webhook: hook })
  })

  app.delete('/api/admin/webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const s = await loadSettings()
    const before = s.webhooks ?? []
    const after = before.filter((h) => h.id !== id)
    if (after.length === before.length) return reply.code(404).send({ error: 'not found' })
    await saveSettings({ ...s, webhooks: after })
    await audit({ actor: req.currentUser!.username, action: 'admin.webhook.delete', target: id })
    return { ok: true }
  })

  // Per-item audit trail — the admin panel + the doc viewer's activity tab
  // both consume this.
  app.get('/api/admin/activity', async (req) => {
    const { target, limit } = req.query as { target?: string; limit?: string }
    const lim = Math.min(Number(limit) || 100, 500)
    const { listAudit } = await import('../stores/audit.js')
    const entries = await listAudit({ target, limit: lim })
    return { entries }
  })
}
