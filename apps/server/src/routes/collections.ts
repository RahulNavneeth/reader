/**
 * Collections REST API.
 *
 *   GET    /api/collections                              — list mine + shared with me
 *   POST   /api/collections                              — create
 *   GET    /api/collections/:id                          — detail + items + my role
 *   PATCH  /api/collections/:id                          — rename / description / cover
 *   DELETE /api/collections/:id                          — delete (members + shares cascade)
 *   POST   /api/collections/:id/items                    — { docIds: string[] } add
 *   DELETE /api/collections/:id/items/:docId             — remove one
 *   GET    /api/collections/_by-doc/:docId               — which of mine contain this doc
 *   POST   /api/collections/:id/shares                   — share with user
 *   DELETE /api/collections/:id/shares/:recipient        — unshare
 *
 * Sharing semantics (v1): a recipient sees the collection in their
 * sidebar and can view the collection page. Access to each member
 * doc still goes through the per-doc ACL — i.e. sharing the
 * collection does NOT cascade read access to all members yet.
 * Cascade is the next iteration; doing it here would touch every
 * /api/file/* read-gate and is a larger surface to test than one
 * session can absorb safely.
 */
import { nanoid } from 'nanoid'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { audit } from '../stores/audit.js'
import { loadMeta, readPreview, readThumbnail, readText as readDocText } from '../stores/documents.js'
import * as collections from '../db/collectionsRepo.js'
import { hashPassword, verifyPassword } from '../lib/sharePassword.js'
import { resolveUserVault } from '../lib/userVault.js'

