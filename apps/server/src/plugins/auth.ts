import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { config } from '../config.js'
import { getSession, deleteSession } from '../stores/sessions.js'
import { getUser } from '../stores/users.js'
import type { PublicUser, User } from '../types.js'
import { publicUser } from '../stores/users.js'

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    setSessionCookie: (reply: FastifyReply, token: string, ttlMs: number) => void
    clearSessionCookie: (reply: FastifyReply) => void
    publicUser: (u: User) => PublicUser
  }
}

async function plugin(app: FastifyInstance) {
  // Decorate request with currentUser by reading the cookie.
  app.decorateRequest('currentUser', null)

  app.addHook('preHandler', async (req) => {
    const token = req.cookies?.[config.session.cookieName]
    if (!token) {
      req.currentUser = null
      return
    }
    const unsigned = req.unsignCookie(token)
    if (!unsigned.valid || !unsigned.value) {
      req.currentUser = null
      return
    }
    const session = await getSession(unsigned.value)
    if (!session) {
      req.currentUser = null
      return
    }
    const user = await getUser(session.username)
    if (!user || user.disabled) {
      req.currentUser = null
      await deleteSession(unsigned.value)
      return
    }
    req.currentUser = user
  })

  app.decorate('requireUser', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.currentUser) {
      reply.code(401).send({ error: 'authentication required' })
    }
  })

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.currentUser) {
      reply.code(401).send({ error: 'authentication required' })
      return
    }
    if (req.currentUser.role !== 'admin') {
      reply.code(403).send({ error: 'admin only' })
    }
  })

  app.decorate('setSessionCookie', (reply: FastifyReply, token: string, ttlMs: number) => {
    reply.setCookie(config.session.cookieName, token, {
      httpOnly: true,
      secure: config.session.secure,
      sameSite: config.session.sameSite,
      path: '/',
      maxAge: Math.floor(ttlMs / 1000),
      signed: true,
    })
  })

  app.decorate('clearSessionCookie', (reply: FastifyReply) => {
    reply.clearCookie(config.session.cookieName, { path: '/' })
  })

  app.decorate('publicUser', publicUser)
}

export default fp(plugin, { name: 'reader-auth' })
