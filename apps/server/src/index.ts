import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { config } from './config.js'
import { ensureDir } from './lib/fs.js'
import authPlugin from './plugins/auth.js'
import errorPlugin from './plugins/error.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { vaultRoutes } from './routes/vault.js'
import { searchRoutes } from './routes/search.js'
import { adminRoutes } from './routes/admin.js'
import { mcpRoutes } from './routes/mcp.js'
import { eventsRoutes } from './routes/events.js'
import { sweepExpired } from './stores/sessions.js'
import { preheat } from './services/search.js'
import { isAvailable as ollamaUp } from './services/embed.js'
import { loadSettings } from './stores/settings.js'
import { startVaultWatcher } from './services/watcher.js'
import { sweepExpiredTrash } from './stores/trash.js'

async function main() {
  // Make sure all data subdirs exist before any store touches them.
  for (const p of Object.values(config.paths)) {
    if (p.endsWith('.json')) continue
    await ensureDir(p)
  }
  // Load persisted workspace settings — applies any vaultRoot override before
  // the vault folder is touched.
  await loadSettings()
  // The vault is the user's actual content folder; auto-create on first boot.
  await ensureDir(config.vault.root)

  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          singleLine: true,
        },
      },
    },
    trustProxy: true,
  })

  await app.register(errorPlugin)

  await app.register(cookie, {
    secret: config.session.secret,
    parseOptions: {},
  })

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      // Allow any localhost origin in dev; production should set CORS via reverse proxy.
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return cb(null, true)
      }
      cb(null, false)
    },
    credentials: true,
  })

  await app.register(multipart, {
    limits: {
      fileSize: config.ingest.maxFileBytes,
      files: 4,
    },
    attachFieldsToBody: false,
  })

  await app.register(authPlugin)

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(vaultRoutes)
  await app.register(searchRoutes)
  await app.register(adminRoutes)
  await app.register(mcpRoutes)
  await app.register(eventsRoutes)

  // Serve the built web bundle in production (single-container deploy).
  // SPA fallback rewrites unknown paths to index.html so React Router-style
  // deep links still resolve.
  if (config.webDir) {
    const webRoot = path.resolve(config.webDir)
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
    })
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/mcp') || req.url === '/health') {
        return reply.code(404).send({ error: `not found: ${req.method} ${req.url}` })
      }
      return reply.sendFile('index.html', webRoot)
    })
    app.log.info({ webDir: webRoot }, 'serving web bundle')
  } else {
    // API-only build: plain JSON 404 for unmatched routes.
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: `not found: ${req.method} ${req.url}` })
    })
  }

  // Best-effort: drop expired sessions on boot.
  sweepExpired()
    .then((n) => n > 0 && app.log.info({ removed: n }, 'session sweep'))
    .catch((err) => app.log.warn({ err }, 'session sweep failed'))

  // Purge trash older than the 30-day retention.
  sweepExpiredTrash()
    .then((n) => n > 0 && app.log.info({ purged: n }, 'trash sweep'))
    .catch((err) => app.log.warn({ err }, 'trash sweep failed'))

  // Warm the search cache; check Ollama presence (just informational).
  preheat().catch(() => null)
  ollamaUp()
    .then((up) => app.log.info({ ollama: up ? 'reachable' : 'down', model: config.ollama.embedModel }, 'embed backend'))
    .catch(() => null)

  // Watch the vault for external edits (Obsidian, vim, Finder) and re-ingest.
  startVaultWatcher(app.log).catch((err) => app.log.warn({ err }, 'vault watcher start failed'))

  try {
    await app.listen({ host: config.server.host, port: config.server.port })
    app.log.info(
      { dataDir: config.dataDir, vault: config.vault.root },
      'reader server ready',
    )
  } catch (err) {
    app.log.error({ err }, 'failed to start')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
