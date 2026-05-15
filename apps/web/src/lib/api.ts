export type Role = 'admin' | 'editor' | 'viewer'

export type Grant = {
  path: string
  read: boolean
  write: boolean
  create: boolean
}

export type PublicUser = {
  username: string
  role: Role
  createdAt: number
  disabled?: boolean
  grants?: Grant[]
}

export type IngestStatus = 'pending' | 'extracting' | 'embedding' | 'ready' | 'failed' | 'no-text'

export type DocumentMeta = {
  id: string
  title: string
  originalFilename: string
  mime: string
  bytes: number
  sha256: string
  /** vault-relative path (the "primary key" for files in the new model) */
  storageKey: string
  owner: string
  acl: { readers: string[]; editors: string[] }
  public?: boolean
  tags: string[]
  collectionId?: string
  createdAt: number
  updatedAt: number
  ingest: {
    status: IngestStatus
    error?: string
    chunkCount?: number
    embedDim?: number
    embedded: boolean
    extractedAt?: number
    embeddedAt?: number
  }
}

export type VaultNode = {
  name: string
  /** vault-relative path; "" only for the root */
  path: string
  type: 'dir' | 'file'
  ext?: string
  size?: number
  mtime?: number
  hasChildren?: boolean
  docId?: string
  ingestStatus?: IngestStatus
  embedded?: boolean
  public?: boolean
  tags?: string[]
}

export type SearchHit = {
  docId: string
  /** vault-relative path — used for navigation */
  path: string
  title: string
  score: number
  snippet: string
  page?: number
  chunkIdx?: number
  source: 'lexical' | 'semantic' | 'hybrid'
}

export type WorkspaceSettings = {
  allowOpenSignup: boolean
  vaultRoot?: string
  defaultGrants?: Grant[]
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
}

export type SystemInfo = {
  vaultRoot: string
  dataDir: string
  /** Back-compat: same as ingest.maxFileBytes */
  maxFileBytes: number
  ingest: { maxFileBytes: number; chunkChars: number; chunkOverlap: number }
  ollama: { enabled: boolean; baseUrl: string; embedModel: string; available: boolean }
  storage: {
    backend: 'local' | 's3'
    s3: {
      endpoint: string
      bucket: string
      accessKey: string
      region: string
      forcePathStyle: boolean
    }
  }
  session: { ttlDays: number; cookieSecure: boolean; cookieSameSite: 'lax' | 'strict' | 'none' }
  server: { host: string; port: number }
  smtp: {
    enabled: boolean
    host: string
    port: number
    user: string
    from: string
    secure: boolean
    /** True when a password is stored on the server (never exposed). */
    passSet: boolean
  }
}

export type ApiTokenInfo = {
  id: string
  name: string
  role: Role
  createdBy: string
  createdAt: number
  lastUsedAt?: number
  disabled?: boolean
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data?.error || `HTTP ${res.status}`)
  }
  return res.json()
}

const get = <T>(url: string) => request<T>('GET', url)
const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body)

const q = (params: Record<string, string | number | undefined>): string => {
  const out: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue
    out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return out.length ? '?' + out.join('&') : ''
}

