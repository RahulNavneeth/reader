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
import { ensureUserVault, resolveUserVault } from '../lib/userVault.js'
import { createToken, deleteToken, listTokens } from '../stores/tokens.js'
import { deleteAllSessionsForUser } from '../stores/sessions.js'
import { loadSettings, saveSettings, RESTART_REQUIRED_KEYS, type WorkspaceSettings } from '../stores/settings.js'
import {
  encryptSecret,
  retryDeadLetter,
  pingHook,
  rotateAllSecrets,
} from '../services/webhooks.js'
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

// Shared shape returned by the Duplicates endpoint for each member
// of an exact or perceptual group.
function toDocSummary(d: {
  id: string
  storageKey: string
  title: string
  bytes: number
  createdAt: number
  owner: string
}) {
  return {
    id: d.id,
    storageKey: d.storageKey,
    title: d.title,
    bytes: d.bytes,
    createdAt: d.createdAt,
    owner: d.owner,
  }
}

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
      })
      .parse(req.body)
    const next: User = {
      ...u,
      role: (body.role ?? u.role) as Role,
      disabled: body.disabled ?? u.disabled,
      quotaBytes:
        body.quotaBytes === undefined ? u.quotaBytes : body.quotaBytes ?? undefined,
    }
    await saveUser(next)
    // If we just disabled the user OR demoted them, revoke every
    // active session so other tabs don't keep working until expiry.
    const becameDisabled = !u.disabled && next.disabled
    const roleChanged = body.role !== undefined && body.role !== u.role
    if (becameDisabled || roleChanged) {
      await deleteAllSessionsForUser(username).catch(() => null)
    }
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.user.patch',
      target: username,
      meta: { ...body },
    })
    return { user: publicUser(next) }
  })

  app.post('/api/admin/users', async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(2).max(32),
        password: z.string().min(8).max(256),
        role: roleSchema.default('editor'),
      })
      .parse(req.body)
    if (!isValidUsername(body.username)) {
      return reply.code(400).send({ error: 'invalid username' })
    }
    if (await getUser(body.username)) {
      return reply.code(409).send({ error: 'username taken' })
    }
    const user: User = {
      username: body.username,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      createdAt: Date.now(),
    }
    await saveUser(user)
    await ensureUserVault(user.username).catch(() => null)
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.user.create',
      target: user.username,
      meta: { role: user.role },
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
    const body = z
      .object({
        allowOpenSignup: z.boolean().optional(),
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
            chatEnabled: z.boolean().optional(),
            chatModel: z.string().optional(),
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
        backup: z
          .object({
            enabled: z.boolean().optional(),
            schedule: z.enum(['daily', 'weekly']).optional(),
            time: z
              .string()
              .regex(/^\d{1,2}:\d{2}$/, 'time must be "HH:MM"')
              .optional(),
            weekday: z.number().int().min(0).max(6).optional(),
            outDir: z.string().optional(),
            retainDays: z.number().int().min(0).optional(),
          })
          .optional(),
        templates: z
          .object({
            allowFetch: z.boolean().optional(),
            fetchAllowlist: z.array(z.string()).optional(),
          })
          .optional(),
        clip: z
          .object({
            enabled: z.boolean().optional(),
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
      backup: { ...(current.backup ?? {}), ...(body.backup ?? {}) },
      templates: { ...(current.templates ?? {}), ...(body.templates ?? {}) },
      clip: { ...(current.clip ?? {}), ...(body.clip ?? {}) },
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
    // Backup cadence may have changed — reschedule the next fire without
    // bouncing the server.
    if (body.backup) {
      const { reapplyBackupSchedule } = await import(
        '../services/backupScheduler.js'
      )
      await reapplyBackupSchedule()
    }
    // Redact every secret-bearing field before audit: SMTP password, S3
    // credentials. Previously the S3 access/secret keys went to the
    // audit log in plaintext alongside whatever rest got spread in.
    const auditMeta = {
      ...body,
      smtp: body.smtp
        ? { ...body.smtp, pass: body.smtp.pass ? '***' : undefined }
        : undefined,
      storage: body.storage
        ? {
            ...body.storage,
            s3: body.storage.s3
              ? {
                  ...body.storage.s3,
                  accessKey: body.storage.s3.accessKey ? '***' : undefined,
                  secretKey: body.storage.s3.secretKey ? '***' : undefined,
                }
              : undefined,
          }
        : undefined,
    }
    await audit({ actor: req.currentUser!.username, action: 'admin.settings.patch', meta: auditMeta })
    const touchedRestartKey = RESTART_REQUIRED_KEYS.some((k) => k in body)
    return { settings: next, restartRequired: touchedRestartKey }
  })

  // Re-index every document: read the original file from disk, re-extract text
  // (so OCR / extractor improvements apply), re-chunk, re-embed. Use after
  // changing the embedding model or expanding the extractor (e.g. OCR added).
  app.post('/api/admin/reembed-all', async (req) => {
    const docs = await listAllDocuments()
    let ok = 0
    let embedded = 0
    let failed = 0
    let removed = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const d of docs) {
      // Files live under <vault_root>/<owner>/<storageKey>. Pre-fix
      // this joined storageKey directly under the vault root which
      // 404'd every readFile and the ENOENT branch below then
      // deleted every doc row — same bug as account.reembed.
      let abs: string
      try {
        abs = resolveUserVault(d.owner, d.storageKey)
      } catch (e: any) {
        failed++
        errors.push({ id: d.id, error: e?.message ?? 'invalid path' })
        continue
      }
      try {
        const buffer = await readFile(abs)
        const updated = await ingestDocument(d, buffer)
        // See account.reembed: `ok` = ingest succeeded; `embedded`
        // is the strict subset where vectors were also written.
        // Lets the caller distinguish "Ollama is down" from "files
        // are broken".
        ok++
        if (updated.ingest.embedded) embedded++
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
      meta: { total: docs.length, ok, embedded, removed, failed },
    })
    return {
      total: docs.length,
      ok,
      embedded,
      removed,
      failed,
      errors: errors.slice(0, 10),
    }
  })

  // Walk the vault on disk and ingest any file that isn't currently
  // in the DB. Recovery action for two scenarios:
  //   (a) Files dropped into the vault folder externally (Finder /
  //       rsync / git pull) and the watcher hasn't seen them yet —
  //       chokidar runs with `ignoreInitial: true` so existing-on-
  //       boot files are never picked up.
  //   (b) DB rows were destroyed but disk files survived — e.g. the
  //       account.reembed bug that mass-deleted rows when paths
  //       didn't resolve. The actual files are still there;
  //       reconcile re-indexes them.
  // Already-indexed files cost just a stat + sha compare (no
  // ingestion work) so running this on a clean vault is cheap.
  app.post('/api/admin/reconcile-vault', async (req) => {
    const { reconcileVault } = await import('../services/watcher.js')
    const q = req.query as { owner?: string }
    const ownerOnly = q.owner?.trim() || undefined
    const r = await reconcileVault(req.log, ownerOnly ? { ownerOnly } : {})
    invalidateSearchCache()
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.reconcile-vault',
      meta: { ...r, ownerOnly: ownerOnly ?? null },
    })
    return r
  })

  // Inverse of reconcile: drop SQLite rows that no longer have a
  // matching file on disk. Catches orphans left by legacy code paths
  // (the buggy DELETE that didn't drop the row, partial trashing,
  // etc.) so search + chat-agent retrieval don't surface ghosts.
  app.post('/api/admin/prune-orphan-docs', async (req) => {
    const { pruneOrphanedDocs } = await import('../stores/documents.js')
    const removed = await pruneOrphanedDocs()
    invalidateSearchCache()
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.prune-orphan-docs',
      meta: { removed },
    })
    return { removed }
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
        chatEnabled: config.ollama.chatEnabled,
        chatModel: config.ollama.chatModel,
        available: ollamaUp,
      },
      clip: {
        enabled: config.clip.enabled,
        model: config.clip.model,
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
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
        useCount: t.useCount,
        disabled: t.disabled,
      })),
    }
  })

  app.post('/api/admin/tokens', async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(64),
        role: roleSchema.default('editor'),
        // null = non-expiring (opt-in); default 90 days.
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body)
    const { secret, record } = await createToken({
      name: body.name,
      role: body.role,
      createdBy: req.currentUser!.username,
      expiresInDays: body.expiresInDays,
    })
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.token.create',
      target: record.id,
      meta: { role: body.role, expiresAt: record.expiresAt },
    })
    return reply.code(201).send({
      secret,
      token: {
        id: record.id,
        name: record.name,
        role: record.role,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
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
    const { hammingDistance } = await import('../services/perceptualHash.js')
    const docs = await listAllDocuments()

    // ─── Exact duplicates (sha256) ─────────────────────────────────
    const shaGroups = new Map<string, typeof docs>()
    for (const d of docs) {
      if (!d.sha256) continue
      const arr = shaGroups.get(d.sha256) ?? []
      arr.push(d)
      shaGroups.set(d.sha256, arr)
    }
    const exact: Array<{
      kind: 'exact'
      sha256: string
      bytes: number
      docs: Array<{ id: string; storageKey: string; title: string; bytes: number; createdAt: number; owner: string }>
    }> = []
    for (const [sha256, arr] of shaGroups) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.createdAt - b.createdAt)
      exact.push({
        kind: 'exact',
        sha256,
        bytes: arr[0].bytes,
        docs: arr.map(toDocSummary),
      })
    }

    // ─── Near-duplicates (perceptual hash) ─────────────────────────
    // Bucket images by pHash, then union-find by Hamming distance ≤ 6
    // (the typical "same shot, re-encoded" threshold for an 8x8
    // dHash). Skip anything already in an exact group — those would
    // also dHash-match but we don't want to double-list them.
    const exactIds = new Set<string>()
    for (const g of exact) for (const d of g.docs) exactIds.add(d.id)

    const hashed = docs.filter(
      (d) => d.pHash && typeof d.pHash === 'string' && !exactIds.has(d.id),
    )
    // Simple O(n²) clustering — fine up to a few thousand images. For
    // a larger vault this becomes the bottleneck; consider an LSH
    // index then.
    const parent = new Map<string, string>()
    const find = (x: string): string => {
      const p = parent.get(x)
      if (!p || p === x) return x
      const root = find(p)
      parent.set(x, root)
      return root
    }
    const union = (a: string, b: string) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (const d of hashed) parent.set(d.id, d.id)
    for (let i = 0; i < hashed.length; i++) {
      for (let j = i + 1; j < hashed.length; j++) {
        if (hammingDistance(hashed[i].pHash!, hashed[j].pHash!) <= 6) {
          union(hashed[i].id, hashed[j].id)
        }
      }
    }
    const clusters = new Map<string, typeof docs>()
    for (const d of hashed) {
      const root = find(d.id)
      const arr = clusters.get(root) ?? []
      arr.push(d)
      clusters.set(root, arr)
    }
    const near: Array<{
      kind: 'near'
      pHash: string
      docs: Array<{ id: string; storageKey: string; title: string; bytes: number; createdAt: number; owner: string }>
    }> = []
    for (const arr of clusters.values()) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.createdAt - b.createdAt)
      near.push({
        kind: 'near',
        pHash: arr[0].pHash!,
        docs: arr.map(toDocSummary),
      })
    }

    const groups = [...exact, ...near].sort(
      (a, b) =>
        b.docs.length - a.docs.length ||
        ('bytes' in b ? b.bytes : 0) - ('bytes' in a ? a.bytes : 0),
    )
    return { groups }
  })

  // Webhook config CRUD. Stored in workspace settings — global, not per-user.
  app.get('/api/admin/webhooks', async () => {
    const s = await loadSettings()
    // Strip the encrypted secret so it never leaves the server; the
    // UI just needs to know whether one is set.
    const webhooks = (s.webhooks ?? []).map(({ secret, ...rest }) => ({
      ...rest,
      hasSecret: !!secret,
    }))
    return { webhooks }
  })

  app.post('/api/admin/webhooks', async (req, reply) => {
    const body = z
      .object({
        url: z.string().url(),
        events: z.array(z.enum([
          'upload',
          'edit',
          'delete',
          'trash',
          'move',
          'mkdir',
          'share',
          'tags',
          'visibility',
          'folder-tags',
          'folder-visibility',
          'pin',
          'intake',
          'template',
          'export',
          'ingest',
          'archive',
        ])).min(1),
        // Secret is REQUIRED for admin hooks — without it any third
        // party that discovers the receiver URL can forge events.
        // Min 16 chars matches the account-side rule.
        secret: z.string().min(16),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const s = await loadSettings()
    const id = (await import('nanoid')).nanoid()
    const hook = {
      id,
      url: body.url,
      events: body.events,
      secret: encryptSecret(body.secret),
      enabled: body.enabled ?? true,
      createdAt: Date.now(),
    }
    const next = { ...s, webhooks: [...(s.webhooks ?? []), hook] }
    await saveSettings(next)
    await audit({ actor: req.currentUser!.username, action: 'admin.webhook.create', target: id })
    const { secret: _omit, ...sanitized } = hook
    return reply.code(201).send({ webhook: { ...sanitized, hasSecret: true } })
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

  // Edit an existing admin (global) webhook.
  app.patch('/api/admin/webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        url: z.string().url().optional(),
        events: z
          .array(z.enum([
          'upload',
          'edit',
          'delete',
          'trash',
          'move',
          'mkdir',
          'share',
          'tags',
          'visibility',
          'folder-tags',
          'folder-visibility',
          'pin',
          'intake',
          'template',
          'export',
          'ingest',
          'archive',
        ]))
          .min(1)
          .optional(),
        // Empty string clears (but admin hooks REQUIRE a secret, so
        // clearing is rejected). 16+ chars on update too.
        secret: z.string().min(16).max(256).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const s = await loadSettings()
    const hook = (s.webhooks ?? []).find((h) => h.id === id)
    if (!hook) return reply.code(404).send({ error: 'not found' })
    const reEnabling = body.enabled === true && hook.enabled === false
    const next = {
      ...hook,
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.events !== undefined ? { events: body.events } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.secret !== undefined ? { secret: encryptSecret(body.secret) } : {}),
      ...(reEnabling
        ? { consecutiveFailures: 0, circuitOpenedAt: undefined }
        : {}),
    }
    await saveSettings({
      ...s,
      webhooks: (s.webhooks ?? []).map((h) => (h.id === id ? next : h)),
    })
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.webhook.update',
      target: id,
      meta: { changed: Object.keys(body) },
    })
    const { secret: _omit, ...sanitized } = next
    return { webhook: { ...sanitized, hasSecret: !!next.secret } }
  })

  // Test-ping for admin webhooks.
  app.post('/api/admin/webhooks/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string }
    const s = await loadSettings()
    const hook = (s.webhooks ?? []).find((h) => h.id === id)
    if (!hook) return reply.code(404).send({ error: 'not found' })
    const r = await pingHook(hook)
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.webhook.test',
      target: id,
      meta: { status: r.status, ok: r.ok, error: r.error },
    })
    return r
  })

  // Re-attempt a single dead-letter entry. Used by the admin UI to
  // replay deliveries that exhausted their retry budget the first
  // time around.
  /**
   * Sweep every persisted hook's at-rest secret and re-encrypt it
   * under the current SESSION_SECRET. Use after rotating the session
   * secret: set SESSION_SECRET_PREVIOUS to the OLD secret, set
   * SESSION_SECRET to the NEW one, restart the server, then POST this
   * endpoint to rewrite every ciphertext. Once it returns failed=0,
   * SESSION_SECRET_PREVIOUS can be unset on the next restart.
   */
  app.post('/api/admin/webhooks/rotate-secrets', async (req) => {
    const result = await rotateAllSecrets()
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.webhook.rotate-secrets',
      meta: { ...result, errors: result.errors.length },
    })
    return result
  })

  app.post('/api/admin/webhooks/:id/retry/:entryId', async (req, reply) => {
    const { id, entryId } = req.params as { id: string; entryId: string }
    const r = await retryDeadLetter(id, entryId)
    if (!r.ok && r.error === 'hook not found') return reply.code(404).send(r)
    if (!r.ok && r.error === 'entry not found') return reply.code(404).send(r)
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.webhook.retry',
      target: `${id}/${entryId}`,
      meta: { status: r.status, error: r.error, ok: r.ok },
    })
    return r
  })

  // ─── OAuth clients (admin view) ────────────────────────────────────
  //
  // DCR is open by policy so anyone can register a client. These
  // endpoints let admins audit + delete what's been registered.
  // Delete cascades through ON DELETE CASCADE FKs to also drop every
  // auth code, access token, and refresh token owned by the client.

  app.get('/api/admin/oauth-clients', async () => {
    const { listClientsWithUsage } = await import('../db/oauthRepo.js')
    return { clients: listClientsWithUsage() }
  })

  app.delete('/api/admin/oauth-clients/:clientId', async (req, reply) => {
    const { clientId } = req.params as { clientId: string }
    const { deleteClient } = await import('../db/oauthRepo.js')
    const ok = deleteClient(clientId)
    if (!ok) return reply.code(404).send({ error: 'not found' })
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.oauth.client.delete',
      target: clientId,
    })
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

  // In-flight + recent background jobs.
  app.get('/api/admin/jobs', async () => {
    const { listJobs, jobCounts } = await import('../services/jobs.js')
    return { jobs: listJobs({ limit: 100 }), counts: jobCounts() }
  })

  // Last-run state for the scheduled-backup panel. Includes the
  // pre-computed `nextFireAt` so the UI doesn't redo the math.
  app.get('/api/admin/backup/state', async () => {
    const { readBackupState } = await import('../services/backupScheduler.js')
    return readBackupState()
  })

  // Trigger a backup outside the schedule. Same handler the timer
  // uses internally — serialises against concurrent runs so a frantic
  // click doesn't double-tar the vault.
  app.post('/api/admin/backup/run-now', async (req, reply) => {
    const { runBackupNow } = await import('../services/backupScheduler.js')
    try {
      const state = await runBackupNow(
        'manual',
        req.currentUser?.username ?? 'system',
        req.server.log,
      )
      return state
    } catch (e: any) {
      return reply.code(409).send({ error: e?.message ?? String(e) })
    }
  })
}
