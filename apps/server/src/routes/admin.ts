import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../stores/audit.js'
import { listUsers, getUser, saveUser, publicUser } from '../stores/users.js'
import { createToken, deleteToken, listTokens } from '../stores/tokens.js'
import type { Role } from '../types.js'

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
      })
      .parse(req.body)
    const next = { ...u, role: (body.role ?? u.role) as Role, disabled: body.disabled ?? u.disabled }
    await saveUser(next)
    await audit({ actor: req.currentUser!.username, action: 'admin.user.patch', target: username, meta: body })
    return { user: publicUser(next) }
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
}
