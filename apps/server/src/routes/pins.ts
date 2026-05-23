import type { FastifyInstance } from 'fastify'
import { stat } from 'node:fs/promises'
import { resolveUserVault } from '../lib/userVault.js'
import { addPin, listPins, removePin } from '../stores/pins.js'
import { findShareForPath } from '../stores/userShares.js'
import { audit } from '../stores/audit.js'

/**
 * Per-user pin endpoints. Pins are user-owned bookmarks — a pin on a
 * path the user can read (own vault or share grant) shows up in the
 * sidebar. We don't validate at pin-time only — the listing endpoint
 * also drops pins whose target has disappeared (file/folder deleted,
 * share revoked) so the UI never shows zombie rows.
 */
export async function pinsRoutes(app: FastifyInstance) {
  app.get('/api/pins', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser.username
    const pins = await listPins(user)
    // Drop pins whose target no longer exists or whose share grant
    // was revoked. We do this lazily on read so the user gets a
    // self-healing list without a background sweep.
    const live: typeof pins = []
    for (const p of pins) {
      // Validate access:
      // - own pin: must still exist on disk
      // - foreign pin: must still have a share grant covering it
      let ok = false
      if (p.owner === user) {
        try {
          const abs = resolveUserVault(p.owner, p.storageKey)
          await stat(abs)
          ok = true
        } catch {
          /* gone */
        }
      } else {
        const grant = await findShareForPath(user, p.owner, p.storageKey)
        if (grant) {
          try {
            const abs = resolveUserVault(p.owner, p.storageKey)
            await stat(abs)
            ok = true
          } catch {
            /* gone */
          }
        }
      }
      if (ok) live.push(p)
    }
    if (live.length !== pins.length) {
      // Persist the cleanup so subsequent reads are O(1) in dead
      // entries. Each auto-pruned pin is audited with actor:'system'
      // + reason:'target-missing' so the owner can trace why a
      // sidebar pin vanished (file deleted, share revoked, etc).
      for (const p of pins) {
        if (!live.find((q) => q.owner === p.owner && q.storageKey === p.storageKey)) {
          await removePin(user, p.owner, p.storageKey)
          await audit({
            actor: 'system',
            action: 'pin.remove',
            target: p.storageKey,
            meta: {
              owner: p.owner,
              pinnedBy: user,
              source: 'auto-cleanup',
              reason: 'target-missing',
            },
          }).catch(() => { /* don't break listing on audit failure */ })
        }
      }
    }
    return { pins: live }
  })

  app.post('/api/pins', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    const body = req.body as {
      path?: string
      owner?: string
      isFolder?: boolean
      label?: string
    }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })
    const owner = (body.owner ?? user.username).trim()
    const storageKey = body.path.replace(/^\/+|\/+$/g, '')

    // Authorization: can the caller actually access this target?
    if (owner !== user.username) {
      const grant = await findShareForPath(user.username, owner, storageKey)
      if (!grant) return reply.code(403).send({ error: 'no access' })
    }
    // Existence check (resolveUserVault also blocks traversal).
    let abs: string
    try {
      abs = resolveUserVault(owner, storageKey)
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'invalid path' })
    }
    let isFolder = !!body.isFolder
    try {
      const s = await stat(abs)
      isFolder = s.isDirectory()
    } catch {
      return reply.code(404).send({ error: 'target not found' })
    }
    const pins = await addPin(user.username, {
      owner,
      storageKey,
      isFolder,
      label: body.label?.trim() || undefined,
    })
    await audit({
      actor: user.username,
      action: 'pin.add',
      target: storageKey,
      meta: { owner, isFolder, label: body.label?.trim() || undefined },
    })
    return { pins }
  })

  app.delete('/api/pins', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const body = req.body as { path?: string; owner?: string }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })
    const owner = (body.owner ?? req.currentUser.username).trim()
    const storageKey = body.path.replace(/^\/+|\/+$/g, '')
    const pins = await removePin(req.currentUser.username, owner, storageKey)
    await audit({
      actor: req.currentUser.username,
      action: 'pin.remove',
      target: storageKey,
      meta: { owner },
    })
    return { pins }
  })
}