export async function collectionsRoutes(app: FastifyInstance) {
  app.get('/api/collections', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const me = req.currentUser.username

    // For each collection, peek at up to the first 4 member docs and
    // hand the client their {docId, path, kind} tuple so the card on
    // /collections can paint a real mosaic cover instead of a blank
    // folder icon. Kept to 4 because that's enough for a 2x2 mosaic
    // and any larger N would inflate the response without changing
    // the visual.
    const previewFor = async (
      cid: string,
    ): Promise<
      Array<{ docId: string; path: string; kind: 'image' | 'video' | 'file' }>
    > => {
      const members = collections.listMembers(cid).slice(0, 4)
      const out: Array<{ docId: string; path: string; kind: 'image' | 'video' | 'file' }> = []
      for (const m of members) {
        const meta = await loadMeta(m.docId)
        if (!meta) continue
        const ext = meta.originalFilename.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ''
        const kind: 'image' | 'video' | 'file' =
          /\.(png|jpe?g|webp|gif|avif|bmp|ico|heic|heif|tiff?|jxl)$/.test(ext)
            ? 'image'
            : /\.(mp4|mov|m4v|mkv|webm|avi|3gp|3gpp|mts|m2ts|mpg|mpeg|wmv|flv|ogv)$/.test(ext)
              ? 'video'
              : 'file'
        out.push({ docId: meta.id, path: meta.storageKey, kind })
      }
      return out
    }

    const mineRaw = collections.listByOwner(me)
    const sharedRaw = collections.listSharedTo(me)
    // Resolve previews in parallel — each call is a couple of
    // indexed lookups, so even 50 collections finishes in a few ms.
    const mine = await Promise.all(
      mineRaw.map(async (c) => ({
        ...c,
        role: 'owner' as const,
        memberCount: collections.memberCount(c.id),
        preview: await previewFor(c.id),
      })),
    )
    const shared = await Promise.all(
      sharedRaw.map(async (c) => ({
        ...c,
        role: (c.canEdit ? 'editor' : 'viewer') as 'editor' | 'viewer',
        memberCount: collections.memberCount(c.id),
        preview: await previewFor(c.id),
      })),
    )
    return { mine, shared }
  })

  app.post('/api/collections', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    if (req.currentUser.role === 'viewer') {
      return reply.code(403).send({ error: 'viewers cannot create collections' })
    }
    const body = req.body as { name?: string; description?: string | null }
    const name = (body?.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name required' })
    if (name.length > 200) return reply.code(400).send({ error: 'name too long' })
    const id = nanoid()
    const created = collections.create({
      id,
      owner: req.currentUser.username,
      name,
      description: body?.description ?? null,
    })
    await audit({
      actor: req.currentUser.username,
      action: 'collection.create',
      target: id,
      meta: { name },
    })
    return { collection: created }
  })

  app.get<{ Params: { id: string } }>(
    '/api/collections/:id',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (!collections.userCanView(c, me, role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      const canEdit = collections.userCanEdit(c, me, role)
      // Hydrate the members with the latest doc meta. Drop dangling
      // entries quietly — a doc may have been deleted but the row
      // hasn't been swept yet (FK cascade catches it eventually).
      const members = collections.listMembers(c.id)
      const items: Array<{
        docId: string
        path: string
        title: string
        mime: string
        bytes: number
        kind: 'image' | 'video' | 'file'
        addedAt: number
        position: number | null
      }> = []
      for (const m of members) {
        const meta = await loadMeta(m.docId)
        if (!meta) continue
        const ext = meta.originalFilename.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ''
        const kind: 'image' | 'video' | 'file' =
          /\.(png|jpe?g|webp|gif|avif|bmp|ico|heic|heif|tiff?|jxl)$/.test(ext)
            ? 'image'
            : /\.(mp4|mov|m4v|mkv|webm|avi|3gp|3gpp|mts|m2ts|mpg|mpeg|wmv|flv|ogv)$/.test(ext)
              ? 'video'
              : 'file'
        items.push({
          docId: m.docId,
          path: meta.storageKey,
          title: meta.title,
          mime: meta.mime,
          bytes: meta.bytes,
          kind,
          addedAt: m.addedAt,
          position: m.position,
        })
      }
      const shares = c.owner === me || role === 'admin'
        ? collections.listShares(c.id)
        : []
      // Owner sees the public-link state; non-owners only see the
      // boolean public flag (so a recipient can tell a collection is
      // shared publicly even if they can't manage the link).
      const publicView = c.owner === me || role === 'admin'
        ? {
            public: c.public,
            publicExpiresAt: c.publicExpiresAt,
            publicSlug: c.publicSlug,
            hasPassword: !!c.publicPasswordHash,
          }
        : { public: c.public }
      return {
        collection: {
          id: c.id,
          owner: c.owner,
          name: c.name,
          description: c.description,
          coverDocId: c.coverDocId,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          role: canEdit ? (c.owner === me ? 'owner' : 'editor') : 'viewer',
          ...publicView,
        },
        items,
        shares,
      }
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/api/collections/:id',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (!collections.userCanEdit(c, me, role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      const body = req.body as {
        name?: string
        description?: string | null
        coverDocId?: string | null
      }
      const patch: Parameters<typeof collections.update>[1] = {}
      if (body?.name !== undefined) {
        const trimmed = body.name.trim()
        if (!trimmed) return reply.code(400).send({ error: 'name cannot be empty' })
        if (trimmed.length > 200) return reply.code(400).send({ error: 'name too long' })
        patch.name = trimmed
      }
      if (body?.description !== undefined) patch.description = body.description
      if (body?.coverDocId !== undefined) patch.coverDocId = body.coverDocId
      const next = collections.update(c.id, patch)
      await audit({
        actor: me,
        action: 'collection.update',
        target: c.id,
        meta: patch,
      })
      return { collection: next }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/collections/:id',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      // Only the owner (or an admin) can delete — even an editor-share
      // recipient can't kill someone else's collection.
      if (c.owner !== me && role !== 'admin') {
        return reply.code(403).send({ error: 'forbidden' })
      }
      collections.remove(c.id)
      await audit({ actor: me, action: 'collection.delete', target: c.id })
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/collections/:id/items',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (!collections.userCanEdit(c, me, role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      const body = req.body as { docIds?: string[]; paths?: string[] }
      const docIdsIn = Array.isArray(body?.docIds) ? body!.docIds! : []
      const pathsIn = Array.isArray(body?.paths) ? body!.paths! : []
      if (docIdsIn.length === 0 && pathsIn.length === 0) {
        return reply.code(400).send({ error: 'docIds or paths required' })
      }

      // Resolve paths → docIds against the caller's own vault. We
      // don't follow share grants here on purpose: the bulk-select
      // toolbar always operates on the user's current folder view,
      // and looking up a path against the global doc index avoids
      // cross-vault collisions when two users have a same-named file.
      const { listAllDocuments, userCanRead } = await import(
        '../stores/documents.js'
      )
      const docs = pathsIn.length > 0 ? await listAllDocuments() : []
      const resolvedFromPaths: string[] = []
      const pathSkipped: Array<{ docId: string; reason: string }> = []
      for (const p of pathsIn) {
        const meta = docs.find((d) => d.storageKey === p && d.owner === me)
        if (!meta) {
          pathSkipped.push({ docId: p, reason: 'not found' })
          continue
        }
        resolvedFromPaths.push(meta.id)
      }

      const docIds = [...new Set([...docIdsIn, ...resolvedFromPaths])]

      // Only add docs the caller can actually read — otherwise an
      // attacker could probe what doc IDs exist by membership errors.
      const added: string[] = []
      const skipped: Array<{ docId: string; reason: string }> = [...pathSkipped]
      for (const docId of docIds) {
        const meta = await loadMeta(docId)
        if (!meta) {
          skipped.push({ docId, reason: 'not found' })
          continue
        }
        if (!userCanRead(meta, me, role)) {
          skipped.push({ docId, reason: 'permission denied' })
          continue
        }
        collections.addMember(c.id, docId)
        added.push(docId)
      }
      await audit({
        actor: me,
        action: 'collection.add-items',
        target: c.id,
        meta: { added: added.length, skipped: skipped.length },
      })
      return { added, skipped }
    },
  )

  app.delete<{ Params: { id: string; docId: string } }>(
    '/api/collections/:id/items/:docId',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (!collections.userCanEdit(c, me, role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      collections.removeMember(c.id, req.params.docId)
      await audit({
        actor: me,
        action: 'collection.remove-item',
        target: c.id,
        meta: { docId: req.params.docId },
      })
      return { ok: true }
    },
  )

  app.get<{ Params: { docId: string } }>(
    '/api/collections/_by-doc/:docId',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      // Only surface the caller's own collections — answering the
      // question "which of MY collections is this doc already in" is
      // what the file's "Add to collection" picker needs.
      const cols = collections.collectionsContainingDoc(
        req.params.docId,
        req.currentUser.username,
      )
      return { collections: cols }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/collections/:id/shares',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (c.owner !== me && role !== 'admin') {
        return reply.code(403).send({ error: 'only the owner can manage shares' })
      }
      const body = req.body as { recipient?: string; canEdit?: boolean }
      const recipient = (body?.recipient ?? '').trim()
      if (!recipient) return reply.code(400).send({ error: 'recipient required' })
      if (recipient === me) {
        return reply.code(400).send({ error: 'cannot share with yourself' })
      }
      // Verify the recipient exists as a user — sharing with a typo
      // would silently grant nothing.
      const { getUser } = await import('../stores/users.js')
      const u = await getUser(recipient)
      if (!u) return reply.code(404).send({ error: 'no such user' })
      const created = collections.share({
        collectionId: c.id,
        recipient,
        canEdit: !!body?.canEdit,
      })
      await audit({
        actor: me,
        action: 'collection.share',
        target: c.id,
        meta: { recipient, canEdit: !!body?.canEdit },
      })
      return { share: created }
    },
  )

  app.delete<{ Params: { id: string; recipient: string } }>(
    '/api/collections/:id/shares/:recipient',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (c.owner !== me && role !== 'admin') {
        return reply.code(403).send({ error: 'only the owner can manage shares' })
      }
      collections.unshare(c.id, req.params.recipient)
      await audit({
        actor: me,
        action: 'collection.unshare',
        target: c.id,
        meta: { recipient: req.params.recipient },
      })
      return { ok: true }
    },
  )

  // ------------- Public link -------------

  /**
   * Flip a collection's public-link state. Owner-only (or admin).
   * Body: { isPublic: bool, expiresInSeconds?: number, password?: string }
   * Returns the public slug + a ready-to-paste URL.
   */
  app.post<{ Params: { id: string } }>(
    '/api/collections/:id/public',
    async (req, reply) => {
      if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
      const c = collections.load(req.params.id)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const me = req.currentUser.username
      const role = req.currentUser.role
      if (c.owner !== me && role !== 'admin') {
        return reply.code(403).send({ error: 'only the owner can publish' })
      }
      const body = req.body as {
        isPublic?: boolean
        expiresInSeconds?: number | null
        password?: string | null
      }
      if (!body?.isPublic) {
        const next = collections.setPublic(c.id, {
          isPublic: false,
          expiresAt: null,
          passwordHash: null,
          slug: null,
        })
        await audit({ actor: me, action: 'collection.unpublish', target: c.id })
        return { collection: next }
      }
      // Re-use an existing slug across re-publishes so a previously
      // shared link keeps working — except when the user explicitly
      // wants a fresh URL, which they get by toggling off then on.
      const slug = c.publicSlug ?? nanoid(10)
      const passwordHash = body.password ? await hashPassword(body.password) : null
      const expiresAt =
        typeof body.expiresInSeconds === 'number' && body.expiresInSeconds > 0
          ? Date.now() + body.expiresInSeconds * 1000
          : null
      const next = collections.setPublic(c.id, {
        isPublic: true,
        expiresAt,
        passwordHash,
        slug,
      })
      await audit({
        actor: me,
        action: 'collection.publish',
        target: c.id,
        meta: { expiresAt, hasPassword: !!passwordHash },
      })
      return { collection: next }
    },
  )

  /**
   * Anonymous public-collection read. The slug is part of the URL
   * the user pastes; password is in the `p` query string. Returns a
   * read-only view: collection metadata + items + (no shares).
   */
  app.get<{ Params: { slug: string } }>(
    '/api/public-collections/:slug',
    async (req, reply) => {
      const c = collections.bySlug(req.params.slug)
      if (!c) return reply.code(404).send({ error: 'not found' })
      const { p } = req.query as { p?: string }
      const gate = await collections.publicGate(c, p, verifyPassword)
      if (gate === 'expired') return reply.code(410).send({ error: 'link expired' })
      if (gate === 'password-required' || gate === 'password-wrong') {
        return reply.code(401).send({
          error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
          passwordRequired: true,
        })
      }
      if (gate !== 'ok') return reply.code(404).send({ error: 'not found' })

      const members = collections.listMembers(c.id)
      const items: Array<{
        docId: string
        path: string
        owner: string
        title: string
        mime: string
        bytes: number
        kind: 'image' | 'video' | 'file'
        addedAt: number
      }> = []
      for (const m of members) {
        const meta = await loadMeta(m.docId)
        if (!meta) continue
        const ext = meta.originalFilename.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ''
        const kind: 'image' | 'video' | 'file' =
          /\.(png|jpe?g|webp|gif|avif|bmp|ico|heic|heif|tiff?|jxl)$/.test(ext)
            ? 'image'
            : /\.(mp4|mov|m4v|mkv|webm|avi|3gp|3gpp|mts|m2ts|mpg|mpeg|wmv|flv|ogv)$/.test(ext)
              ? 'video'
              : 'file'
        items.push({
          docId: meta.id,
          path: meta.storageKey,
          owner: meta.owner,
          title: meta.title,
          mime: meta.mime,
          bytes: meta.bytes,
          kind,
          addedAt: m.addedAt,
        })
      }
      // Strip sensitive fields from the response. Anonymous viewers
      // don't see the password hash or the owner's userlist.
      return {
        collection: {
          id: c.id,
          name: c.name,
          description: c.description,
          slug: c.publicSlug,
          public: true,
          publicExpiresAt: c.publicExpiresAt,
          hasPassword: !!c.publicPasswordHash,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
        items,
      }
    },
  )

  /**
   * Anonymous read of a single member's bytes / preview / thumbnail
   * / extracted text. Same gate dance as the listing endpoint, plus
   * a membership check so a public-slug can only serve docs that
   * are actually IN that collection.
   */
  async function gatedMember(
    slug: string,
    docId: string,
    password: string | undefined,
  ): Promise<
    | { ok: true; meta: Awaited<ReturnType<typeof loadMeta>> }
    | { ok: false; status: number; body: Record<string, unknown> }
  > {
    const c = collections.bySlug(slug)
    if (!c) return { ok: false, status: 404, body: { error: 'not found' } }
    const gate = await collections.publicGate(c, password, verifyPassword)
    if (gate === 'expired')
      return { ok: false, status: 410, body: { error: 'link expired' } }
    if (gate === 'password-required' || gate === 'password-wrong') {
      return {
        ok: false,
        status: 401,
        body: {
          error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
          passwordRequired: true,
        },
      }
    }
    if (gate !== 'ok')
      return { ok: false, status: 404, body: { error: 'not found' } }
    const members = collections.listMembers(c.id)
    if (!members.some((m) => m.docId === docId))
      return { ok: false, status: 404, body: { error: 'not in collection' } }
    const meta = await loadMeta(docId)
    if (!meta) return { ok: false, status: 404, body: { error: 'document missing' } }
    return { ok: true, meta }
  }

  app.get<{ Params: { slug: string; docId: string } }>(
    '/api/public-collections/:slug/file/:docId/raw',
    async (req, reply) => {
      const { p } = req.query as { p?: string }
      const r = await gatedMember(req.params.slug, req.params.docId, p)
      if (!r.ok) return reply.code(r.status).send(r.body)
      const meta = r.meta!
      const abs = resolveUserVault(meta.owner, meta.storageKey)
      const s = await stat(abs).catch(() => null)
      if (!s?.isFile()) return reply.code(404).send({ error: 'not found' })
      const mime = meta.mime || 'application/octet-stream'
      const disposition = `inline; filename="${path.basename(abs).replace(/"/g, '')}"`
      // Range support for HTML5 video / audio scrubbing — same shape
      // as the auth'd /api/file/raw handler.
      const range = (req.headers.range || '') as string
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (m) {
        const total = s.size
        const start = m[1] ? Number(m[1]) : 0
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          return reply
            .code(416)
            .header('Content-Range', `bytes */${total}`)
            .send({ error: 'range not satisfiable' })
        }
        return reply
          .code(206)
          .header('Content-Type', mime)
          .header('Content-Length', String(end - start + 1))
          .header('Content-Range', `bytes ${start}-${end}/${total}`)
          .header('Accept-Ranges', 'bytes')
          .header('Content-Disposition', disposition)
          .send(createReadStream(abs, { start, end }))
      }
      return reply
        .header('Content-Type', mime)
        .header('Content-Length', String(s.size))
        .header('Accept-Ranges', 'bytes')
        .header('Content-Disposition', disposition)
        .send(createReadStream(abs))
    },
  )

  app.get<{ Params: { slug: string; docId: string } }>(
    '/api/public-collections/:slug/file/:docId/thumbnail',
    async (req, reply) => {
      const { p } = req.query as { p?: string }
      const r = await gatedMember(req.params.slug, req.params.docId, p)
      if (!r.ok) return reply.code(r.status).send(r.body)
      const buf = await readThumbnail(r.meta!.id)
      if (!buf) return reply.code(404).send({ error: 'no thumbnail' })
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'public, max-age=3600')
        .send(buf)
    },
  )

  app.get<{ Params: { slug: string; docId: string } }>(
    '/api/public-collections/:slug/file/:docId/preview',
    async (req, reply) => {
      const { p } = req.query as { p?: string }
      const r = await gatedMember(req.params.slug, req.params.docId, p)
      if (!r.ok) return reply.code(r.status).send(r.body)
      const buf = await readPreview(r.meta!.id)
      if (buf) {
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'public, max-age=3600')
          .send(buf)
      }
      // No transcoded preview — fall back to raw bytes (browser
      // renders most formats directly).
      const abs = resolveUserVault(r.meta!.owner, r.meta!.storageKey)
      const s = await stat(abs).catch(() => null)
      if (!s?.isFile()) return reply.code(404).send({ error: 'not found' })
      return reply
        .header('Content-Type', r.meta!.mime || 'application/octet-stream')
        .send(createReadStream(abs))
    },
  )

  app.get<{ Params: { slug: string; docId: string } }>(
    '/api/public-collections/:slug/file/:docId/text',
    async (req, reply) => {
      const { p } = req.query as { p?: string }
      const r = await gatedMember(req.params.slug, req.params.docId, p)
      if (!r.ok) return reply.code(r.status).send(r.body)
      const text = await readDocText(r.meta!.id)
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .send(text ?? '')
    },
  )
}
