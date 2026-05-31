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
  /** When true, signing out of the web session also revokes every
   *  OAuth grant this user has issued to third-party MCP clients.
   *  Opt-in because the default (independent grants) matches Notion /
   *  Jira behavior; enabling this is the "sign out everywhere"
   *  workflow for users with sensitive vaults. */
  revokeOauthOnSignout?: boolean
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
  /** Soft hide from default listings + search. Distinct from Trash:
   *  archived files never auto-purge, stay searchable when the caller
   *  opts in (`?archived=true` on list / search, MCP `includeArchived`
   *  arg), and unarchive is one click. For old projects, tax records,
   *  any content the owner wants out of daily flow without deleting. */
  archived?: boolean
  /** Timestamp the doc was archived. Cleared on unarchive. */
  archivedAt?: number | null
  /** Owner-controlled write freeze. When true, every mutation
   *  (CRDT autosave, MCP edit, /api/file/upload overwrite, chat
   *  apply-edit, delete, move, etc.) returns 423 Locked unless the
   *  actor is the doc owner or an admin. Distinct from `archived`
   *  (which only hides from default views — still editable). */
  locked?: boolean
  /** Timestamp the doc was locked. Cleared on unlock. */
  lockedAt?: number | null
  /** Username that locked the doc. Surfaced in the UI banner so
   *  share-recipients know who to ask for an unlock. */
  lockedBy?: string | null
  /** Provenance for docs created from a template. Captures the
   *  source template path and the vars the user (or agent) passed
   *  in. Powers the "Refresh from template" affordance — we re-run
   *  the engine over the same template + vars + (re-computed
   *  built-ins) and overwrite the doc. Snapshotted before the
   *  overwrite, so refresh is reversible. */
  templateSource?: {
    template: string
    vars: Record<string, string>
    /** Title the user originally passed when instantiating. Re-fed
     *  to `applyTemplate` on refresh so any `{{title}}` in the
     *  template resolves to the same string it did the first time. */
    title?: string
  } | null
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
