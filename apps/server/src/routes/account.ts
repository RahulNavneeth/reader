import type { FastifyInstance } from 'fastify'
import type { User } from '../types.js'
import { readFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { resolveUserVault } from '../lib/userVault.js'
import { audit } from '../stores/audit.js'
import {
  deleteDocument,
  listAllDocuments,
  saveMeta,
} from '../stores/documents.js'
import { ingestDocument } from '../services/ingest.js'
import { invalidateSearchCache } from '../services/search.js'
import { couldHaveGps, extractGps } from '../services/gps.js'
import { getUser, saveUser } from '../stores/users.js'
import { createToken, deleteToken, listTokens } from '../stores/tokens.js'
import { loadSettings, saveSettings, type WebhookConfig } from '../stores/settings.js'
import { encryptSecret, retryDeadLetter, pingHook, EVENT_SHAPES } from '../services/webhooks.js'

/**
 * Per-user account endpoints — the user-facing twin of the admin
 * routes. Everything here is scoped to the calling user:
 *
 *   - email contact address
 *   - API tokens they minted themselves
 *   - webhooks fired only for events on their files
 *   - re-index pass over their own docs
 *
 * Admin routes still exist for cross-user operations.
 */
export async function accountRoutes(app: FastifyInstance) {
  // ─── Email ──────────────────────────────────────────────────────────────
  app.patch('/api/account/email', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    // Allow clearing by sending an empty string; coerce to undefined on save.
    const body = z
      .object({ email: z.string().email().or(z.literal('')) })
      .parse(req.body)
    const user = await getUser(req.currentUser.username)
    if (!user) return reply.code(404).send({ error: 'user not found' })
    const next = { ...user, email: body.email ? body.email.trim() : undefined }
    await saveUser(next)
    await audit({
      actor: user.username,
      action: 'account.email',
      meta: { email: next.email ?? null },
    })
    return { user: app.publicUser(next) }
  })

  // ─── Re-index (user-scoped) ─────────────────────────────────────────────
  app.post('/api/account/reembed', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    if (req.currentUser.role === 'viewer') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const username = req.currentUser.username
    const all = await listAllDocuments()
    const mine = all.filter((d) => d.owner === username)
    let ok = 0
    let embedded = 0
    let failed = 0
    let removed = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const d of mine) {
      // Files live under <vault_root>/<owner>/<storageKey>. The
      // previous `path.join(config.vault.root, d.storageKey)` was
      // missing the owner segment, so EVERY readFile 404'd and the
      // ENOENT branch below deleted the doc row — re-index nuked
      // the index. Resolve through the per-user vault helper so
      // the path is correct AND a malicious storageKey can't
      // escape the user's directory.
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
        // Ingest succeeded if it returned without throwing — the
        // file was read, chunked, and meta was rewritten. Embedding
        // is a separate concern: if Ollama is down the doc is still
        // in a valid state, just without vectors, and re-running
        // reembed once Ollama recovers will fill them in.
        ok++
        if (updated.ingest.embedded) embedded++
      } catch (e: any) {
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
      actor: username,
      action: 'account.reindex',
      meta: { total: mine.length, ok, embedded, removed, failed },
    })
    return {
      total: mine.length,
      ok,
      embedded,
      removed,
      failed,
      errors: errors.slice(0, 10),
    }
  })

  // ─── API tokens (user-scoped) ───────────────────────────────────────────
  app.get('/api/account/tokens', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const all = await listTokens()
    return { tokens: all.filter((t) => t.createdBy === req.currentUser!.username) }
  })

  app.post('/api/account/tokens', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    if (req.currentUser.role === 'viewer') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const body = z
      .object({
        name: z.string().min(1).max(80),
        // Cap the minted token's role at the caller's role — a regular
        // editor cannot mint an admin token for themselves.
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body)
    const r = await createToken({
      name: body.name.trim(),
      role: req.currentUser.role,
      createdBy: req.currentUser.username,
      expiresInDays: body.expiresInDays,
    })
    await audit({
      actor: req.currentUser.username,
      action: 'account.token.create',
      target: r.record.id,
      meta: { name: r.record.name },
    })
    return { secret: r.secret, token: r.record }
  })

  app.delete('/api/account/tokens/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id } = req.params as { id: string }
    const all = await listTokens()
    const target = all.find((t) => t.id === id)
    if (!target) return reply.code(404).send({ error: 'not found' })
    // Caller may only delete their own tokens (admins can use the
    // admin endpoint to delete anyone's).
    if (target.createdBy !== req.currentUser.username) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const ok = await deleteToken(id)
    if (!ok) return reply.code(404).send({ error: 'not found' })
    await audit({
      actor: req.currentUser.username,
      action: 'account.token.delete',
      target: id,
    })
    return { ok: true }
  })

  // ─── Account preferences ───────────────────────────────────────────────
  //
  // Settings that live on the User record (as opposed to workspace-wide
  // settings under /api/admin/settings). Currently just the
  // "revoke OAuth on signout" toggle; intentionally a single endpoint
  // we can extend rather than one route per preference.

  app.patch('/api/account/preferences', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const body = z
      .object({
        revokeOauthOnSignout: z.boolean().optional(),
      })
      .parse(req.body)
    const me = req.currentUser
    const next: User = {
      ...me,
      ...(body.revokeOauthOnSignout !== undefined
        ? { revokeOauthOnSignout: body.revokeOauthOnSignout }
        : {}),
    }
    await saveUser(next)
    await audit({
      actor: me.username,
      action: 'account.preferences.update',
      meta: body as Record<string, unknown>,
    })
    return { user: app.publicUser(next) }
  })

  // ─── OAuth grants (third-party MCP connections) ────────────────────────

  /**
   * Active OAuth grants — one row per (this user, client) pair with at
   * least one unexpired access token. Powers the "Connected Apps" page
   * so users can audit + revoke MCP client connections.
   */
  app.get('/api/account/oauth-grants', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { listGrantsForUser } = await import('../db/oauthRepo.js')
    return { grants: listGrantsForUser(req.currentUser.username) }
  })

  /**
   * Drop every access + refresh token for the (caller, client) pair.
   * The client app keeps running but its next /mcp call gets 401 and
   * its refresh attempt gets `invalid_grant`. To reconnect, the user
   * walks through the OAuth flow again.
   */
  app.delete('/api/account/oauth-grants/:clientId', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { clientId } = req.params as { clientId: string }
    const { revokeGrant } = await import('../db/oauthRepo.js')
    const out = revokeGrant(req.currentUser.username, clientId)
    await audit({
      actor: req.currentUser.username,
      action: 'oauth.grant.revoke',
      target: clientId,
      meta: out,
    })
    return { ok: true }
  })

  // ─── Map (geotagged photos) ─────────────────────────────────────────────
  //
  // Returns the caller's image docs that have GPS coords. Lazily
  // backfills the `gps` field on legacy docs (uploaded before EXIF
  // extraction was wired into ingest) — capped per request so a vault
  // full of photos doesn't tie up one HTTP request for minutes.
  app.get('/api/account/map', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const username = req.currentUser.username
    const all = await listAllDocuments()
    const mine = all.filter((d) => d.owner === username)

    const BACKFILL_LIMIT = 25 // per request
    let backfilled = 0
    const pinsTried = new Set<string>()
    for (const d of mine) {
      if (d.gps !== undefined) continue
      if (!couldHaveGps(d.originalFilename)) continue
      if (backfilled >= BACKFILL_LIMIT) break
      pinsTried.add(d.id)
      try {
        const abs = resolveUserVault(d.owner, d.storageKey)
        const buf = await readFile(abs)
        const gps = await extractGps(buf, d.originalFilename)
        if (gps !== undefined) {
          d.gps = gps
          await saveMeta(d)
          backfilled++
        }
      } catch {
        /* skip — file missing, etc. */
      }
    }

    // Dedupe by (sha256, then storageKey) BEFORE filtering. Same
    // physical bytes = same photo, regardless of path — catches
    // move/rename/re-ingest cases where one image ends up with
    // multiple DocumentMeta records under different storageKeys. Falls
    // back to storageKey for legacy docs missing sha256. Without this
    // dedup, each duplicate would render as its own pin, inflating
    // both the photo count and the cluster count.
    const seen = new Set<string>()
    const dedup = mine.filter((d) => {
      const key = d.sha256 ? `sha:${d.sha256}` : `path:${d.storageKey}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const items = dedup
      .filter(
        (d) =>
          d.gps &&
          typeof d.gps.lat === 'number' &&
          typeof d.gps.lng === 'number' &&
          // Drop already-cached "Null Island" junk. New ingests get
          // filtered in extractGps; this catches docs ingested before
          // that filter existed.
          !(Math.abs(d.gps.lat) < 0.01 && Math.abs(d.gps.lng) < 0.01),
      )
      .map((d) => {
        // Pre-migration docs occasionally carry the owner segment in
        // their storageKey ("rahulmnavneeth/IMG_8161.heic"). The vault
        // routes resolve paths relative to the user's namespace, so a
        // prefixed key 404s. Strip it before handing the URL to the
        // client so "Open" navigates to a real file.
        let path = d.storageKey
        const prefix = username + '/'
        if (path.startsWith(prefix)) path = path.slice(prefix.length)
        return {
          docId: d.id,
          path,
          name: d.originalFilename,
          mime: d.mime,
          createdAt: d.createdAt,
          lat: d.gps!.lat,
          lng: d.gps!.lng,
        }
      })

    // True if there are still legacy images we haven't tried yet — the
    // client can poll /map again to continue the backfill.
    const moreToBackfill = mine.some(
      (d) =>
        d.gps === undefined &&
        couldHaveGps(d.originalFilename) &&
        !pinsTried.has(d.id),
    )

    return { items, backfilled, moreToBackfill }
  })

  // ─── Webhooks (user-scoped) ─────────────────────────────────────────────
  //
  // We piggyback on the existing global webhook list in settings.json by
  // tagging each entry with `owner`. The dispatcher (services/webhooks.ts)
  // only fires a hook to its owner's events; legacy hooks without an
  // owner fire for everyone (back-compat with workspace-global hooks).
  // Static schema doc — no auth needed because it just describes the
  // public event shapes (no per-tenant data). The picker UI links here
  // so receivers know exactly what JSON will hit their endpoint.
  app.get('/api/account/webhooks/event-shapes', async () => {
    return {
      envelope: {
        description: 'Every dispatched payload (except test pings) is wrapped with these envelope fields in addition to the per-event keys.',
        fields: {
          ts: 'Number — unix-ms when dispatch ran.',
          appUrl: 'String — the public Reader URL (from APP_URL env).',
          itemUrl: 'String — deep link to the affected path in Reader.',
        },
        headers: {
          'X-Reader-Event': 'Event type, e.g. "upload".',
          'X-Reader-Delivery': 'UUID per delivery attempt — use for idempotency.',
          'X-Reader-Attempt': 'Attempt number ("1"–"4") or "retry" / "test".',
          'X-Reader-Signature': 'HMAC-SHA256(secret, raw body) hex digest. Only present when a secret is configured.',
        },
      },
      events: EVENT_SHAPES,
    }
  })

  app.get('/api/account/webhooks', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const s = await loadSettings()
    const me = req.currentUser.username
    // Strip the encrypted secret from API responses — the UI only
    // needs to know whether one is set (`hasSecret`), never the
    // ciphertext itself.
    const webhooks = (s.webhooks ?? [])
      .filter((h) => h.owner === me)
      .map(({ secret, ...rest }) => ({ ...rest, hasSecret: !!secret }))
    return { webhooks }
  })

  app.post('/api/account/webhooks', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    if (req.currentUser.role === 'viewer') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const body = z
      .object({
        url: z.string().url(),
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
          ]))
          .min(1),
        // Secret is optional, but when present we enforce a 16-char
        // minimum (same as admin) — anything shorter doesn't add
        // meaningful entropy to the HMAC.
        secret: z
          .string()
          .min(16, 'secret must be at least 16 characters')
          .max(256)
          .optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const hook: WebhookConfig = {
      id: nanoid(),
      url: body.url,
      events: body.events,
      secret: body.secret ? encryptSecret(body.secret) : undefined,
      enabled: body.enabled ?? true,
      createdAt: Date.now(),
      owner: req.currentUser.username,
    }
    const s = await loadSettings()
    await saveSettings({ ...s, webhooks: [...(s.webhooks ?? []), hook] })
    await audit({
      actor: req.currentUser.username,
      action: 'account.webhook.create',
      target: hook.id,
      meta: { url: hook.url, events: hook.events },
    })
    const { secret: _omit, ...sanitized } = hook
    return { webhook: { ...sanitized, hasSecret: !!hook.secret } }
  })

  app.delete('/api/account/webhooks/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id } = req.params as { id: string }
    const s = await loadSettings()
    const hook = (s.webhooks ?? []).find((h) => h.id === id)
    if (!hook) return reply.code(404).send({ error: 'not found' })
    if (hook.owner !== req.currentUser.username) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await saveSettings({
      ...s,
      webhooks: (s.webhooks ?? []).filter((h) => h.id !== id),
    })
    await audit({
      actor: req.currentUser.username,
      action: 'account.webhook.delete',
      target: id,
    })
    return { ok: true }
  })

  // Edit an existing hook. Any combination of url/events/secret/
  // enabled can be supplied. Omitted fields stay as-is. Passing an
  // empty-string secret clears the existing one.
  app.patch('/api/account/webhooks/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    if (req.currentUser.role === 'viewer') {
      return reply.code(403).send({ error: 'forbidden' })
    }
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
          ]))
          .min(1)
          .optional(),
        secret: z
          .union([z.literal(''), z.string().min(16).max(256)])
          .optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const s = await loadSettings()
    const hook = (s.webhooks ?? []).find((h) => h.id === id)
    if (!hook) return reply.code(404).send({ error: 'not found' })
    if (hook.owner !== req.currentUser.username) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    // Manually re-enabling clears the circuit breaker — user is
    // asserting the receiver is healthy now, so we should start
    // counting from zero rather than auto-disabling again on the
    // next failure.
    const reEnabling = body.enabled === true && hook.enabled === false
    const next: WebhookConfig = {
      ...hook,
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.events !== undefined ? { events: body.events } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.secret !== undefined
        ? { secret: body.secret ? encryptSecret(body.secret) : undefined }
        : {}),
      ...(reEnabling
        ? { consecutiveFailures: 0, circuitOpenedAt: undefined }
        : {}),
    }
    await saveSettings({
      ...s,
      webhooks: (s.webhooks ?? []).map((h) => (h.id === id ? next : h)),
    })
    await audit({
      actor: req.currentUser.username,
      action: 'account.webhook.update',
      target: id,
      meta: {
        changed: Object.keys(body),
        url: next.url,
        events: next.events,
        enabled: next.enabled,
      },
    })
    const { secret: _omit, ...sanitized } = next
    return { webhook: { ...sanitized, hasSecret: !!next.secret } }
  })

  // Synthetic test event — fires a hand-crafted `upload` payload to
  // the hook so the user can verify reachability without creating a
  // real file. Returns the resulting delivery status synchronously so
  // the UI can show success/failure inline.
  app.post('/api/account/webhooks/:id/test', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id } = req.params as { id: string }
    const s = await loadSettings()
    const hook = (s.webhooks ?? []).find((h) => h.id === id)
    if (!hook) return reply.code(404).send({ error: 'not found' })
    if (hook.owner !== req.currentUser.username) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const r = await pingHook(hook)
    await audit({
      actor: req.currentUser.username,
      action: 'account.webhook.test',
      target: id,
      meta: { status: r.status, ok: r.ok, error: r.error },
    })
    return r
  })

  // Owner-scoped wrapper around the dispatcher's DLQ retry so a user
  // can replay one of THEIR own failed deliveries (admins use the
  // admin-route variant for global hooks).
  app.post('/api/account/webhooks/:id/retry/:entryId', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id, entryId } = req.params as { id: string; entryId: string }
    const s = await loadSettings()
    const hook = (s.webhooks ?? []).find((h) => h.id === id)
    if (!hook) return reply.code(404).send({ error: 'not found' })
    if (hook.owner !== req.currentUser.username) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const r = await retryDeadLetter(id, entryId)
    if (!r.ok && (r.error === 'hook not found' || r.error === 'entry not found')) {
      return reply.code(404).send(r)
    }
    await audit({
      actor: req.currentUser.username,
      action: 'account.webhook.retry',
      target: `${id}/${entryId}`,
      meta: { status: r.status, ok: r.ok, error: r.error },
    })
    return r
  })
}