export const api = {
  // bootstrap / auth
  bootstrap: () => get<{ hasAdmin: boolean; allowOpenSignup: boolean }>('/api/bootstrap'),
  me: () => get<{ user: PublicUser }>('/api/auth/me'),
  signup: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/auth/signup', { username, password }),
  login: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  // vault — all paths are vault-relative ("" = root)
  home: () => get<{ vault: string; separator: string }>('/api/home'),
  list: (rel: string) => get<{ path: string; items: VaultNode[] }>(`/api/list${q({ path: rel })}`),
  folders: () => get<{ folders: string[] }>('/api/folders'),
  vaultTree: () => get<{ folders: string[]; files: string[] }>('/api/vault-tree'),
  fileText: (rel: string) =>
    get<{ path: string; content: string; size: number; mtime: number; docId?: string }>(
      `/api/file/text${q({ path: rel })}`,
    ),
  fileMeta: (rel: string) => get<{ meta: DocumentMeta | null }>(`/api/file/meta${q({ path: rel })}`),
  /** Canonical browser-facing URL for a file. Vite/server negotiates: document → SPA, else raw bytes. */
  rawUrl: (rel: string) => '/docs/' + rel.split('/').map(encodeURIComponent).join('/'),
  thumbnailUrl: (rel: string) => `/api/file/thumbnail${q({ path: rel })}`,
  /**
   * Browser-renderable version. For HEIC, returns a JPEG transcoded at
   * ingest; for other types, just streams the raw bytes. Use rawUrl() when
   * you specifically need the original (e.g., a download button).
   */
  previewUrl: (rel: string) => `/api/file/preview${q({ path: rel })}`,
  upload: async (file: File, opts?: { dir?: string; title?: string; tags?: string }) => {
    const fd = new FormData()
    fd.set('file', file)
    if (opts?.dir != null) fd.set('path', opts.dir)
    if (opts?.title) fd.set('title', opts.title)
    if (opts?.tags) fd.set('tags', opts.tags)
    const res = await fetch('/api/file/upload', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(res.status, data?.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as { document: DocumentMeta; path: string }
  },
  indexFile: (rel: string) => post<{ document: DocumentMeta }>('/api/file/index', { path: rel }),
  setVisibility: (rel: string, isPublic: boolean) =>
    post<{ document: DocumentMeta }>('/api/file/visibility', { path: rel, public: isPublic }),
  setTags: (rel: string, tags: string[]) =>
    post<{ document: DocumentMeta }>('/api/file/tags', { path: rel, tags }),
  tags: () => get<{ tags: { tag: string; count: number }[] }>('/api/tags'),
  filesByTag: (tag: string) =>
    get<{
      tag: string
      items: {
        path: string
        name: string
        ext: string
        docId: string
        tags: string[]
        public: boolean
      }[]
    }>(`/api/files/by-tag${q({ tag })}`),
  fileActivity: (rel: string, limit = 50) =>
    get<{ entries: { ts: number; actor: string; action: string; target?: string; meta?: any }[] }>(
      `/api/file/activity${q({ path: rel, limit })}`,
    ),
  bulkSetVisibility: (paths: string[], isPublic: boolean) =>
    post<{ ok: number; failed: number }>('/api/file/bulk-visibility', { paths, public: isPublic }),
  bulkDelete: (paths: string[]) =>
    post<{ ok: number; failed: number }>('/api/file/bulk-delete', { paths }),

  // trash
  trashList: () =>
    get<{
      entries: {
        id: string
        storageKey: string
        filename: string
        docId?: string
        bytes: number
        trashedAt: number
        trashedBy: string
      }[]
    }>('/api/trash'),
  trashRestore: (id: string) => post<{ ok: true }>(`/api/trash/${encodeURIComponent(id)}/restore`),
  trashPurge: (id: string) =>
    fetch(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }).then(
      async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          throw new ApiError(r.status, data?.error || `HTTP ${r.status}`)
        }
        return r.json() as Promise<{ ok: true }>
      },
    ),
  deleteFile: (rel: string) =>
    fetch(`/api/file${q({ path: rel })}`, { method: 'DELETE', credentials: 'include' }).then(
      async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          throw new ApiError(r.status, data?.error || `HTTP ${r.status}`)
        }
        return r.json() as Promise<{ ok: true }>
      },
    ),
  mkdir: (rel: string) => post<{ ok: true; path: string }>('/api/folder', { path: rel }),
  move: (from: string, to: string) => post<{ ok: true }>('/api/file/move', { from, to }),

  // search
  searchKnowledge: (qstr: string, limit = 20) =>
    get<{ query: string; hits: SearchHit[] }>(`/api/search/knowledge${q({ q: qstr, limit })}`),

  // admin — users
  adminUsers: () => get<{ users: PublicUser[] }>('/api/admin/users'),
  adminCreateUser: (username: string, password: string, role: Role, grants?: Grant[]) =>
    post<{ user: PublicUser }>('/api/admin/users', { username, password, role, grants }),
  adminPatchUser: (
    username: string,
    patch: { role?: Role; disabled?: boolean; grants?: Grant[] },
  ) =>
    request<{ user: PublicUser }>('PATCH', `/api/admin/users/${encodeURIComponent(username)}`, patch),
  adminDeleteUser: (username: string) =>
    fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).then(async (r) => {
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new ApiError(r.status, data?.error || `HTTP ${r.status}`)
      }
      return r.json() as Promise<{ ok: true }>
    }),

  // admin — workspace settings & system info
  adminSettings: () => get<{ settings: WorkspaceSettings }>('/api/admin/settings'),
  adminPatchSettings: (patch: Partial<WorkspaceSettings>) =>
    request<{ settings: WorkspaceSettings; restartRequired: boolean }>('PATCH', '/api/admin/settings', patch),
  adminSystem: () => get<SystemInfo>('/api/admin/system'),
  adminBrowse: (absPath?: string) =>
    get<{
      current: string
      parent: string | null
      home: string
      entries: { name: string; path: string }[]
    }>(`/api/admin/browse${q({ path: absPath })}`),
  adminFindFolder: (name: string) =>
    get<{ matches: string[] }>(`/api/admin/find-folder${q({ name })}`),
  adminSetDataDir: (dataDir: string) =>
    post<{ ok: true; dataDir: string | null; restartRequired: true }>('/api/admin/data-dir', { dataDir }),
  adminTestSmtp: (to: string) =>
    post<{ ok: true; id: string }>('/api/admin/smtp/test', { to }),
  adminReembedAll: () =>
    post<{
      total: number
      ok: number
      removed: number
      failed: number
      errors: { id: string; error: string }[]
    }>('/api/admin/reembed-all'),
  adminStats: () =>
    get<{
      totals: { documents: number; bytes: number; users: number; publicDocs: number; embeddedDocs: number }
      byStatus: Record<string, number>
      byExt: { ext: string; count: number }[]
      byOwner: { owner: string; count: number }[]
      recent: { id: string; title: string; storageKey: string; createdAt: number }[]
    }>('/api/admin/stats'),
  adminDuplicates: () =>
    get<{
      groups: {
        sha256: string
        bytes: number
        docs: { id: string; storageKey: string; title: string; bytes: number; createdAt: number; owner: string }[]
      }[]
    }>('/api/admin/duplicates'),
  adminOllamaModels: () =>
    get<{ models: string[]; error?: string }>('/api/admin/ollama/models'),

  // admin — tokens
  adminTokens: () => get<{ tokens: ApiTokenInfo[] }>('/api/admin/tokens'),
  adminCreateToken: (name: string, role: Role) =>
    post<{ secret: string; token: ApiTokenInfo }>('/api/admin/tokens', { name, role }),
  adminDeleteToken: (id: string) =>
    fetch(`/api/admin/tokens/${id}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
      return r.json() as Promise<{ ok: true }>
    }),
}
