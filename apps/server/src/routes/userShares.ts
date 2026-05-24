import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import {
  createUserShare,
  deleteUserShare,
  getUserShare,
  listSharesFrom,
  listSharesTo,
} from '../stores/userShares.js'
import { getUser } from '../stores/users.js'
import { listAllDocuments } from '../stores/documents.js'
import { resolveUserVault, userVaultRoot } from '../lib/userVault.js'
import { audit } from '../stores/audit.js'
import { dispatch as dispatchWebhook } from '../services/webhooks.js'

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
    // Viewer accounts are read-only by policy; minting share grants is a
    // mutation (creates an ACL record + audit trail + cascade writes).
    if (owner.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
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
    if (recipient.disabled) return reply.code(400).send({ error: 'recipient disabled' })

    // Normalize + harden the share path through resolveUserVault — without
    // this, a raw `path.join` accepts `..` segments and lets the caller
    // forge a share record pointing into another user's vault (which then
    // leaks structure via /api/files/search's shared-folder walk).
    let abs: string
    let normalizedPath: string
    try {
      abs = resolveUserVault(owner.username, body.path)
      // Re-derive the canonical relative form so the saved storageKey
      // doesn't carry trailing slashes or redundant segments.
      const rootLen = userVaultRoot(owner.username).length
      normalizedPath = abs.slice(rootLen + 1)
    } catch {
      return reply.code(400).send({ error: 'invalid path' })
    }
    const st = await stat(abs).catch(() => null)
    if (!st) return reply.code(404).send({ error: 'path not found in your vault' })
    const isFolder = st.isDirectory()

    const share = await createUserShare({
      owner: owner.username,
      recipient: recipient.username,
      storageKey: normalizedPath,
      isFolder,
      canEdit: !!body.canEdit,
      label: body.label,
    })
    // The recipient's search cache should now include this path —
    // their visibility just changed. Cheap full flush is fine; the
    // alternative (per-user cache eviction) adds complexity for no
    // material throughput win on typical share volumes.
    const { invalidateSearchCache } = await import('../services/search.js')
    invalidateSearchCache()
    await audit({
      actor: owner.username,
      action: 'vault.share-with',
      target: normalizedPath,
      meta: { recipient: recipient.username, canEdit: share.canEdit, isFolder },
    })
    dispatchWebhook({
      type: 'share',
      path: normalizedPath,
      actor: owner.username,
      shareId: share.id,
      recipient: recipient.username,
      canEdit: share.canEdit,
      isFolder,
      revoked: false,
    }).catch(() => null)
    // When a folder is shared, also write an audit entry for every
    // descendant file and sub-folder so each item's activity log shows
    // it became accessible via the cascade. Mirrors the public-cascade
    // audit behavior.
    if (isFolder) {
      const ownerRoot = userVaultRoot(owner.username)
      const folderAbs = abs
      try {
        const walk = async (curAbs: string, curRel: string): Promise<void> => {
          let entries: import('node:fs').Dirent[]
          try {
            entries = await readdir(curAbs, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue
            if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
            const childAbs = path.join(curAbs, e.name)
            const childRel = curRel ? `${curRel}/${e.name}` : e.name
            const fullRel = normalizedPath
              ? `${normalizedPath.replace(/\/+$/, '')}/${childRel}`
              : childRel
            await audit({
              actor: owner.username,
              action: e.isDirectory() ? 'vault.share-with-folder' : 'vault.share-with-file',
              target: fullRel,
              meta: {
                recipient: recipient.username,
                canEdit: share.canEdit,
                cascadedFrom: normalizedPath,
              },
            })
            if (e.isDirectory()) await walk(childAbs, childRel)
          }
        }
        await walk(folderAbs, '')
        void ownerRoot // silence unused
      } catch {
        /* best-effort; cascade audit isn't worth failing the share over */
      }
    }
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
        // Embedded flag so the recipient's sidebar sparkle shows on a
        // file share without needing a second fetch.
        embedded: doc?.ingest?.embedded ?? false,
        public: !!doc?.public,
      }
    })
    return { shares: decorated }
  })

  app.delete('/api/file/share-with/:id', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { id } = req.params as { id: string }
    const share = await getUserShare(id)
    if (!share) return reply.code(404).send({ error: 'not found' })
    if (share.owner !== user.username && share.recipient !== user.username && user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await deleteUserShare(id)
    // Recipient just lost visibility on this path — flush the
    // search cache so a subsequent query doesn't keep returning
    // it. Mirrors the grant path above.
    const { invalidateSearchCache } = await import('../services/search.js')
    invalidateSearchCache()
    await audit({
      actor: user.username,
      action: 'vault.share-revoke',
      target: share.storageKey,
      meta: { recipient: share.recipient, owner: share.owner },
    })
    // Always fire as the share's OWNER so per-user webhook
    // subscriptions stay tied to the file's owner regardless of who
    // clicked Revoke (owner, recipient, or admin can all revoke).
    dispatchWebhook({
      type: 'share',
      path: share.storageKey,
      actor: share.owner,
      shareId: share.id,
      recipient: share.recipient,
      canEdit: share.canEdit,
      isFolder: share.isFolder,
      revoked: true,
    }).catch(() => null)
    return { ok: true }
  })
}
