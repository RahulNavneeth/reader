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
import type { FastifyInstance } from 'fastify'
import { audit } from '../stores/audit.js'
import { loadMeta } from '../stores/documents.js'
import * as collections from '../db/collectionsRepo.js'

export async function collectionsRoutes(app: FastifyInstance) {
  app.get('/api/collections', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const me = req.currentUser.username
    const mine = collections.listByOwner(me).map((c) => ({
      ...c,
      role: 'owner' as const,
      memberCount: collections.memberCount(c.id),
    }))
    const shared = collections.listSharedTo(me).map((c) => ({
      ...c,
      role: (c.canEdit ? 'editor' : 'viewer') as 'editor' | 'viewer',
      memberCount: collections.memberCount(c.id),
    }))
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
      return {
        collection: { ...c, role: canEdit ? (c.owner === me ? 'owner' : 'editor') : 'viewer' },
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
      const body = req.body as { docIds?: string[] }
      const docIds = Array.isArray(body?.docIds) ? body!.docIds : []
      if (docIds.length === 0) return reply.code(400).send({ error: 'docIds required' })

      // Only add docs the caller can actually read — otherwise an
      // attacker could probe what doc IDs exist by membership errors.
      const { userCanRead } = await import('../stores/documents.js')
      const added: string[] = []
      const skipped: Array<{ docId: string; reason: string }> = []
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
}
