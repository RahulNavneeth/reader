import type { FastifyInstance } from 'fastify'
import { subscribe, type ReaderEvent } from '../services/events.js'

/**
 * Single Server-Sent Events stream for ingest progress + visibility/tag
 * changes. Clients open `/api/events` (with the session cookie) and re-render
 * affected tiles on each message.
 *
 * Auth is required up front; the publisher itself is global, so the route
 * filters out events the caller can't see by treating it as authenticated-only
 * (we don't surface public-vs-private mutations to anonymous viewers).
 */
export async function eventsRoutes(app: FastifyInstance) {
  app.get('/api/events', async (req, reply) => {
    if (!req.currentUser) {
      return reply.code(401).send({ error: 'auth required' })
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Nginx/Cloudflare buffering for streamed responses.
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(`: connected ${Date.now()}\n\n`)

    // Bail on slow clients — without backpressure handling, a stuck
    // socket buffers in Node's writable stream and a burst (e.g. a
    // folder-cascade firing N visibility events) grows memory
    // unbounded per stuck client. Cap pending bytes ~256 KB; over
    // that, close the connection and let the client reconnect.
    let dropped = false
    const PENDING_LIMIT = 256 * 1024
    const send = (e: ReaderEvent) => {
      if (dropped) return
      try {
        const writable = reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
        const bufLen = (reply.raw as { writableLength?: number }).writableLength ?? 0
        if (!writable && bufLen > PENDING_LIMIT) {
          dropped = true
          try {
            reply.raw.end()
          } catch {
            /* socket already gone */
          }
        }
      } catch {
        dropped = true
      }
    }

    const unsubscribe = subscribe(send)

    // Heartbeat so proxies don't time out idle streams (kept under 30s).
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`)
      } catch {
        clearInterval(heartbeat)
      }
    }, 20_000)

    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
      try {
        reply.raw.end()
      } catch {
        /* already closed */
      }
    }

    req.raw.on('close', cleanup)
    req.raw.on('error', cleanup)
    return reply
  })
}
