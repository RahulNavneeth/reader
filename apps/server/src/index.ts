import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { config } from './config.js'
import { ensureDir } from './lib/fs.js'
import { runMigrations } from './db/migrations.js'
import { bootstrapChunksFromDisk, bootstrapDocumentsFromDisk } from './db/bootstrap.js'
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
import { feedRoutes } from './routes/feed.js'
import { timelineRoutes } from './routes/timeline.js'
import { collectionsRoutes } from './routes/collections.js'
import { externalMountsRoutes } from './routes/externalMounts.js'
import { chatRoutes } from './routes/chat.js'
import { aiMemoriesRoutes } from './routes/aiMemories.js'
import { sweepExpired } from './stores/sessions.js'
import { sweepExpiredPublic } from './stores/documents.js'
import { sweepExpiredPublicFolders } from './stores/folderMetas.js'
import { preheat } from './services/search.js'
import { isAvailable as ollamaUp } from './services/embed.js'
import { loadSettings } from './stores/settings.js'
import { startVaultWatcher } from './services/watcher.js'
import { sweepExpiredTrash } from './stores/trash.js'
import { migrateLegacyVault } from './services/migrate.js'
import { createRateLimit } from './lib/rateLimit.js'

export type BuildAppOptions = {
  /** Skip background timers + watchers + Ollama probe. Tests pass true
   *  so the test suite doesn't keep the event loop alive. */
  skipBackground?: boolean
  /** Disable Pino logging — keeps test output clean. */
  silent?: boolean
}

/**
 * Construct (but do not listen on) a fully-wired Fastify instance.
 * Extracted from `main()` so integration tests can call
 * `await app.inject({ method, url, headers, payload })` without
 * binding to a port.
 */
export async function buildApp(opts: BuildAppOptions = {}) {
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

  // SQLite migrations + one-shot import. Runs synchronously inside
  // the boot sequence so the first request hits a populated table
  // and not a half-migrated one. Idempotent across restarts.
  runMigrations()
  await bootstrapDocumentsFromDisk({ silent: !!opts.silent })
  await bootstrapChunksFromDisk({ silent: !!opts.silent })

  const app = Fastify({
    logger: opts.silent
      ? false
      : {
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

  // Sensible default security headers. We don't pull in helmet — the
  // small set we actually need is just a handful of static headers
  // and helmet's defaults turn off too much (no embedded thumbnails,
  // etc.). Admins behind a reverse proxy can override / extend at
  // that layer. CSP is intentionally permissive on script-src because
  // Vite-built bundles include inline JSON state; tightening it
  // requires SRI/hashing the bundle.
  // Single CSP applied to every HTML response. We can't fully lock
  // down script-src because the Vite-built bundle ships inline JSON
  // state; what we CAN do is keep network/font origins on a known
  // allow-list. Tile maps come from OpenStreetMap, fonts from rsms.me
  // (Inter), images can be data: (thumbs) and same-origin. Everything
  // else is rejected.
  const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://rsms.me",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "font-src 'self' https://rsms.me data:",
    "connect-src 'self' https://*.tile.openstreetmap.org",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    // CSP only on HTML responses — JSON/file/SSE responses don't get
    // executed in a document context, so the policy is irrelevant
    // there and the header just wastes bytes.
    const contentType = (reply.getHeader('content-type') as string | undefined) ?? ''
    if (
      contentType.startsWith('text/html') ||
      (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/mcp'))
    ) {
      reply.header('Content-Security-Policy', CSP)
    }
    if (isProdEnv) {
      // 1 year HSTS — only emitted in prod, since dev runs over plain
      // HTTP and an HSTS cookie would lock the admin out of localhost.
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })

  // Public-endpoint rate limit. Capacity 120 / refill 20 per second
  // gives a legitimate user generous headroom (a folder of 100
  // thumbnails loads fine) while choking sustained scrape traffic.
  // Anonymous + authed callers both go through the same bucket —
  // scoped per IP not per session so a token-spammer can't bypass
  // by rotating cookies.
  const publicLimit = createRateLimit({ capacity: 120, refillPerSecond: 20 })
  const PUBLIC_PREFIXES = [
    '/api/list',
    '/api/resolve',
    '/api/file/raw',
    '/api/file/thumbnail',
    '/api/file/preview',
    '/api/file/text',
  ]
  app.addHook('onRequest', async (req, reply) => {
    if (!PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return
    const r = publicLimit.check(req.ip)
    if (!r.allowed) {
      reply
        .code(429)
        .header('Retry-After', String(r.retryAfterSeconds))
        .send({ error: 'too many requests', retryAfter: r.retryAfterSeconds })
    }
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
  await app.register(feedRoutes)
  await app.register(timelineRoutes)
  await app.register(collectionsRoutes)
  await app.register(chatRoutes)
  await app.register(aiMemoriesRoutes)

  // Serve the built web bundle in production (single-container deploy).
  // SPA fallback rewrites unknown paths to index.html so React Router-style
  // deep links still resolve.
  if (config.webDir) {
    const webRoot = path.resolve(config.webDir)
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      // decorateReply MUST be true so the SPA fallback below can
      // call reply.sendFile(). Was false in an earlier rev which
      // crashed every SPA route with `reply.sendFile is not a
      // function`. The minor per-request prototype cost is
      // negligible — every fallback hit needs it.
      decorateReply: true,
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

  if (!opts.skipBackground) {
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
  }

  return app
}

async function main() {
  const app = await buildApp()

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

  // Best-effort backfill of memory embeddings introduced by
  // migration 012. Runs in the background after listen — a stopped
  // Ollama doesn't block boot; we'll retry on next start.
  void (async () => {
    try {
      const { backfillMissingMemoryEmbeddings } = await import('./services/memoryEmbed.js')
      const r = await backfillMissingMemoryEmbeddings()
      if (r.user.attempted > 0 || r.doc.attempted > 0) {
        app.log.info(
          { user: r.user, doc: r.doc },
          'memory embedding backfill complete',
        )
      }
    } catch (err) {
      app.log.warn({ err }, 'memory embedding backfill failed; will retry next boot')
    }
  })()

  // Graceful shutdown. Docker sends SIGTERM with a 10s grace period
  // before SIGKILL; we let Fastify finish in-flight requests (uploads
  // especially) and close the SSE / EventSource connections cleanly.
  // The idempotent flag stops a double-signal (e.g. user mashes Ctrl-C)
  // from racing the close handler.
  let shuttingDown = false
  const stop = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'shutdown failed')
      process.exit(1)
    }
  }
  process.once('SIGTERM', () => void stop('SIGTERM'))
  process.once('SIGINT', () => void stop('SIGINT'))
}

// Only run main() when this file is the process entry point — tests
// import `buildApp` from here and should not also start the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('fatal:', err)
    process.exit(1)
  })
}
