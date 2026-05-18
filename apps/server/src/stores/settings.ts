import { readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

/**
 * Runtime workspace settings — persisted to `data/settings.json` and applied
 * on top of env-derived `config` defaults. Some fields apply live (ollama,
 * chunk sizes); others (storage, server, cookie) need a server restart, but we
 * still persist them so they survive reboots.
 */
export type WorkspaceSettings = {
  allowOpenSignup: boolean
  vaultRoot?: string
  ingest?: {
    maxFileBytes?: number
    chunkChars?: number
    chunkOverlap?: number
  }
  ollama?: {
    enabled?: boolean
    baseUrl?: string
    embedModel?: string
  }
  storage?: {
    backend?: 'local' | 's3'
    s3?: {
      endpoint?: string
      bucket?: string
      accessKey?: string
      secretKey?: string
      region?: string
      forcePathStyle?: boolean
    }
  }
  session?: {
    ttlDays?: number
    cookieSecure?: boolean
    cookieSameSite?: 'lax' | 'strict' | 'none'
  }
  server?: {
    host?: string
    port?: number
  }
  smtp?: {
    enabled?: boolean
    host?: string
    port?: number
    user?: string
    pass?: string
    from?: string
    secure?: boolean
  }
  webhooks?: WebhookConfig[]
  /**
   * Read-only external library mounts — absolute on-disk folders that
   * appear as virtual roots in every user's vault tree. Admin-only to
   * configure; visible to all signed-in users. Useful for browsing an
   * existing media library or imported corpus without copying it into
   * the per-user vault.
   */
  externalMounts?: ExternalMount[]
}

export type ExternalMount = {
  id: string
  /** Display name shown in the sidebar (e.g., "Family Photos"). */
  name: string
  /** Absolute path. The server only reads — never writes — under here. */
  absPath: string
  createdAt: number
}

export type WebhookConfig = {
  id: string
  url: string
  /** Bitmask of events the hook subscribes to. */
  events: Array<'upload' | 'edit' | 'delete' | 'share' | 'tags' | 'visibility' | 'ingest'>
  /** Optional shared secret — sent as `X-Reader-Signature` (HMAC-SHA256 hex). */
  secret?: string
  enabled?: boolean
  createdAt: number
  lastDelivery?: { ts: number; status: number | null; error?: string }
  /** Username that owns this hook. When set, the dispatcher only fires
   *  the hook for events on that user's files (event.actor === owner).
   *  Legacy hooks without an owner fire for every event. */
  owner?: string
}

const FILE = config.paths.settings

// Capture env-derived defaults so toggling settings off in the UI restores them.
const ENV = {
  vaultRoot: config.vault.root,
  ingest: { ...config.ingest },
  ollama: { ...config.ollama },
  storage: {
    backend: config.storage.backend,
    s3: { ...config.storage.s3 },
  },
  session: {
    ttlMs: config.session.ttlMs,
    secure: config.session.secure,
    sameSite: config.session.sameSite,
  },
  server: { ...config.server },
  smtp: { ...config.smtp },
}

let cache: WorkspaceSettings | null = null

function defaults(): WorkspaceSettings {
  return { allowOpenSignup: config.signup.allowOpen }
}

function applyOverrides(s: WorkspaceSettings): void {
  config.vault.root = s.vaultRoot?.trim() || ENV.vaultRoot

  config.ingest.maxFileBytes = s.ingest?.maxFileBytes ?? ENV.ingest.maxFileBytes
  config.ingest.chunkChars = s.ingest?.chunkChars ?? ENV.ingest.chunkChars
  config.ingest.chunkOverlap = s.ingest?.chunkOverlap ?? ENV.ingest.chunkOverlap

  config.ollama.enabled = s.ollama?.enabled ?? ENV.ollama.enabled
  config.ollama.baseUrl = s.ollama?.baseUrl?.trim() || ENV.ollama.baseUrl
  config.ollama.embedModel = s.ollama?.embedModel?.trim() || ENV.ollama.embedModel

  config.storage.backend = s.storage?.backend ?? ENV.storage.backend
  config.storage.s3.endpoint = s.storage?.s3?.endpoint ?? ENV.storage.s3.endpoint
  config.storage.s3.bucket = s.storage?.s3?.bucket ?? ENV.storage.s3.bucket
  config.storage.s3.accessKey = s.storage?.s3?.accessKey ?? ENV.storage.s3.accessKey
  config.storage.s3.secretKey = s.storage?.s3?.secretKey ?? ENV.storage.s3.secretKey
  config.storage.s3.region = s.storage?.s3?.region ?? ENV.storage.s3.region
  config.storage.s3.forcePathStyle = s.storage?.s3?.forcePathStyle ?? ENV.storage.s3.forcePathStyle

  config.session.ttlMs = s.session?.ttlDays
    ? s.session.ttlDays * 24 * 60 * 60 * 1000
    : ENV.session.ttlMs
  config.session.secure = s.session?.cookieSecure ?? ENV.session.secure
  config.session.sameSite = s.session?.cookieSameSite ?? ENV.session.sameSite

  config.server.host = s.server?.host?.trim() || ENV.server.host
  config.server.port = s.server?.port ?? ENV.server.port

  config.smtp.enabled = s.smtp?.enabled ?? ENV.smtp.enabled
  config.smtp.host = s.smtp?.host ?? ENV.smtp.host
  config.smtp.port = s.smtp?.port ?? ENV.smtp.port
  config.smtp.user = s.smtp?.user ?? ENV.smtp.user
  config.smtp.pass = s.smtp?.pass ?? ENV.smtp.pass
  config.smtp.from = s.smtp?.from?.trim() || ENV.smtp.from
  config.smtp.secure = s.smtp?.secure ?? ENV.smtp.secure
}

export async function loadSettings(): Promise<WorkspaceSettings> {
  if (cache) return cache
  try {
    const buf = await readFile(FILE, 'utf8')
    const parsed = JSON.parse(buf) as Partial<WorkspaceSettings>
    cache = { ...defaults(), ...parsed }
  } catch (e: any) {
    if (e?.code === 'ENOENT') cache = defaults()
    else throw e
  }
  applyOverrides(cache)
  return cache
}

export async function saveSettings(next: WorkspaceSettings): Promise<WorkspaceSettings> {
  if (next.vaultRoot && next.vaultRoot.trim()) {
    const target = next.vaultRoot.trim()
    if (!path.isAbsolute(target)) {
      throw Object.assign(new Error('vault root must be an absolute path'), { statusCode: 400 })
    }
    try {
      const s = await stat(target)
      if (!s.isDirectory()) {
        throw Object.assign(new Error('vault root is not a directory'), { statusCode: 400 })
      }
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw Object.assign(new Error('vault root does not exist'), { statusCode: 400 })
      }
      throw e
    }
    next.vaultRoot = target
  } else {
    delete next.vaultRoot
  }
  await ensureDir(path.dirname(FILE))
  await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8')
  cache = next
  applyOverrides(cache)
  return cache
}

export function clearSettingsCache(): void {
  cache = null
}

/**
 * Settings whose changes only apply after a server restart (storage backend,
 * cookie config, server host/port). The PATCH route returns this so the UI can
 * show a warning when one of these is touched.
 */
export const RESTART_REQUIRED_KEYS: Array<keyof WorkspaceSettings> = [
  'storage',
  'session',
  'server',
]
