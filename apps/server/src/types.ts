export type Role = 'admin' | 'editor' | 'viewer'

export type User = {
  username: string
  passwordHash: string
  role: Role
  createdAt: number
  disabled?: boolean
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
