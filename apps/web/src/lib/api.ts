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
  /** Per-user upload cap in bytes. Unset/0 = unlimited. */
  quotaBytes?: number
  /** Optional contact address for notifications. */
  email?: string
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
  publicExpiresAt?: number | null
  publicPasswordHash?: string | null
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
  entities?: {
    dates?: string[]
    amounts?: string[]
    emails?: string[]
    urls?: string[]
    orgs?: string[]
  }
  /** GPS coords from image EXIF (HEIC/JPEG/TIFF); null = parsed but absent. */
  gps?: { lat: number; lng: number } | null
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
  publicExpiresAt?: number | null
  tags?: string[]
}

export type SearchHit = {
  docId: string
  /** vault-relative path — used for navigation */
  path: string
  title: string
  /** Owner of the file. Differs from the requester when the hit comes
   *  from a shared subtree; thread `?owner=<owner>` for navigation. */
  owner: string
  score: number
  snippet: string
  page?: number
  chunkIdx?: number
  source: 'lexical' | 'semantic' | 'hybrid'
}

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
  expiresAt?: number | null
  lastUsedAt?: number
  useCount?: number
  disabled?: boolean
}

export class ApiError extends Error {
  status: number
  /** Full error response body — lets callers read fields like
   *  `kind` or `passwordRequired` to render the right UI on 401/410. */
  body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  // X-Requested-With satisfies the server's CSRF guard on mutating
  // requests (browsers can't set custom headers cross-origin without
  // a CORS preflight, which our origin allowlist blocks). Cheap to
  // always send.
  const headers: Record<string, string> = { 'X-Requested-With': 'fetch' }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data || {})
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
  accountStats: () =>
    get<{
      user: PublicUser
      storage: {
        bytesUsed: number
        quotaBytes: number | null
        fileCount: number
        publicCount: number
        embeddedCount: number
      }
      recent: Array<{
        path: string
        name: string
        bytes: number
        createdAt: number
        embedded: boolean
        public: boolean
      }>
      fileTypes: Array<{ ext: string; count: number }>
      activity: Array<{ ts: number; action: string; target: string | null }>
      shares: { outgoing: number; incoming: number }
      sessions: Array<{
        token: string
        createdAt: number
        expiresAt: number
        current: boolean
      }>
    }>('/api/account/stats'),
  signup: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/auth/signup', { username, password }),
  login: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  // vault — all paths are vault-relative ("" = root)
  home: () => get<{ vault: string; separator: string }>('/api/home'),
  resolve: (rel: string, opts?: { owner?: string; password?: string }) =>
    get<{
      kind: 'file' | 'folder'
      owner: string
      public: boolean
      access: {
        ownedByRequester: boolean
        sharedReadOnly: boolean
        sharedEdit: boolean
      }
    }>(`/api/resolve${q({ path: rel, owner: opts?.owner, p: opts?.password })}`),
  list: (rel: string, opts?: { owner?: string; password?: string }) =>
    get<{ path: string; items: VaultNode[]; partialAccess?: boolean }>(
      `/api/list${q({ path: rel, owner: opts?.owner, p: opts?.password })}`,
    ),
  folders: () => get<{ folders: string[] }>('/api/folders'),
  vaultTree: () => get<{ folders: string[]; files: string[] }>('/api/vault-tree'),
  fileText: (rel: string, opts?: { password?: string; owner?: string }) =>
    get<{ path: string; content: string; size: number; mtime: number; docId?: string }>(
      `/api/file/text${q({ path: rel, p: opts?.password, owner: opts?.owner })}`,
    ),
  fileMeta: (rel: string, opts?: { password?: string; owner?: string }) =>
    get<{ meta: DocumentMeta | null }>(
      `/api/file/meta${q({ path: rel, p: opts?.password, owner: opts?.owner })}`,
    ),
  rawUrl: (rel: string, opts?: { password?: string; owner?: string }) =>
    `/api/file/raw${q({ path: rel, p: opts?.password, owner: opts?.owner })}`,
  thumbnailUrl: (rel: string, opts?: { password?: string; owner?: string }) =>
    `/api/file/thumbnail${q({ path: rel, p: opts?.password, owner: opts?.owner })}`,
  previewUrl: (rel: string, opts?: { password?: string; owner?: string }) =>
    `/api/file/preview${q({ path: rel, p: opts?.password, owner: opts?.owner })}`,
  upload: async (file: File, opts?: { dir?: string; title?: string; tags?: string }) => {
    const fd = new FormData()
    fd.set('file', file)
    if (opts?.dir != null) fd.set('path', opts.dir)
    if (opts?.title) fd.set('title', opts.title)
    if (opts?.tags) fd.set('tags', opts.tags)
    const res = await fetch('/api/file/upload', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch' },
      body: fd,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(res.status, data?.error || `HTTP ${res.status}`)
    }
    return (await res.json()) as { document: DocumentMeta; path: string }
  },
  indexFile: (rel: string) => post<{ document: DocumentMeta }>('/api/file/index', { path: rel }),
  setVisibility: (
    rel: string,
    isPublic: boolean,
    opts?: { expiresInSeconds?: number | null; password?: string | null },
  ) =>
    post<{ document: DocumentMeta }>('/api/file/visibility', {
      path: rel,
      public: isPublic,
      expiresInSeconds: opts?.expiresInSeconds ?? null,
      password: opts?.password ?? null,
    }),
  setTags: (rel: string, tags: string[], opts?: { owner?: string }) =>
    post<{ document: DocumentMeta }>('/api/file/tags', {
      path: rel,
      tags,
      ...(opts?.owner ? { owner: opts.owner } : {}),
    }),
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
        owner: string
        type: 'file' | 'dir'
      }[]
    }>(`/api/files/by-tag${q({ tag })}`),
  /** Cross-folder filename + tag + folder-name search. */
  filesSearch: (qstr: string, limit = 50) =>
    get<{
      q: string
      items: {
        path: string
        name: string
        ext: string
        docId: string
        tags: string[]
        public: boolean
        owner: string
        score: number
        matchedTags: string[]
      }[]
      folders: { path: string; name: string; owner: string; score: number }[]
    }>(`/api/files/search${q({ q: qstr, limit })}`),
  fileVersions: (rel: string) =>
    get<{ versions: { ts: number; sha256: string; bytes: number; title?: string; hasText: boolean }[] }>(
      `/api/file/versions${q({ path: rel })}`,
    ),
  fileVersionText: (rel: string, ts: number) =>
    get<{ ts: number; text: string }>(`/api/file/version${q({ path: rel, ts })}`),

  fileActivity: (rel: string, limit = 50) =>
    get<{ entries: { ts: number; actor: string; action: string; target?: string; meta?: any }[] }>(
      `/api/file/activity${q({ path: rel, limit })}`,
    ),

  // folder-level metadata
  getFolderMeta: (rel: string, opts?: { owner?: string; password?: string }) =>
    get<{
      folder: {
        owner: string
        storageKey: string
        tags: string[]
        public?: boolean
        publicExpiresAt?: number | null
        hasPassword: boolean
        createdAt: number
        updatedAt: number
      }
    }>(`/api/folder/meta${q({ path: rel, owner: opts?.owner, p: opts?.password })}`),
  setFolderVisibility: (
    rel: string,
    isPublic: boolean,
    opts?: { expiresInSeconds?: number | null; password?: string | null },
  ) =>
    post<{
      folder: {
        owner: string
        storageKey: string
        tags: string[]
        public?: boolean
        publicExpiresAt?: number | null
        hasPassword: boolean
        createdAt: number
        updatedAt: number
      }
      cascade: { files: number; folders: number; failedFiles: number }
    }>('/api/folder/visibility', {
      path: rel,
      public: isPublic,
      expiresInSeconds: opts?.expiresInSeconds ?? null,
      password: opts?.password ?? null,
    }),
  setFolderTags: (rel: string, tags: string[]) =>
    post<{
      folder: {
        owner: string
        storageKey: string
        tags: string[]
        public?: boolean
        publicExpiresAt?: number | null
        hasPassword: boolean
        createdAt: number
        updatedAt: number
      }
    }>('/api/folder/tags', { path: rel, tags }),
  folderActivity: (rel: string, limit = 50) =>
    get<{ entries: { ts: number; actor: string; action: string; target?: string; meta?: any }[] }>(
      `/api/folder/activity${q({ path: rel, limit })}`,
    ),

  // user-to-user shares
  createUserShare: (body: { path: string; recipient: string; canEdit?: boolean; label?: string }) =>
    post<{
      share: {
        id: string
        owner: string
        recipient: string
        storageKey: string
        isFolder: boolean
        canEdit: boolean
        label?: string
        createdAt: number
      }
    }>('/api/file/share-with', body),
  listUserSharesFrom: () =>
    get<{
      shares: {
        id: string
        owner: string
        recipient: string
        storageKey: string
        isFolder: boolean
        canEdit: boolean
        label?: string
        createdAt: number
      }[]
    }>('/api/file/shares-from'),
  listUserSharesTo: () =>
    get<{
      shares: {
        id: string
        owner: string
        recipient: string
        storageKey: string
        isFolder: boolean
        canEdit: boolean
        label?: string
        createdAt: number
        name: string
        ext: string
        docId?: string
        embedded: boolean
        public: boolean
      }[]
    }>('/api/file/shares-to'),
  deleteUserShare: (id: string) =>
    fetch(`/api/file/share-with/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch' },
    }).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
      return r.json() as Promise<{ ok: true }>
    }),

  // saved views
  listViews: () =>
    get<{ views: { id: string; name: string; query?: string; tag?: string; createdAt: number }[] }>(
      '/api/views',
    ),
  createView: (v: { name: string; query?: string; tag?: string }) =>
    post<{ view: { id: string; name: string; query?: string; tag?: string; createdAt: number } }>(
      '/api/views',
      v,
    ),
  deleteView: (id: string) =>
    fetch(`/api/views/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch' },
    }).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
      return r.json() as Promise<{ ok: true }>
    }),

  bulkSetVisibility: (
    paths: string[],
    isPublic: boolean,
    opts?: { expiresInSeconds?: number | null; password?: string | null },
  ) =>
    post<{ ok: number; failed: number }>('/api/file/bulk-visibility', {
      paths,
      public: isPublic,
      expiresInSeconds: opts?.expiresInSeconds ?? null,
      password: opts?.password ?? null,
    }),
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
    fetch(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } }).then(
      async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          throw new ApiError(r.status, data?.error || `HTTP ${r.status}`)
        }
        return r.json() as Promise<{ ok: true }>
      },
    ),
  deleteFile: (rel: string) =>
    fetch(`/api/file${q({ path: rel })}`, { method: 'DELETE', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } }).then(
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
  adminCreateUser: (username: string, password: string, role: Role) =>
    post<{ user: PublicUser }>('/api/admin/users', { username, password, role }),
  adminPatchUser: (
    username: string,
    patch: { role?: Role; disabled?: boolean; quotaBytes?: number | null },
  ) =>
    request<{ user: PublicUser }>('PATCH', `/api/admin/users/${encodeURIComponent(username)}`, patch),
  adminDeleteUser: (username: string) =>
    fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch' },
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
  adminJobs: () =>
    get<{
      jobs: {
        id: string
        type: string
        target?: string
        status: 'pending' | 'running' | 'completed' | 'failed'
        createdAt: number
        startedAt?: number
        finishedAt?: number
        durationMs?: number
        error?: string
      }[]
      counts: { pending: number; running: number; completed: number; failed: number }
    }>('/api/admin/jobs'),

  adminWebhooks: () =>
    get<{
      webhooks: {
        id: string
        url: string
        events: Array<'upload' | 'edit' | 'delete' | 'share' | 'tags' | 'visibility'>
        secret?: string
        enabled?: boolean
        createdAt: number
        lastDelivery?: { ts: number; status: number | null; error?: string }
      }[]
    }>('/api/admin/webhooks'),
  adminCreateWebhook: (body: {
    url: string
    events: Array<'upload' | 'edit' | 'delete' | 'share' | 'tags' | 'visibility'>
    secret?: string
    enabled?: boolean
  }) =>
    post<{ webhook: any }>('/api/admin/webhooks', body),
  adminDeleteWebhook: (id: string) =>
    fetch(`/api/admin/webhooks/${id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } }).then(
      async (r) => {
        if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
        return r.json() as Promise<{ ok: true }>
      },
    ),

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

  // pins
  listPins: () =>
    get<{
      pins: Array<{
        owner: string
        storageKey: string
        isFolder: boolean
        pinnedAt: number
        label?: string
      }>
    }>('/api/pins'),
  addPin: (body: { path: string; owner?: string; isFolder?: boolean; label?: string }) =>
    post<{
      pins: Array<{
        owner: string
        storageKey: string
        isFolder: boolean
        pinnedAt: number
        label?: string
      }>
    }>('/api/pins', body),
  removePin: (body: { path: string; owner?: string }) =>
    request<{
      pins: Array<{
        owner: string
        storageKey: string
        isFolder: boolean
        pinnedAt: number
        label?: string
      }>
    }>('DELETE', '/api/pins', body),

  // user account — email, reembed, tokens, webhooks (all scoped to caller)
  patchAccountEmail: (email: string) =>
    request<{ user: PublicUser }>('PATCH', '/api/account/email', { email }),
  accountReembed: () =>
    post<{
      total: number
      ok: number
      removed: number
      failed: number
      errors: { id: string; error: string }[]
    }>('/api/account/reembed'),
  accountTokens: () => get<{ tokens: ApiTokenInfo[] }>('/api/account/tokens'),
  accountCreateToken: (name: string, expiresInDays?: number | null) =>
    post<{ secret: string; token: ApiTokenInfo }>('/api/account/tokens', {
      name,
      ...(expiresInDays !== undefined ? { expiresInDays } : {}),
    }),
  accountDeleteToken: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/account/tokens/${encodeURIComponent(id)}`),
  accountWebhooks: () =>
    get<{
      webhooks: Array<{
        id: string
        url: string
        events: Array<'upload' | 'edit' | 'delete' | 'share' | 'tags' | 'visibility'>
        secret?: string
        enabled?: boolean
        createdAt: number
        owner?: string
        lastDelivery?: { ts: number; status: number | null; error?: string }
      }>
    }>('/api/account/webhooks'),
  accountCreateWebhook: (body: {
    url: string
    events: Array<'upload' | 'edit' | 'delete' | 'share' | 'tags' | 'visibility'>
    secret?: string
    enabled?: boolean
  }) =>
    post<{ webhook: any }>('/api/account/webhooks', body),
  accountDeleteWebhook: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/account/webhooks/${encodeURIComponent(id)}`),

  // map — geotagged photos
  accountMap: () =>
    get<{
      items: Array<{
        docId: string
        path: string
        name: string
        mime: string
        createdAt: number
        lat: number
        lng: number
      }>
      backfilled: number
      moreToBackfill: boolean
    }>('/api/account/map'),

  // memories
  memories: () =>
    get<{
      date: string
      groups: Array<{
        yearsAgo: number
        label: string
        items: Array<{
          path: string
          name: string
          bytes: number
          mime: string
          createdAt: number
          embedded: boolean
          public: boolean
        }>
      }>
    }>('/api/account/memories'),

  // bulk export — direct URL the user navigates to so the browser streams the download
  exportUrl: () => '/api/account/export.zip',

  // external library mounts
  listExternalMounts: () =>
    get<{ mounts: Array<{ id: string; name: string; hint: string }> }>('/api/external-mounts'),
  listExternalMountEntries: (id: string, rel = '') =>
    get<{
      mountId: string
      mountName: string
      path: string
      items: Array<{
        name: string
        path: string
        type: 'dir' | 'file'
        ext?: string
        size?: number
        mtime?: number
        hasChildren?: boolean
      }>
    }>(`/api/external-mounts/${encodeURIComponent(id)}/list${q({ path: rel })}`),
  externalMountFileUrl: (id: string, rel: string) =>
    `/api/external-mounts/${encodeURIComponent(id)}/file${q({ path: rel })}`,

  // admin — external library mounts
  adminListExternalMounts: () =>
    get<{
      mounts: Array<{ id: string; name: string; absPath: string; createdAt: number }>
    }>('/api/admin/external-mounts'),
  adminCreateExternalMount: (body: { name: string; absPath: string }) =>
    post<{
      mount: { id: string; name: string; absPath: string; createdAt: number }
    }>('/api/admin/external-mounts', body),
  adminDeleteExternalMount: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/admin/external-mounts/${encodeURIComponent(id)}`),

  // admin — tokens
  adminTokens: () => get<{ tokens: ApiTokenInfo[] }>('/api/admin/tokens'),
  adminCreateToken: (name: string, role: Role) =>
    post<{ secret: string; token: ApiTokenInfo }>('/api/admin/tokens', { name, role }),
  adminDeleteToken: (id: string) =>
    fetch(`/api/admin/tokens/${id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } }).then((r) => {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
      return r.json() as Promise<{ ok: true }>
    }),
}
