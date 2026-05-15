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
  lastUsedAt?: number
  disabled?: boolean
}
