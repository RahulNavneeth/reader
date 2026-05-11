import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { ZodError } from 'zod'

async function plugin(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: 'validation failed', issues: err.flatten() })
      return
    }
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode && e.statusCode < 500) {
      reply.code(e.statusCode).send({ error: e.message ?? 'request failed' })
      return
    }
    app.log.error({ err }, 'unhandled error')
    reply.code(500).send({ error: 'internal server error' })
  })

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `not found: ${req.method} ${req.url}` })
  })
}

export default fp(plugin, { name: 'reader-error' })
