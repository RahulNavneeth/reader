// MUST be first import — populates process.env from repo-root .env
// before any other module evaluates (including `config.ts`).
import './loadEnv.js'

import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import formbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import path from 'node:path'
import { config } from './config.js'
import { ensureDir } from './lib/fs.js'
import { runMigrations } from './db/migrations.js'
import { bootstrapChunksFromDisk, bootstrapDocumentsFromDisk } from './db/bootstrap.js'
import authPlugin from './plugins/auth.js'
import errorPlugin from './plugins/error.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { vaultRoutes, serveVaultFileBytes } from './routes/vault.js'
import { searchRoutes } from './routes/search.js'
import { adminRoutes } from './routes/admin.js'
import { mcpRoutes } from './routes/mcp.js'
import { oauthRoutes } from './routes/oauth.js'
import { eventsRoutes } from './routes/events.js'
import { viewsRoutes } from './routes/views.js'
import { templatesRoutes } from './routes/templates.js'
import { syncRoutes } from './routes/sync.js'
import { crdtRoutes } from './routes/crdt.js'
import { intakeRoutes } from './routes/intake.js'
import { userSharesRoutes } from './routes/userShares.js'
import { pinsRoutes } from './routes/pins.js'
import { exportRoutes } from './routes/export.js'
import { memoriesRoutes } from './routes/memories.js'
import { commentsRoutes } from './routes/comments.js'
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
 * Reserved URL prefixes that must NOT be treated as vault paths even
 * when no route matched. These are app/admin/asset namespaces — never
 * vault files. Kept in sync with the React Router's RESERVED list +
 * the API/MCP/OAuth route surface.
 */
const RESERVED_URL_PREFIXES = [
  '/api/',
  '/mcp',
  '/oauth/',
  '/.well-known/',
  '/health',
  '/assets/',
  '/icons/',
  '/sw.js',
  '/manifest.webmanifest',
  '/favicon',
  '/settings',
  '/account/',
  '/trash',
  '/map',
  '/timeline',
  '/collections',
  '/c/',
  '/pc/',
  '/library/',
  '/tags/',
  '/login',
]

/**
 * Attempt to serve a vault file's bytes for the bare-path URL form
 * `GET /<path>`. Returns true if a response was sent.
 *
 *   - Browser navigations (Accept includes text/html) are skipped so
 *     they land on the SPA viewer instead of a raw download.
 *   - Reserved prefixes (API, app routes, static assets) skip too.
 *   - All other GETs are tried as vault paths. Access checks honour
 *     public/shared/owned just like /api/file/raw.
 *
 * Caller (`setNotFoundHandler`) falls back to SPA / 404 when this
 * returns false.
 */
