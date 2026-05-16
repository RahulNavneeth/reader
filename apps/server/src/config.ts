import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const HOME = os.homedir()

/**
 * "Anchor" file outside the data dir. Holds a `dataDir` override so the user
 * can move the entire data location at runtime without breaking the
 * chicken-and-egg of "settings.json lives inside dataDir".
 */
export const ANCHOR_PATH = path.join(HOME, '.reader', 'anchor.json')

function readAnchor(): { dataDir?: string } {
  try {
    return JSON.parse(readFileSync(ANCHOR_PATH, 'utf8')) as { dataDir?: string }
  } catch {
    return {}
  }
}

const anchor = readAnchor()

function expand(p: string): string {
  if (!p) return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2))
  return path.resolve(p)
}

function envStr(key: string, fallback?: string): string {
  const v = process.env[key]
  if (v != null && v !== '') return v
  if (fallback !== undefined) return fallback
  throw new Error(`missing required env var: ${key}`)
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`invalid integer in env var ${key}: ${v}`)
  return n
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v == null || v === '') return fallback
  return v === '1' || v === 'true' || v === 'yes'
}

const dataDir = anchor.dataDir
  ? expand(anchor.dataDir)
  : expand(envStr('DATA_DIR', './data'))
const isProd = process.env.NODE_ENV === 'production'
const sessionSecret = envStr('SESSION_SECRET', '')
if (!sessionSecret || sessionSecret.length < 32) {
  if (isProd) {
    // Refuse to boot in production with a missing/weak signing key —
    // forging session cookies would otherwise be trivial.
    throw new Error(
      '[config] SESSION_SECRET is required (>= 32 chars) in production. Refusing to boot.',
    )
  }
  console.warn(
    '[config] SESSION_SECRET is missing or shorter than 32 chars. ' +
      'Cookies will use a CSPRNG dev secret that resets on every boot — DO NOT use in production.',
  )
}

export const config = {
  dataDir,
  paths: {
    users: path.join(dataDir, 'users'),
    sessions: path.join(dataDir, 'sessions'),
    tokens: path.join(dataDir, 'tokens'),
    invites: path.join(dataDir, 'invites'),
    documents: path.join(dataDir, 'documents'),
    blobs: path.join(dataDir, 'blobs'),
    collections: path.join(dataDir, 'collections'),
    audit: path.join(dataDir, 'audit'),
    settings: path.join(dataDir, 'settings.json'),
    trash: path.join(dataDir, 'trash'),
    shares: path.join(dataDir, 'shares'),
    views: path.join(dataDir, 'views'),
    userShares: path.join(dataDir, 'user-shares'),
    folderMetas: path.join(dataDir, 'folder-metas'),
  },
  storage: {
    /** 'local' = files under data/blobs/. 's3' = S3-compatible (MinIO/R2/AWS). */
    backend: (envStr('STORAGE', 'local') as 'local' | 's3'),
    s3: {
      endpoint: envStr('S3_ENDPOINT', ''),
      bucket: envStr('S3_BUCKET', 'reader'),
      accessKey: envStr('S3_ACCESS_KEY', ''),
      secretKey: envStr('S3_SECRET_KEY', ''),
      region: envStr('S3_REGION', 'us-east-1'),
      forcePathStyle: envBool('S3_FORCE_PATH_STYLE', true),
    },
  },
  ollama: {
    baseUrl: envStr('OLLAMA_BASE_URL', 'http://localhost:11434'),
    embedModel: envStr('OLLAMA_EMBED_MODEL', 'nomic-embed-text'),
    enabled: envBool('OLLAMA_ENABLED', true),
  },
  ingest: {
    chunkChars: envInt('CHUNK_CHARS', 1800),
    chunkOverlap: envInt('CHUNK_OVERLAP', 200),
    maxFileBytes: envInt('MAX_FILE_BYTES', 100 * 1024 * 1024), // 100 MB
  },
  server: {
    host: envStr('SERVER_HOST', '127.0.0.1'),
    port: envInt('SERVER_PORT', 3001),
  },
  /**
   * Canonical public URL the app is served at — used to build links
   * the server emits (webhook payloads, future email templates,
   * MCP responses). Strip the trailing slash so callers can safely
   * `${appUrl}/<path>`. In dev (no APP_URL set) we fall back to the
   * bind host/port; in prod the env var is required and the server
   * refuses to boot without it.
   */
  appUrl: (() => {
    const raw = envStr('APP_URL', '')
    if (raw) return raw.replace(/\/+$/, '')
    if (isProd) {
      throw new Error('[config] APP_URL is required in production. Refusing to boot.')
    }
    const host = envStr('SERVER_HOST', '127.0.0.1')
    const port = envInt('SERVER_PORT', 3001)
    return `http://${host}:${port}`
  })(),
  session: {
    secret: sessionSecret || randomDevSecret(),
    cookieName: 'reader_sid',
    secure: envBool('COOKIE_SECURE', false),
    sameSite: (envStr('COOKIE_SAMESITE', 'lax') as 'lax' | 'strict' | 'none'),
    ttlMs: envInt('SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
  },
  vault: {
    /** The vault is a normal directory on disk. Tree walks it; uploads land in it;
     *  the user can edit it with any tool (Obsidian, Finder, vim). All file paths
     *  exposed by the API are vault-relative ("foo/bar.pdf"); the server resolves
     *  them against this root and refuses anything that escapes via "..". */
    root: expand(envStr('VAULT_ROOT', '~/Documents/Reader-Vault')),
  },
  signup: {
    /** Once any user exists, only invited signups are allowed (M1: invites stub). */
    allowOpen: envBool('ALLOW_OPEN_SIGNUP', false),
  },
  smtp: {
    /** When false, mail is logged to stdout instead of being sent. */
    enabled: envBool('SMTP_ENABLED', false),
    host: envStr('SMTP_HOST', ''),
    port: envInt('SMTP_PORT', 587),
    user: envStr('SMTP_USER', ''),
    pass: envStr('SMTP_PASS', ''),
    from: envStr('SMTP_FROM', 'Reader <noreply@reader.local>'),
    /** true → use TLS from connect (SMTPS, usually port 465). false → STARTTLS upgrade. */
    secure: envBool('SMTP_SECURE', false),
  },
  /** Path to a built web bundle to serve from /. If empty, the server is API-only. */
  webDir: envStr('WEB_DIR', ''),
}

function randomDevSecret(): string {
  // CSPRNG, not Math.random — even in dev, a guessable cookie signing
  // key is a footgun (V8 random state is recoverable from a few
  // outputs). Stable per-process; cookies don't survive restart.
  return 'dev-' + crypto.randomBytes(32).toString('hex')
}

export function expandPath(p: string): string {
  return expand(p)
}
