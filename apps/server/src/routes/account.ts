import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config } from '../config.js'
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
    let failed = 0
    let removed = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const d of mine) {
      try {
        const abs = path.join(config.vault.root, d.storageKey)
        const buffer = await readFile(abs)
        const updated = await ingestDocument(d, buffer)
        if (updated.ingest.embedded) ok++
        else failed++
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
      meta: { total: mine.length, ok, removed, failed },
    })
    return { total: mine.length, ok, removed, failed, errors: errors.slice(0, 10) }
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
        const abs = path.join(config.vault.root, d.storageKey)
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
  app.get('/api/account/webhooks', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const s = await loadSettings()
    const me = req.currentUser.username
    return { webhooks: (s.webhooks ?? []).filter((h) => h.owner === me) }
  })

  app.post('/api/account/webhooks', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    if (req.currentUser.role === 'viewer') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const body = z
      .object({
        url: z.string().url(),
        events: z.array(
          z.enum(['upload', 'edit', 'delete', 'share', 'tags', 'visibility']),
        ),
        secret: z.string().max(256).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const hook: WebhookConfig = {
      id: nanoid(),
      url: body.url,
      events: body.events,
      secret: body.secret,
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
    return { webhook: hook }
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
}
