import type { FastifyInstance } from 'fastify'
import { userCount } from '../stores/users.js'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

  app.get('/api/bootstrap', async () => {
    // Tells the client whether any user exists yet (for the signup-vs-login flow).
    const users = await userCount()
    return { hasAdmin: users > 0 }
  })
}
