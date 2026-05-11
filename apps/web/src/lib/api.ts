export type Role = 'admin' | 'editor' | 'viewer'

export type PublicUser = {
  username: string
  role: Role
  createdAt: number
  disabled?: boolean
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
  bootstrap: () => get<{ hasAdmin: boolean }>('/api/bootstrap'),
  me: () => get<{ user: PublicUser }>('/api/auth/me'),
  signup: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/auth/signup', { username, password }),
  login: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  // vault — all paths are vault-relative ("" = root)
  home: () => get<{ vault: string; separator: string }>('/api/home'),
  list: (rel: string) => get<{ path: string; items: VaultNode[] }>(`/api/list${q({ path: rel })}`),
  fileText: (rel: string) =>
    get<{ path: string; content: string; size: number; mtime: number; docId?: string }>(
      `/api/file/text${q({ path: rel })}`,
    ),
  fileMeta: (rel: string) => get<{ meta: DocumentMeta | null }>(`/api/file/meta${q({ path: rel })}`),
  /** Canonical browser-facing URL for a file. Vite/server negotiates: document → SPA, else raw bytes. */
  rawUrl: (rel: string) => '/docs/' + rel.split('/').map(encodeURIComponent).join('/'),
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

  // admin
  adminUsers: () => get<{ users: PublicUser[] }>('/api/admin/users'),
  adminTokens: () => get<{ tokens: ApiTokenInfo[] }>('/api/admin/tokens'),
  adminCreateToken: (name: string, role: Role) =>
    post<{ secret: string; token: ApiTokenInfo }>('/api/admin/tokens', { name, role }),
  adminDeleteToken: (id: string) =>
    fetch(`/api/admin/tokens/${id}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
      return r.json() as Promise<{ ok: true }>
    }),
}
