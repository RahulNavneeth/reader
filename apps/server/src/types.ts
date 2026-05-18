export type Role = 'admin' | 'editor' | 'viewer'

/**
 * A path-based permission grant. `path = ""` applies to the whole vault.
 * `read` lets the user list/open paths under `path`. `write` lets them edit or
 * delete existing files. `create` lets them upload or mkdir inside the folder.
 */
export type Grant = {
  path: string
  read: boolean
  write: boolean
  create: boolean
}

export type User = {
  username: string
  passwordHash: string
  role: Role
  createdAt: number
  disabled?: boolean
  /** Per-user upload cap in bytes. Undefined / 0 / negative = unlimited. */
  quotaBytes?: number
  /** Optional contact address — used for outbound notifications
   *  (share invites, quota warnings) when SMTP is configured. */
  email?: string
}

export type Session = {
  token: string
  username: string
  createdAt: number
  expiresAt: number
}

export type AuditEvent = {
  ts: number
  actor: string | null
  action: string
  target?: string
  meta?: Record<string, unknown>
  ip?: string
}

export type PublicUser = Omit<User, 'passwordHash'>

export type DocumentMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/markdown'
  | 'text/html'
  | 'text/plain'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | string

export type DocumentMeta = {
  id: string
  title: string
  originalFilename: string
  mime: string
  bytes: number
  sha256: string
  storageKey: string
  owner: string                    // username
  acl: {
    readers: string[]              // usernames (besides owner). '*' = any authed user
    editors: string[]
  }
  /** If true, the file's raw, text, and meta endpoints are readable without auth. */
  public?: boolean
  /** Optional absolute timestamp past which the public link stops working. */
  publicExpiresAt?: number | null
  /** Optional scrypt-hashed password ("salt:digest" hex). When set, anonymous
   *  callers must provide `?p=<password>` to read. */
  publicPasswordHash?: string | null
  tags: string[]
  collectionId?: string
  createdAt: number
  updatedAt: number
  ingest: {
    status: 'pending' | 'extracting' | 'embedding' | 'ready' | 'failed' | 'no-text'
    error?: string
    chunkCount?: number
    embedDim?: number
    embedded: boolean              // true if at least one chunk has an embedding
    extractedAt?: number
    embeddedAt?: number
  }
  /** Lightweight regex-extracted entities from the doc's text. */
  entities?: {
    dates?: string[]
    amounts?: string[]
    emails?: string[]
    urls?: string[]
    orgs?: string[]
  }
  /** GPS coordinates extracted from image EXIF, if any. Set during ingest
   *  for JPEG / HEIC / TIFF originals. Used by the /map view. `null` (vs
   *  `undefined`) means we tried to extract and the image had no GPS — we
   *  cache the negative so we don't re-parse next time. */
  gps?: { lat: number; lng: number } | null
  /** Perceptual dHash (16-hex chars) for image files. Used by the
   *  admin Duplicates panel to surface near-identical photos
   *  (recompressed, resized) that sha256 wouldn't catch. `null` =
   *  tried and failed (corrupt/unsupported). */
  pHash?: string | null
  /** When this file is one half of a Live Photo / Motion Photo pair,
   *  the vault-relative path of the other half (typically the .mov
   *  paired with a .heic). Set on both files when the pair is
   *  detected; null when we know there's no pair. */
  livePhotoPair?: string | null
  /** For videos: true once ffmpeg has produced an HLS bundle on disk
   *  under the doc's storage dir. The MediaPlayer streams from the
   *  HLS endpoint when this is true; otherwise it falls back to the
   *  direct /api/file/raw byte stream. */
  hlsReady?: boolean
}

export type Chunk = {
  idx: number
  text: string
  embedding: number[]              // empty if Ollama was unavailable
  meta?: { page?: number; section?: string }
}

export type ApiToken = {
  id: string                       // public id (the prefix shown in admin UI)
  name: string
  hash: string                     // sha256(secret) hex; secret never stored
  role: Role
  createdBy: string
  createdAt: number
  /** Epoch ms after which the token is rejected. null = no expiry. */
  expiresAt?: number | null
  lastUsedAt?: number
  /** Total accepted uses. Surfaced in the admin UI for orphan-detection. */
  useCount?: number
  disabled?: boolean
}
