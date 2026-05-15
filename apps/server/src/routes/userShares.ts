import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import {
  createUserShare,
  deleteUserShare,
  getUserShare,
  listSharesFrom,
  listSharesTo,
} from '../stores/userShares.js'
import { getUser } from '../stores/users.js'
import { listAllDocuments } from '../stores/documents.js'
import { userVaultRoot } from '../lib/userVault.js'
import { audit } from '../stores/audit.js'

/**
 * User-to-user share endpoints.
 *
 *   POST   /api/file/share-with        — owner shares one path with one recipient
 *   GET    /api/file/shares-from       — shares the caller has created
 *   GET    /api/file/shares-to         — shares the caller has received
 *   DELETE /api/file/share-with/:id    — owner (or recipient) revokes
 *
 * Folders cascade (subtree share). Read-only by default; canEdit grants
 * write access inside the shared folder.
 */
export async function userSharesRoutes(app: FastifyInstance) {
  app.post('/api/file/share-with', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const owner = req.currentUser
    const body = req.body as {
      path?: string
      recipient?: string
      canEdit?: boolean
      label?: string
    }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })
    if (!body?.recipient) return reply.code(400).send({ error: 'missing recipient' })
    if (body.recipient === owner.username) {
      return reply.code(400).send({ error: 'cannot share with yourself' })
    }
    const recipient = await getUser(body.recipient)
    if (!recipient) return reply.code(404).send({ error: 'unknown recipient' })

    // The path must exist under the owner's namespace; figure out whether
    // it's a file or directory so cascade rules apply correctly.
    const abs = path.join(userVaultRoot(owner.username), body.path)
    const st = await stat(abs).catch(() => null)
    if (!st) return reply.code(404).send({ error: 'path not found in your vault' })
    const isFolder = st.isDirectory()

    const share = await createUserShare({
      owner: owner.username,
      recipient: recipient.username,
      storageKey: body.path,
      isFolder,
      canEdit: !!body.canEdit,
      label: body.label,
    })
    await audit({
      actor: owner.username,
      action: 'vault.share-with',
      target: body.path,
      meta: { recipient: recipient.username, canEdit: share.canEdit, isFolder },
    })
    return reply.code(201).send({ share })
  })

  app.get('/api/file/shares-from', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const shares = await listSharesFrom(req.currentUser.username)
    return { shares }
  })

  app.get('/api/file/shares-to', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const shares = await listSharesTo(req.currentUser.username)
    // Decorate with the basename so the UI doesn't need to parse paths.
    const docs = await listAllDocuments()
    const decorated = shares.map((s) => {
      const doc = docs.find((d) => d.owner === s.owner && d.storageKey === s.storageKey)
      return {
        ...s,
        name: path.basename(s.storageKey),
        ext: path.extname(s.storageKey).toLowerCase(),
        docId: doc?.id,
      }
    })
    return { shares: decorated }
  })

  app.delete('/api/file/share-with/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    const { id } = req.params as { id: string }
    const share = await getUserShare(id)
    if (!share) return reply.code(404).send({ error: 'not found' })
    if (share.owner !== user.username && share.recipient !== user.username && user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await deleteUserShare(id)
    await audit({
      actor: user.username,
      action: 'vault.share-revoke',
      target: share.storageKey,
      meta: { recipient: share.recipient, owner: share.owner },
    })
    return { ok: true }
  })
}
