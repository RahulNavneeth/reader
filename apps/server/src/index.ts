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
import { viewsRoutes } from './routes/views.js'
import { userSharesRoutes } from './routes/userShares.js'
import { pinsRoutes } from './routes/pins.js'
import { exportRoutes } from './routes/export.js'
import { memoriesRoutes } from './routes/memories.js'
import { accountRoutes } from './routes/account.js'
import { externalMountsRoutes } from './routes/externalMounts.js'
import { sweepExpired } from './stores/sessions.js'
import { sweepExpiredPublic } from './stores/documents.js'
import { sweepExpiredPublicFolders } from './stores/folderMetas.js'
import { preheat } from './services/search.js'
import { isAvailable as ollamaUp } from './services/embed.js'
import { loadSettings } from './stores/settings.js'
import { startVaultWatcher } from './services/watcher.js'
import { sweepExpiredTrash } from './stores/trash.js'
import { migrateLegacyVault } from './services/migrate.js'

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

  // CORS — in production, only the configured origin(s) are allowed
  // with credentials. ALLOWED_ORIGINS is a comma-separated list. In
  // dev (NODE_ENV != production), any localhost / 127.0.0.1 origin is
  // accepted so the Vite dev server on whatever port works.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const isProdEnv = process.env.NODE_ENV === 'production'
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      if (allowedOrigins.includes(origin)) return cb(null, true)
      if (!isProdEnv && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return cb(null, true)
      }
      cb(null, false)
    },
    credentials: true,
  })

  // CSRF guard for cookie-authed state-changing requests. Browsers
  // attach the session cookie to any cross-site POST by default; if
  // we trust them blindly, attacker.com can submit /api/file/bulk-
  // delete on the user's behalf. Strategy: every mutating request
  // must either (a) be same-origin (Origin header matches Host) or
  // (b) come with `X-Requested-With: fetch` which non-Reader sites
  // can't set without a CORS preflight (and our CORS allowlist
  // already blocks unknown origins).
  app.addHook('preHandler', async (req, reply) => {
    const method = req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
    // SSE / health / public unauthenticated endpoints don't need a
    // cookie, so they aren't CSRF targets. The check only kicks in
    // for cookie-bearing requests.
    if (!req.cookies?.[config.session.cookieName]) return
    const origin = (req.headers.origin as string | undefined) ?? ''
    const host = (req.headers.host as string | undefined) ?? ''
    const xrw = (req.headers['x-requested-with'] as string | undefined) ?? ''
    // Same-origin check: extract host from Origin and compare.
    let originHost = ''
    try {
      if (origin) originHost = new URL(origin).host
    } catch {
      /* malformed Origin → fall through, will fail check */
    }
    const sameOrigin = !!origin && originHost === host
    const hasXrw = xrw.toLowerCase() === 'fetch' || xrw.toLowerCase() === 'xmlhttprequest'
    if (!sameOrigin && !hasXrw) {
      reply.code(403).send({ error: 'csrf check failed; missing Origin or X-Requested-With' })
    }
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
  await app.register(viewsRoutes)
  await app.register(userSharesRoutes)
  await app.register(pinsRoutes)
  await app.register(exportRoutes)
  await app.register(memoriesRoutes)
  await app.register(externalMountsRoutes)
  await app.register(accountRoutes)

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

  // Best-effort: drop expired sessions on boot, then re-run hourly so
  // orphaned files don't accumulate between restarts. (Used to only
  // run at boot; long-running deployments leaked stale tokens on
  // disk.)
  const runSessionSweep = () =>
    sweepExpired()
      .then((n) => n > 0 && app.log.info({ removed: n }, 'session sweep'))
      .catch((err) => app.log.warn({ err }, 'session sweep failed'))
  runSessionSweep()
  setInterval(runSessionSweep, 60 * 60 * 1000).unref()

  // Purge trash older than the 30-day retention. Same pattern — hourly.
  const runTrashSweep = () =>
    sweepExpiredTrash()
      .then((n) => n > 0 && app.log.info({ purged: n }, 'trash sweep'))
      .catch((err) => app.log.warn({ err }, 'trash sweep failed'))
  runTrashSweep()
  setInterval(runTrashSweep, 60 * 60 * 1000).unref()

  // Auto-flip expired public links to private — file metas + folder
  // metas both. Runs at boot and every minute so an owner who looks
  // at a file just past its expiry sees it as private within a
  // minute, not hours.
  const runPublicExpirySweep = async () => {
    try {
      const files = await sweepExpiredPublic()
      const folders = await sweepExpiredPublicFolders()
      if (files + folders > 0) {
        app.log.info({ files, folders }, 'public-expiry sweep flipped to private')
      }
    } catch (err) {
      app.log.warn({ err }, 'public-expiry sweep failed')
    }
  }
  runPublicExpirySweep()
  setInterval(runPublicExpirySweep, 60 * 1000).unref()

  // Warm the search cache; check Ollama presence (just informational).
  preheat().catch(() => null)
  ollamaUp()
    .then((up) => app.log.info({ ollama: up ? 'reachable' : 'down', model: config.ollama.embedModel }, 'embed backend'))
    .catch(() => null)

  // Migrate the legacy single-vault layout into per-user namespaces. Idempotent
  // (drops a marker after the first run) so subsequent boots are no-ops.
  await migrateLegacyVault(app.log).catch((err) =>
    app.log.warn({ err }, 'vault migration failed'),
  )

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