async function tryServeBarePath(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = String(req.headers.accept ?? '')
  if (accept.includes('text/html')) return false
  const url = req.url.split('?')[0]
  if (!url || url === '/') return false
  for (const p of RESERVED_URL_PREFIXES) {
    if (url === p || url.startsWith(p)) return false
  }
  let rel: string
  try {
    rel = decodeURIComponent(url.replace(/^\/+/, ''))
  } catch {
    return false
  }
  // Disallow path traversal up-front; serveVaultFileBytes also guards
  // but a quick reject keeps the per-request audit log cleaner.
  if (!rel || rel.includes('..')) return false
  const q = (req.query as Record<string, string | undefined>) ?? {}
  const publicPassword = typeof q.p === 'string' ? q.p : undefined
  const ownerHint = typeof q.owner === 'string' ? q.owner : undefined
  // Transitive embed-grant params — when a markdown viewer renders
  // an inline asset, it appends `?via=<parent>&viaOwner=<owner>` so
  // the server grants this read because the user can read the
  // parent doc embedding it. Standalone URLs (no `via`) keep the
  // asset's normal ACL behaviour.
  const viaRel = typeof q.via === 'string' ? q.via : undefined
  const viaOwner = typeof q.viaOwner === 'string' ? q.viaOwner : undefined
  try {
    await serveVaultFileBytes(req.server, req, reply, {
      rel,
      publicPassword,
      ownerHint,
      viaRel,
      viaOwner,
    })
  } catch {
    // The helper may have started setting headers before throwing.
    // Either way we treat as "did not produce a usable response" and
    // let the caller decide what to do.
    return reply.sent
  }
  return true
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

  // application/x-www-form-urlencoded body parser. Required for the
  // OAuth /token endpoint (RFC 6749 §3.2 mandates form-encoded), and
  // the only reason real MCP clients (Claude Code, Cursor, Inspector)
  // can complete the OAuth flow at all — without this plugin, Fastify
  // returns 415 Unsupported Media Type before our handler even sees
  // the request, which is why integration tests passing JSON didn't
  // surface this gap.
  await app.register(formbody)

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
  // Looser variant for file-byte responses — PDFs in particular need
  // to be embeddable in Reader's own document viewer. Keep everything
  // else locked down; only `frame-ancestors` is broadened.
  const CSP_FILE = CSP.replace(
    "frame-ancestors 'none'",
    "frame-ancestors 'self'",
  )

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    // Frame policy. The SPA shell stays DENY (so external sites can't
    // iframe Reader). File-byte responses — PDFs especially — need to
    // be framable by Reader's own document viewer, so they get
    // SAMEORIGIN. Without this, the production iframe just shows
    // "refused to connect" the moment the PDF viewer tries to mount.
    const contentType = (reply.getHeader('content-type') as string | undefined) ?? ''
    const isHtml = contentType.startsWith('text/html')
    // File-byte routes: both the bare vault path (`/foo.pdf`) AND
    // the explicit `/api/file/raw` endpoint, plus the thumbnail /
    // preview helpers. All of these stream bytes that the SPA's
    // iframe / <img> / <video> tags need to mount.
    const isFileByteRoute =
      req.method === 'GET' &&
      (req.url.startsWith('/api/file/raw') ||
        req.url.startsWith('/api/file/thumbnail') ||
        req.url.startsWith('/api/file/preview') ||
        (!req.url.startsWith('/api') && !req.url.startsWith('/mcp')))
    if (isFileByteRoute && !isHtml) {
      reply.header('X-Frame-Options', 'SAMEORIGIN')
    } else {
      reply.header('X-Frame-Options', 'DENY')
    }
    // CSP only on HTML responses — JSON/file/SSE responses don't get
    // executed in a document context, so the policy is irrelevant
    // there and the header just wastes bytes. File-byte responses
    // get the looser variant so the SPA's iframe can mount them.
    if (isHtml) {
      reply.header('Content-Security-Policy', CSP)
    } else if (isFileByteRoute) {
      reply.header('Content-Security-Policy', CSP_FILE)
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

  // WebSocket transport for the CRDT relay. Registered AFTER
  // authPlugin so the route's req.currentUser is populated by the
  // session-cookie onRequest hook. `maxPayload` caps a runaway
  // peer dumping huge updates; the actual Y.Doc updates we see in
  // practice are <1KB.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1 * 1024 * 1024 },
  })

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(vaultRoutes)
  await app.register(searchRoutes)
  await app.register(adminRoutes)
  await app.register(mcpRoutes)
  await app.register(oauthRoutes)
  await app.register(eventsRoutes)
  await app.register(viewsRoutes)
  await app.register(userSharesRoutes)
  await app.register(pinsRoutes)
  await app.register(exportRoutes)
  await app.register(memoriesRoutes)
  await app.register(commentsRoutes)
  await app.register(externalMountsRoutes)
  await app.register(accountRoutes)
  await app.register(feedRoutes)
  await app.register(timelineRoutes)
  await app.register(collectionsRoutes)
  await app.register(chatRoutes)
  await app.register(aiMemoriesRoutes)
  await app.register(templatesRoutes)
  await app.register(syncRoutes)
  await app.register(crdtRoutes)
  await app.register(intakeRoutes)

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
      // Try byte-serve for non-browser GETs on bare vault paths so
      // agents (curl, MCP, etc.) can fetch the file directly from its
      // human-readable URL instead of /api/file/raw?path=…. Browsers
      // navigating to the same URL still get the SPA viewer.
      if (await tryServeBarePath(req, reply)) return
      return reply.sendFile('index.html', webRoot)
    })
    app.log.info({ webDir: webRoot }, 'serving web bundle')
  } else {
    // API-only build: plain JSON 404 for unmatched routes. Still try
    // the bare-path byte-serve first so dev callers (e.g. cloudflared
    // → :3001) can fetch vault files by their bare URL.
    app.setNotFoundHandler(async (req, reply) => {
      if (await tryServeBarePath(req, reply)) return
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

    // Orphan-doc sweep — drop SQLite rows that no longer have a
    // matching file on disk. Historically the web UI's DELETE path
    // moved files to trash without dropping the index row, so search
    // / list_documents / chat-agent retrieval kept returning ghosts.
    // The DELETE path is now fixed (drops the row inline) but we
    // still run this at boot to clean up rows left from the buggy
    // era. Hourly to also catch anything that slips past the inline
    // cleanup (e.g. a future code path that bypasses it).
    const runOrphanDocsSweep = async () => {
      try {
        const { pruneOrphanedDocs } = await import('./stores/documents.js')
        const n = await pruneOrphanedDocs()
        if (n > 0) app.log.info({ removed: n }, 'orphan-doc sweep')
      } catch (err) {
        app.log.warn({ err }, 'orphan-doc sweep failed')
      }
    }
    runOrphanDocsSweep()
    setInterval(runOrphanDocsSweep, 60 * 60 * 1000).unref()

    // Audit log retention — drop shards older than 180 days so the
    // audit dir doesn't grow unboundedly on long-running deployments.
    // 180d is generous for forensic look-back without being a real
    // disk-usage concern (a typical day is well under a MB).
    const runAuditSweep = async () => {
      try {
        const { pruneAuditOlderThan } = await import('./stores/audit.js')
        const n = await pruneAuditOlderThan(180)
        if (n > 0) app.log.info({ shards: n }, 'audit retention sweep')
      } catch (err) {
        app.log.warn({ err }, 'audit retention sweep failed')
      }
    }
    runAuditSweep()
    setInterval(runAuditSweep, 24 * 60 * 60 * 1000).unref()

    // OAuth client GC — DCR is open by policy so any third-party app
    // can register; without this, the oauth_clients table grows
    // forever. We delete clients that:
    //   - were registered >30 days ago, AND
    //   - have zero live access tokens, AND
    //   - have zero live refresh tokens.
    // FK cascades take care of orphan codes/tokens just in case.
    const runOauthClientGc = async () => {
      try {
        const { pruneStaleClients } = await import('./db/oauthRepo.js')
        const n = pruneStaleClients(30 * 24 * 60 * 60 * 1000)
        if (n > 0) app.log.info({ clients: n }, 'oauth client gc')
      } catch (err) {
        app.log.warn({ err }, 'oauth client gc failed')
      }
    }
    runOauthClientGc()
    setInterval(runOauthClientGc, 24 * 60 * 60 * 1000).unref()

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

    // Scheduled-backup timer. No-op when admin hasn't enabled it; the
    // scheduler logs "idle" in that case. Reapplied whenever the admin
    // PATCH /api/admin/settings changes the backup block.
    const { startBackupScheduler } = await import('./services/backupScheduler.js')
    await startBackupScheduler(app.log).catch((err) =>
      app.log.warn({ err }, 'backup scheduler start failed'),
    )

    // Template scheduler — walks each user's _templates/, parses
    // frontmatter, and auto-instantiates any template with a
    // `schedule:` cron expression whose next fire has landed. No
    // settings — source of truth is the template's own frontmatter.
    const { startTemplateScheduler } = await import(
      './services/templateScheduler.js'
    )
    startTemplateScheduler(app.log)
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
      // Force a synchronous persist of every Y.Doc with pending
      // updates — otherwise the 2s persist debounce can swallow
      // the last batch of edits on a graceful restart.
      const { flushAll } = await import('./services/crdtRegistry.js')
      flushAll()
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
