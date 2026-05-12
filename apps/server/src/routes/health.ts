import type { FastifyInstance } from 'fastify'
import { userCount } from '../stores/users.js'
import { loadSettings } from '../stores/settings.js'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

  app.get('/api/bootstrap', async () => {
    // Tells the client whether any user exists yet (for the signup-vs-login flow)
    // and whether open sign-ups are currently allowed.
    const [users, settings] = await Promise.all([userCount(), loadSettings()])
    return {
      hasAdmin: users > 0,
      allowOpenSignup: settings.allowOpenSignup,
    }
  })
}
