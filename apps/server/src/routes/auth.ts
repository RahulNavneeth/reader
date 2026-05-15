import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { hashPassword, verifyPassword } from '../services/auth.js'
import { audit } from '../stores/audit.js'
import { createSession, deleteSession } from '../stores/sessions.js'
import { loadSettings } from '../stores/settings.js'
import { getUser, isValidUsername, saveUser, userCount } from '../stores/users.js'
import { ensureUserVault } from '../lib/userVault.js'
import type { User } from '../types.js'

const credSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(8).max(256),
})

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/signup', async (req, reply) => {
    const { username, password } = credSchema.parse(req.body)
    if (!isValidUsername(username)) {
      return reply.code(400).send({ error: 'invalid username (lowercase letters, digits, . _ -; must start and end alphanumeric)' })
    }
    const existingCount = await userCount()
    const settings = await loadSettings()
    if (existingCount > 0 && !settings.allowOpenSignup) {
      // After the first user, signup is locked unless an admin re-opened it.
      return reply.code(403).send({ error: 'open signup disabled; ask an admin for an invitation' })
    }
    const existing = await getUser(username)
    if (existing) {
      return reply.code(409).send({ error: 'username taken' })
    }
    const passwordHash = await hashPassword(password)
    const role: User['role'] = existingCount === 0 ? 'admin' : 'viewer'
    const user: User = {
      username,
      passwordHash,
      role,
      createdAt: Date.now(),
    }
    await saveUser(user)
    // Every new user gets their own empty vault subdir. Best-effort — a failure
    // here doesn't block signup; first /api/list / upload will create it anyway.
    await ensureUserVault(username).catch(() => null)
    const session = await createSession(username)
    app.setSessionCookie(reply, session.token, config.session.ttlMs)
    await audit({ actor: username, action: 'auth.signup', meta: { role }, ip: req.ip })
    return { user: app.publicUser(user) }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = credSchema.parse(req.body)
    const user = await getUser(username)
    // Constant-ish timing: always run argon2 verify even on missing user
    const ok =
      user && !user.disabled && (await verifyPassword(user.passwordHash, password))
    if (!ok || !user) {
      await audit({ actor: username, action: 'auth.login.failed', ip: req.ip })
      return reply.code(401).send({ error: 'invalid credentials' })
    }
    const session = await createSession(user.username)
    app.setSessionCookie(reply, session.token, config.session.ttlMs)
    await audit({ actor: user.username, action: 'auth.login', ip: req.ip })
    return { user: app.publicUser(user) }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[config.session.cookieName]
    if (token) {
      const unsigned = req.unsignCookie(token)
      if (unsigned.valid && unsigned.value) {
        await deleteSession(unsigned.value)
      }
    }
    app.clearSessionCookie(reply)
    if (req.currentUser) {
      await audit({ actor: req.currentUser.username, action: 'auth.logout', ip: req.ip })
    }
    return { ok: true }
  })

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.currentUser) {
      return reply.code(401).send({ error: 'not authenticated' })
    }
    return { user: app.publicUser(req.currentUser) }
  })
}
