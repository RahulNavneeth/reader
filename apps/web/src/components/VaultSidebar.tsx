import { useCallback, useEffect, useState } from 'react'
import { Filter, X, AlertCircle, Loader2, Tag, ChevronRight, FileText, Folder, Bookmark, Save } from 'lucide-react'
import clsx from 'clsx'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { VaultTree } from './VaultTree'
import { useVault } from '../lib/vault-context'

// JSON-equality. Fine for our small payloads (tree/tags/views are O(100)
// entries each); avoids pulling lodash for one comparator.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

type FlatHit = {
  path: string
  name: string
  ext: string
  docId: string
  tags: string[]
  public: boolean
  owner: string
  score: number
  matchedTags: string[]
}

type FolderHit = { path: string; name: string; owner: string; score: number }

/**
 * The left rail used by both VaultView and the workspace-settings page.
 *
 * Owns: tree fetch + filter + drag-drop upload zone. Inherits selection /
 * active path from the URL and the vault context, so the active file/folder is
 * always highlighted regardless of which page is rendered to the right of it.
 */
export function VaultSidebar() {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const openPath = (params['*'] || '').trim() || null
  const activeTag = location.pathname.startsWith('/tags/') ? params.tag ?? null : null
  const { uploadFiles, refreshNonce, uploadingName, vaultError, clearError, currentFolder, currentUsername } = useVault()
  const activePath = openPath ?? (currentFolder || null)

  const [tree, setTree] = useState<VaultNode[] | null>(null)
  const [tags, setTags] = useState<Array<{ tag: string; count: number }> | null>(null)
  // Collapsed by default — when the vault grows large the file tree is the
  // primary nav; tags are a secondary index the user expands when needed.
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  const [views, setViews] = useState<
    Array<{ id: string; name: string; query?: string; tag?: string; createdAt: number }>
  >([])
  const [viewsOpen, setViewsOpen] = useState(false)
  const [sharedWithMe, setSharedWithMe] = useState<
    Array<{
      id: string
      owner: string
      storageKey: string
      isFolder: boolean
      canEdit: boolean
      name: string
      ext: string
      embedded: boolean
      public: boolean
    }>
  >([])
  const [sharedOpen, setSharedOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [searchHits, setSearchHits] = useState<FlatHit[] | null>(null)
  const [searchFolders, setSearchFolders] = useState<FolderHit[]>([])
  const [searching, setSearching] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const [list, tagsR, viewsR, sharesR] = await Promise.all([
        api.list(''),
        api.tags().catch(() => ({ tags: [] })),
        api.listViews().catch(() => ({ views: [] })),
        api.listUserSharesTo().catch(() => ({ shares: [] })),
      ])
      setTree((prev) => (sameJson(prev, list.items) ? prev : list.items))
      setTags((prev) => (sameJson(prev, tagsR.tags) ? prev : tagsR.tags))
      setViews((prev) => (sameJson(prev, viewsR.views) ? prev : viewsR.views))
      setSharedWithMe((prev) =>
        sameJson(prev, sharesR.shares) ? prev : (sharesR.shares as typeof prev),
      )
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  // Debounce refresh-driven refetches. A single user action can publish
  // several SSE events in quick succession (e.g. ingest -> thumbnail ->
  // preview); we coalesce them into one network round-trip.
  useEffect(() => {
    const t = setTimeout(refetch, 80)
    return () => clearTimeout(t)
  }, [refetch, refreshNonce])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!e.dataTransfer?.files?.length) return
    uploadFiles(e.dataTransfer.files)
  }

  const isExternalFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') &&
    !e.dataTransfer.types.includes('application/x-reader-path')

  // Server-side filename + tag search for matches that live inside folders
  // (which the top-level tree filter above can't see). Debounced so quick
  // typing doesn't generate a request per keystroke.
  useEffect(() => {
    const q = filter.trim()
    if (!q) {
      setSearchHits(null)
      setSearchFolders([])
      setSearching(false)
      return
    }
    setSearching(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await api.filesSearch(q, 50)
        if (!cancelled) {
          setSearchHits(r.items)
          setSearchFolders(r.folders ?? [])
        }
      } catch {
        if (!cancelled) {
          setSearchHits([])
          setSearchFolders([])
        }
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [filter])

  return (
    <aside className="panel border-r border-app overflow-y-auto shrink-0 w-[320px] flex flex-col">
      <div
        className="h-11 px-2 flex items-center border-b sticky top-0 z-10"
        style={{ background: 'var(--panel)', borderColor: 'var(--border-soft)' }}
      >
        <div className="relative w-full">
          <Filter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
          <input
            className="input pl-8 pr-7 h-7 text-[12.5px]"
            placeholder="Filter files (⌘K for search)…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <>
              <button
                className="absolute right-7 top-1/2 -translate-y-1/2 btn-ghost h-5 w-5 px-0"
                onClick={async () => {
                  const name = window.prompt('Save this filter as a view. Name?')
                  if (!name?.trim()) return
                  try {
                    await api.createView({ name: name.trim(), query: filter.trim() })
                    refetch()
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : String(e))
                  }
                }}
                title="Save current filter as a view"
              >
                <Save size={11} />
              </button>
              <button
                className="absolute right-1.5 top-1/2 -translate-y-1/2 btn-ghost h-5 w-5 px-0"
                onClick={() => setFilter('')}
              >
                <X size={11} />
              </button>
            </>
          )}
        </div>
      </div>

      <div
        className={clsx('flex-1 overflow-y-auto px-1 py-2', dragOver && 'ring-2 ring-inset')}
        style={dragOver ? { boxShadow: 'inset 0 0 0 2px var(--accent)' } : undefined}
        onDragOver={(e) => {
          if (!isExternalFileDrag(e)) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {/* Saved views — quick re-apply of past filter combos. Only renders
            when the user has actually saved at least one; collapsed by
            default to stay out of the way. */}
        {!filter.trim() && views.length > 0 && (
          <div className="mb-2 mx-1">
            <button
              className="w-full flex items-center gap-1 px-2 h-6 text-[10.5px] uppercase tracking-wider font-semibold text-subtle hover:bg-hover rounded"
              onClick={() => setViewsOpen((v) => !v)}
            >
              <ChevronRight
                size={11}
                className="transition-transform"
                style={{ transform: viewsOpen ? 'rotate(90deg)' : undefined }}
              />
              Views
              <span className="text-subtle font-normal normal-case ml-1">({views.length})</span>
            </button>
            {viewsOpen && (
              <div className="space-y-0.5 mt-0.5">
                {views.map((v) => (
                  <div
                    key={v.id}
                    className="group flex items-center gap-1 px-2 h-7 rounded hover:bg-hover"
                  >
                    <button
                      className="flex-1 flex items-center gap-2 text-[12.5px] text-fg text-left min-w-0"
                      onClick={() => {
                        if (v.tag) navigate(`/tags/${encodeURIComponent(v.tag)}`)
                        else if (v.query) setFilter(v.query)
                      }}
                      title={v.tag ? `#${v.tag}` : v.query}
                    >
                      <Bookmark size={11} className="text-muted shrink-0" />
                      <span className="truncate">{v.name}</span>
                    </button>
                    <button
                      className="opacity-0 group-hover:opacity-100 btn-ghost h-5 w-5 px-0"
                      onClick={async () => {
                        if (!window.confirm(`Delete view "${v.name}"?`)) return
                        try {
                          await api.deleteView(v.id)
                          refetch()
                        } catch {
                          /* ignore */
                        }
                      }}
                      title="Delete view"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Files / folders other users have shared with the caller. Each
            click opens the doc viewer with ?owner=<their username> so the
            read endpoints resolve to the owner's namespace. */}
        {!filter.trim() && sharedWithMe.length > 0 && (
          <div className="mb-2 mx-1">
            <button
              className="w-full flex items-center gap-1 px-2 h-6 text-[10.5px] uppercase tracking-wider font-semibold text-subtle hover:bg-hover rounded"
              onClick={() => setSharedOpen((v) => !v)}
            >
              <ChevronRight
                size={11}
                className="transition-transform"
                style={{ transform: sharedOpen ? 'rotate(90deg)' : undefined }}
              />
              Shared with me
              <span className="text-subtle font-normal normal-case ml-1">
                ({sharedWithMe.length})
              </span>
            </button>
            {sharedOpen && (
              <div className="mt-0.5 space-y-0.5">
                {buildSharedTree(sharedWithMe).map((n) => (
                  <SharedNode
                    key={`${n.owner}:${n.path}`}
                    node={n}
                    depth={0}
                    selectedPath={openPath}
                    activePath={activePath}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tags live above the file tree so they stay reachable even when
            the vault grows to hundreds of files. Collapsed by default. */}
        {!filter.trim() && tags && tags.length > 0 && (
          <div className="mb-2 mx-1">
            <button
              className="w-full flex items-center gap-1 px-2 h-6 text-[10.5px] uppercase tracking-wider font-semibold text-subtle hover:bg-hover rounded"
              onClick={() => setTagsOpen((v) => !v)}
            >
              <ChevronRight
                size={11}
                className="transition-transform"
                style={{ transform: tagsOpen ? 'rotate(90deg)' : undefined }}
              />
              Tags
              <span className="text-subtle font-normal normal-case ml-1">({tags.length})</span>
            </button>
            {tagsOpen && (
              <>
                {tags.length > 12 && (
                  <input
                    className="w-full mt-1 mb-1 px-2 h-6 rounded text-[11.5px] outline-none"
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      color: 'var(--fg)',
                    }}
                    placeholder={`Filter ${tags.length} tags…`}
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                  />
                )}
                <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                  {(() => {
                    const q = tagFilter.trim().toLowerCase()
                    const filtered = q
                      ? tags.filter((t) => t.tag.includes(q))
                      : tags
                    const slice = filtered.slice(0, 200)
                    if (filtered.length === 0) {
                      return (
                        <div className="px-2 py-1 text-[11px] text-subtle">
                          No tags match "{tagFilter}"
                        </div>
                      )
                    }
                    return (
                      <>
                        {slice.map((t) => {
                          const isActive = activeTag === t.tag
                          return (
                            <button
                              key={t.tag}
                              onClick={() => navigate(`/tags/${encodeURIComponent(t.tag)}`)}
                              className={clsx(
                                'w-full flex items-center gap-2 pl-7 pr-2 h-7 rounded text-[12.5px] text-left',
                                !isActive && 'hover:bg-hover',
                              )}
                              style={{
                                background: isActive ? 'var(--selected)' : 'transparent',
                                color: isActive ? 'var(--accent)' : 'var(--fg)',
                              }}
                            >
                              <Tag size={11} className={isActive ? 'text-accent' : 'text-muted'} />
                              <span className="truncate flex-1">{t.tag}</span>
                              <span className="text-[10.5px] text-subtle">{t.count}</span>
                            </button>
                          )
                        })}
                        {filtered.length > slice.length && (
                          <div className="px-2 py-1 text-[10.5px] text-subtle">
                            …and {filtered.length - slice.length} more — refine the filter
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              </>
            )}
          </div>
        )}

        {/* When filtering, render two flat sections — Tag names (click → tag
            view) and File matches (click → doc viewer). The user explicitly
            wants typing in this input to surface tag pages themselves, not
            just files that carry the tag. */}
        {filter.trim() ? (
          (() => {
            const q = filter.trim().toLowerCase()
            const matchedTags = (tags ?? []).filter((t) => t.tag.includes(q)).slice(0, 8)
            if (searchHits == null && searching && matchedTags.length === 0) {
              return (
                <div className="px-3 py-2 text-[12.5px] text-muted flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Searching…
                </div>
              )
            }
            if (
              matchedTags.length === 0 &&
              searchFolders.length === 0 &&
              (!searchHits || searchHits.length === 0)
            ) {
              return (
                <div className="px-3 py-2 text-[12.5px] text-subtle">No matches for "{filter}"</div>
              )
            }
            return (
              <div className="space-y-2">
                {searchFolders.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                      Folders
                    </div>
                    {searchFolders.map((f) => (
                      <button
                        key={`${f.owner}:${f.path}`}
                        onClick={() => {
                          const segs = f.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
                          const suffix =
                            f.owner && f.owner !== currentUsername
                              ? `?owner=${encodeURIComponent(f.owner)}`
                              : ''
                          navigate(`${segs ? `/${segs}` : '/'}${suffix}`)
                          setFilter('')
                        }}
                        className="w-full flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-left text-fg hover:bg-hover"
                        title={f.path}
                      >
                        <Folder size={11} className="text-accent shrink-0" />
                        <span className="truncate flex-1">{f.name}</span>
                        <span className="text-[10.5px] text-subtle truncate" style={{ maxWidth: 120 }}>
                          {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {matchedTags.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                      Tags
                    </div>
                    {matchedTags.map((t) => {
                      const isActive = activeTag === t.tag
                      return (
                        <button
                          key={t.tag}
                          onClick={() => navigate(`/tags/${encodeURIComponent(t.tag)}`)}
                          className={clsx(
                            'w-full flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-left',
                            !isActive && 'hover:bg-hover',
                          )}
                          style={{
                            background: isActive ? 'var(--selected)' : 'transparent',
                            color: isActive ? 'var(--accent)' : 'var(--fg)',
                          }}
                          title={`#${t.tag}`}
                        >
                          <Tag size={11} className={isActive ? 'text-accent' : 'text-muted'} />
                          <span className="truncate flex-1">{t.tag}</span>
                          <span className="text-[10.5px] text-subtle">{t.count}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
                {searchHits && searchHits.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                      Files
                    </div>
                    {searchHits.map((h) => {
                      const isActive = openPath === h.path
                      return (
                        <button
                          key={`${h.owner}:${h.path}`}
                          onClick={() => {
                            const segs = h.path.split('/').map(encodeURIComponent).join('/')
                            const suffix =
                              h.owner && h.owner !== currentUsername
                                ? `?owner=${encodeURIComponent(h.owner)}`
                                : ''
                            navigate(`/${segs}${suffix}`)
                          }}
                          className={clsx(
                            'w-full flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-left',
                            !isActive && 'hover:bg-hover',
                          )}
                          style={{
                            background: isActive ? 'var(--selected)' : 'transparent',
                            color: isActive ? 'var(--accent)' : 'var(--fg)',
                          }}
                          title={h.path}
                        >
                          <FileText size={11} className={isActive ? 'text-accent' : 'text-muted'} />
                          <span className="truncate flex-1">{h.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })()
        ) : !tree ? (
          <div className="px-3 py-2 text-[12.5px] text-muted">Loading…</div>
        ) : tree.length === 0 ? null : (
          tree.map((node) => (
            <VaultTree
              key={node.path}
              node={node}
              depth={0}
              selectedPath={openPath}
              activePath={activePath}
            />
          ))
        )}

        {(uploadingName || vaultError || error) && (
          <div className="mt-2 mx-1 space-y-1.5">
            {uploadingName && (
              <div
                className="px-3 py-2 rounded text-[12.5px] flex items-center gap-2"
                style={{ background: 'var(--accent-bg)', color: 'var(--fg)' }}
              >
                <Loader2 size={13} className="animate-spin text-accent" />
                <span className="truncate">
                  Uploading <span className="font-medium">{uploadingName}</span>…
                </span>
              </div>
            )}
            {(vaultError || error) && (
              <div
                className="px-3 py-2 rounded text-[12.5px] flex items-center gap-2"
                style={{ background: '#FFEBE6', color: '#BF2600' }}
              >
                <AlertCircle size={13} />
                <span className="flex-1 truncate">{vaultError || error}</span>
                <button
                  onClick={() => {
                    setError(null)
                    clearError()
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

type SharedShare = {
  id: string
  owner: string
  storageKey: string
  isFolder: boolean
  canEdit: boolean
  name: string
  ext: string
  embedded: boolean
  public: boolean
}

type SharedTreeNode =
  | {
      kind: 'group'
      owner: string
      path: string
      name: string
      children: SharedTreeNode[]
    }
  | {
      kind: 'share-folder' | 'share-file'
      owner: string
      path: string
      name: string
      share: SharedShare
      children: SharedTreeNode[]
    }

/**
 * Group `shared with me` items so they read like a real tree:
 *
 *   investments/                   ← group (no grant — visual only)
 *     cdsl/                        ← share (folder)
 *     exchanges/                   ← share (folder)
 *     portfolio-target.md          ← share (file)
 *   2005100123 DEARL TECH…         ← share (file at root)
 *
 * Group nodes are purely client-side; they expand/collapse but don't
 * navigate (the recipient has no grant on the bare `investments` path).
 * Share nodes hand off to VaultTree, which fetches descendants under
 * the share grant.
 */
function buildSharedTree(shares: SharedShare[]): SharedTreeNode[] {
  type Bucket = {
    nodesByPath: Map<string, SharedTreeNode>
    roots: SharedTreeNode[]
  }
  const byOwner = new Map<string, Bucket>()

  for (const s of shares) {
    const segs = s.storageKey.split('/').filter(Boolean)
    let bucket = byOwner.get(s.owner)
    if (!bucket) {
      bucket = { nodesByPath: new Map(), roots: [] }
      byOwner.set(s.owner, bucket)
    }

    // Walk segments, materializing group nodes for any prefix that
    // doesn't already have a share at it. The last segment becomes
    // the share node itself.
    let parent: SharedTreeNode | null = null
    let prefix = ''
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      prefix = prefix ? `${prefix}/${seg}` : seg
      const isLeaf = i === segs.length - 1
      let node = bucket.nodesByPath.get(prefix)
      if (!node) {
        if (isLeaf) {
          node = {
            kind: s.isFolder ? 'share-folder' : 'share-file',
            owner: s.owner,
            path: prefix,
            name: seg,
            share: s,
            children: [],
          }
        } else {
          node = {
            kind: 'group',
            owner: s.owner,
            path: prefix,
            name: seg,
            children: [],
          }
        }
        bucket.nodesByPath.set(prefix, node)
        if (parent) parent.children.push(node)
        else bucket.roots.push(node)
      } else if (isLeaf && node.kind === 'group') {
        // Existing group is actually a share — upgrade in place,
        // keeping any children that were discovered through other
        // shares (e.g. a share on /a and another on /a/b).
        const upgraded: SharedTreeNode = {
          kind: s.isFolder ? 'share-folder' : 'share-file',
          owner: s.owner,
          path: prefix,
          name: seg,
          share: s,
          children: node.children,
        }
        bucket.nodesByPath.set(prefix, upgraded)
        // Swap reference in parent / roots list.
        const list = parent ? parent.children : bucket.roots
        const idx = list.indexOf(node)
        if (idx >= 0) list[idx] = upgraded
        node = upgraded
      }
      parent = node
    }
  }

  const out: SharedTreeNode[] = []
  // Sort folders first within each level, then alphabetical.
  const sort = (nodes: SharedTreeNode[]): SharedTreeNode[] => {
    nodes.forEach((n) => sort(n.children))
    nodes.sort((a, b) => {
      const aIsFile = a.kind === 'share-file'
      const bIsFile = b.kind === 'share-file'
      if (aIsFile !== bIsFile) return aIsFile ? 1 : -1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return nodes
  }
  for (const bucket of byOwner.values()) out.push(...sort(bucket.roots))
  return out
}

/** Render one node in the shared-with-me virtual tree. Group nodes are
 *  client-only collapsible headers; share nodes hand off to VaultTree
 *  (folder) or a navigate-on-click row (file). */
function SharedNode({
  node,
  depth,
  selectedPath,
  activePath,
}: {
  node: SharedTreeNode
  depth: number
  selectedPath: string | null
  activePath: string | null
}) {
  const [open, setOpen] = useState(true)

  if (node.kind === 'share-folder') {
    return (
      <VaultTree
        node={{
          name: node.name,
          path: node.path,
          type: 'dir',
          hasChildren: true,
        }}
        depth={depth}
        selectedPath={selectedPath}
        activePath={activePath}
        owner={node.owner}
      />
    )
  }
  if (node.kind === 'share-file') {
    return (
      <VaultTree
        node={{
          name: node.name,
          path: node.path,
          type: 'file',
          ext: node.share.ext,
          // Surface the owner's indexed/published state so the file
          // share leaf shows the same sparkle + globe the owner sees.
          embedded: node.share.embedded,
          public: node.share.public,
        }}
        depth={depth}
        selectedPath={selectedPath}
        activePath={activePath}
        owner={node.owner}
      />
    )
  }
  // Group node — purely visual. Renders a folder row that expands its
  // children locally without hitting the server.
  return (
    <div>
      <div
        className="tree-item"
        style={{ paddingLeft: 8 + depth * 14, opacity: 0.85 }}
        onClick={() => setOpen((v) => !v)}
        title={`${node.path} · grouping (no direct grant)`}
      >
        {open ? (
          <ChevronRight size={13} className="text-subtle" style={{ transform: 'rotate(90deg)' }} />
        ) : (
          <ChevronRight size={13} className="text-subtle" />
        )}
        <Folder size={14} className="text-subtle" />
        <span className="truncate flex-1 text-subtle">{node.name}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <SharedNode
            key={`${c.owner}:${c.path}`}
            node={c}
            depth={depth + 1}
            selectedPath={selectedPath}
            activePath={activePath}
          />
        ))}
    </div>
  )
}
