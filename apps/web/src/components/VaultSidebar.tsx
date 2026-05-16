import { useCallback, useEffect, useState } from 'react'
import { Filter, X, AlertCircle, Loader2, Tag, ChevronRight, FileText, Folder, Bookmark, Save, HardDrive, User as UserIcon } from 'lucide-react'
import clsx from 'clsx'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { VaultTree } from './VaultTree'
import { useVault } from '../lib/vault-context'
import { useConfirm, usePrompt } from '../lib/confirm'

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
  const { uploadFiles, refreshNonce, vaultError, clearError, currentFolder, currentUsername, mobileSidebarOpen, setMobileSidebarOpen } = useVault()
  const confirm = useConfirm()
  const prompt = usePrompt()
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
  const [pins, setPins] = useState<
    Array<{
      owner: string
      storageKey: string
      isFolder: boolean
      pinnedAt: number
      label?: string
    }>
  >([])
  const [pinsOpen, setPinsOpen] = useState(true)
  const [externalMounts, setExternalMounts] = useState<
    Array<{ id: string; name: string; hint: string }>
  >([])
  const [mountsOpen, setMountsOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [searchHits, setSearchHits] = useState<FlatHit[] | null>(null)
  const [searchFolders, setSearchFolders] = useState<FolderHit[]>([])
  const [searching, setSearching] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const [list, tagsR, viewsR, sharesR, pinsR, mountsR] = await Promise.all([
        api.list(''),
        api.tags().catch(() => ({ tags: [] })),
        api.listViews().catch(() => ({ views: [] })),
        api.listUserSharesTo().catch(() => ({ shares: [] })),
        api.listPins().catch(() => ({ pins: [] })),
        api.listExternalMounts().catch(() => ({ mounts: [] })),
      ])
      setTree((prev) => (sameJson(prev, list.items) ? prev : list.items))
      setTags((prev) => (sameJson(prev, tagsR.tags) ? prev : tagsR.tags))
      setViews((prev) => (sameJson(prev, viewsR.views) ? prev : viewsR.views))
      setSharedWithMe((prev) =>
        sameJson(prev, sharesR.shares) ? prev : (sharesR.shares as typeof prev),
      )
      setPins((prev) => (sameJson(prev, pinsR.pins) ? prev : pinsR.pins))
      setExternalMounts((prev) =>
        sameJson(prev, mountsR.mounts) ? prev : mountsR.mounts,
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
    <>
      {/* Mobile backdrop — only renders on small screens when the
          drawer is open. Click to dismiss. */}
      {mobileSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(9,30,66,0.42)' }}
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={clsx(
          'panel border-r border-app overflow-y-auto flex flex-col',
          // Mobile: fixed-position drawer that slides in from the left.
          // Desktop: in-flow column at 320px.
          'md:static md:translate-x-0 md:w-[320px] md:shrink-0',
          'fixed inset-y-0 left-0 z-40 w-[85vw] max-w-[320px] transition-transform',
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
      <div
        className="h-11 px-2 flex items-center border-b sticky top-0 z-10"
        style={{ background: 'var(--panel)', borderColor: 'var(--border-soft)' }}
      >
        <div className="relative w-full">
          <Filter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
          <input
            className="input pl-8 pr-7 h-7 text-[12.5px]"
            placeholder="Filter files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <>
              <button
                className="absolute right-7 top-1/2 -translate-y-1/2 btn-ghost h-5 w-5 px-0"
                onClick={async () => {
                  const name = await prompt({
                    title: 'Save filter as view',
                    message: 'Re-apply this filter later with one click.',
                    placeholder: 'View name',
                    confirmLabel: 'Save',
                  })
                  if (!name) return
                  try {
                    await api.createView({ name, query: filter.trim() })
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
              <span className="text-subtle font-semibold ml-auto">{views.length}</span>
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
                        const ok = await confirm({
                          title: 'Delete view',
                          message: `Remove "${v.name}" from your saved views? The underlying filter / tag isn't affected.`,
                          confirmLabel: 'Delete',
                          destructive: true,
                        })
                        if (!ok) return
                        try {
                          await api.deleteView(v.id)
                          refetch()
                        } catch (e) {
                          setError(e instanceof ApiError ? e.message : String(e))
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

        {/* Pinned items. Click opens the file/folder viewer. Threads
            ?owner=<owner> when the pinned path lives in another user's
            namespace (shared item). */}
        {!filter.trim() && pins.length > 0 && (
          <div className="mb-2 mx-1">
            <button
              className="w-full flex items-center gap-1 px-2 h-6 text-[10.5px] uppercase tracking-wider font-semibold text-subtle hover:bg-hover rounded"
              onClick={() => setPinsOpen((v) => !v)}
            >
              <ChevronRight
                size={11}
                className="transition-transform"
                style={{ transform: pinsOpen ? 'rotate(90deg)' : undefined }}
              />
              Pinned
              <span className="text-subtle font-semibold ml-auto">{pins.length}</span>
            </button>
            {pinsOpen && (
              <div className="mt-0.5 space-y-0.5">
                {pins.map((p) => {
                  const segs = p.storageKey.split('/').map(encodeURIComponent).join('/')
                  const suffix =
                    p.owner !== currentUsername
                      ? `?owner=${encodeURIComponent(p.owner)}`
                      : ''
                  const target = `/${segs}${suffix}`
                  const isActive = openPath === p.storageKey
                  const name = p.label || p.storageKey.split('/').pop() || p.storageKey
                  return (
                    <button
                      key={`${p.owner}:${p.storageKey}`}
                      onClick={() => navigate(target)}
                      className={clsx(
                        'w-full flex items-center gap-2 pl-7 pr-2 h-7 rounded text-[12.5px] text-left',
                        !isActive && 'hover:bg-hover',
                      )}
                      style={{
                        background: isActive ? 'var(--selected)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--fg)',
                      }}
                      title={`${p.owner}:${p.storageKey}`}
                    >
                      {p.isFolder ? (
                        <Folder
                          size={12}
                          className={isActive ? 'text-accent' : 'text-accent'}
                        />
                      ) : (
                        <FileText
                          size={12}
                          className={isActive ? 'text-accent' : 'text-muted'}
                        />
                      )}
                      <span className="truncate flex-1">{name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* External mounts — admin-configured read-only library roots. */}
        {!filter.trim() && externalMounts.length > 0 && (
          <div className="mb-2 mx-1">
            <button
              className="w-full flex items-center gap-1 px-2 h-6 text-[10.5px] uppercase tracking-wider font-semibold text-subtle hover:bg-hover rounded"
              onClick={() => setMountsOpen((v) => !v)}
            >
              <ChevronRight
                size={11}
                className="transition-transform"
                style={{ transform: mountsOpen ? 'rotate(90deg)' : undefined }}
              />
              Libraries
              <span className="text-subtle font-semibold ml-auto">
                {externalMounts.length}
              </span>
            </button>
            {mountsOpen && (
              <div className="mt-0.5 space-y-0.5">
                {externalMounts.map((m) => {
                  const target = `/library/${encodeURIComponent(m.id)}`
                  const isActive = location.pathname.startsWith(target)
                  return (
                    <button
                      key={m.id}
                      onClick={() => navigate(target)}
                      className={clsx(
                        'w-full flex items-center gap-2 pl-7 pr-2 h-7 rounded text-[12.5px] text-left',
                        !isActive && 'hover:bg-hover',
                      )}
                      style={{
                        background: isActive ? 'var(--selected)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--fg)',
                      }}
                      title={`Read-only: ${m.hint}`}
                    >
                      <HardDrive
                        size={11}
                        className={isActive ? 'text-accent' : 'text-subtle'}
                      />
                      <span className="truncate flex-1">{m.name}</span>
                      <span className="text-[10px] text-subtle">read-only</span>
                    </button>
                  )
                })}
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
              <span className="text-subtle font-semibold ml-auto">
                {sharedWithMe.length}
              </span>
            </button>
            {sharedOpen && (
              <div className="mt-0.5 space-y-1">
                {buildSharedTree(sharedWithMe).map((g) => (
                  <SharedOwnerSection
                    key={g.owner}
                    group={g}
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
              <span className="text-subtle font-semibold ml-auto">{tags.length}</span>
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
            // Split each hit list into own (caller's vault) vs shared
            // (cross-owner). The own slices keep the existing flat
            // sections; shared slices are bucketed by owner so the
            // recipient sees `SHARED · alice` / `SHARED · bob` groups
            // matching the Shared-with-me sidebar pattern.
            const ownFolders = searchFolders.filter((f) => f.owner === currentUsername)
            const ownHits = (searchHits ?? []).filter((h) => h.owner === currentUsername)
            const sharedFolders = searchFolders.filter((f) => f.owner !== currentUsername)
            const sharedHits = (searchHits ?? []).filter((h) => h.owner !== currentUsername)
            const sharedByOwner = new Map<
              string,
              { folders: FolderHit[]; files: FlatHit[] }
            >()
            for (const f of sharedFolders) {
              const b = sharedByOwner.get(f.owner) ?? { folders: [], files: [] }
              b.folders.push(f)
              sharedByOwner.set(f.owner, b)
            }
            for (const h of sharedHits) {
              const b = sharedByOwner.get(h.owner) ?? { folders: [], files: [] }
              b.files.push(h)
              sharedByOwner.set(h.owner, b)
            }
            const sharedOwners = Array.from(sharedByOwner.keys()).sort((a, b) =>
              a.localeCompare(b, undefined, { sensitivity: 'base' }),
            )

            const openFolderHit = (f: FolderHit) => {
              const segs = f.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
              const suffix =
                f.owner && f.owner !== currentUsername
                  ? `?owner=${encodeURIComponent(f.owner)}`
                  : ''
              navigate(`${segs ? `/${segs}` : '/'}${suffix}`)
              setFilter('')
            }
            const openFileHit = (h: FlatHit) => {
              const segs = h.path.split('/').map(encodeURIComponent).join('/')
              const suffix =
                h.owner && h.owner !== currentUsername
                  ? `?owner=${encodeURIComponent(h.owner)}`
                  : ''
              navigate(`/${segs}${suffix}`)
            }

            return (
              <div className="space-y-2">
                {ownFolders.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                      Folders
                    </div>
                    {ownFolders.map((f) => (
                      <FolderHitRow
                        key={`${f.owner}:${f.path}`}
                        hit={f}
                        onOpen={openFolderHit}
                      />
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
                {ownHits.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                      Files
                    </div>
                    {ownHits.map((h) => (
                      <FileHitRow
                        key={`${h.owner}:${h.path}`}
                        hit={h}
                        isActive={openPath === h.path}
                        onOpen={openFileHit}
                      />
                    ))}
                  </div>
                )}
                {/* One block per sharer for cross-owner matches. Mirrors
                    the Shared-with-me sidebar grouping so the user
                    always knows which results came from where. */}
                {sharedOwners.map((owner) => {
                  const b = sharedByOwner.get(owner)!
                  const count = b.folders.length + b.files.length
                  return (
                    <div key={owner} className="space-y-0.5">
                      <div className="flex items-center gap-1.5 px-2 pt-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                        <span>Shared · {owner}</span>
                        <span className="ml-auto">{count}</span>
                      </div>
                      {b.folders.map((f) => (
                        <FolderHitRow
                          key={`${f.owner}:${f.path}`}
                          hit={f}
                          onOpen={openFolderHit}
                        />
                      ))}
                      {b.files.map((h) => (
                        <FileHitRow
                          key={`${h.owner}:${h.path}`}
                          hit={h}
                          isActive={openPath === h.path}
                          onOpen={openFileHit}
                        />
                      ))}
                    </div>
                  )
                })}
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

        {(vaultError || error) && (
          <div className="mt-2 mx-1 space-y-1.5">
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
    </>
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

export type SharedOwnerGroup = {
  owner: string
  /** Total leaf shares from this owner (files + folder roots), used in
   *  the header chip — gives the user a fast "X items from alice" cue. */
  shareCount: number
  /** Trees under this owner, identical shape to the legacy flat output. */
  trees: SharedTreeNode[]
}

/**
 * Group `shared with me` items by the user who shared them, then by
 * the in-vault path hierarchy under each:
 *
 *   alice  (2)
 *     investments/                   ← path-group (no grant — visual only)
 *       cdsl/                        ← share (folder)
 *       portfolio-target.md          ← share (file)
 *   bob    (1)
 *     2005100123 DEARL TECH…         ← share (file at root)
 *
 * Two-level grouping: outer = owner (so a recipient with many sharers
 * can tell who shared what at a glance); inner = path hierarchy
 * (same as before — folder ancestors group their children visually).
 * Group nodes are client-only and don't navigate.
 */
function buildSharedTree(shares: SharedShare[]): SharedOwnerGroup[] {
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
  // Outer order: alphabetical by owner so the list is stable across
  // re-renders. Inner order: folder-first inside each owner.
  const owners = Array.from(byOwner.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
  return owners.map((owner) => {
    const bucket = byOwner.get(owner)!
    const trees = sort(bucket.roots)
    // shareCount = number of original share grants this owner gave us
    // (count the leaf share nodes, not transient path-groups).
    const countLeaves = (nodes: SharedTreeNode[]): number =>
      nodes.reduce(
        (acc, n) =>
          acc +
          (n.kind === 'share-file' || n.kind === 'share-folder' ? 1 : 0) +
          countLeaves(n.children),
        0,
      )
    return { owner, shareCount: countLeaves(trees), trees }
  })
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

/** Header row for a single sharer, with their items nested underneath.
 *  Always renders the owner row (even when there's only one sharer) so
 *  the recipient always knows who shared what — that was the whole
 *  motivation for this restructure. */
function SharedOwnerSection({
  group,
  selectedPath,
  activePath,
}: {
  group: SharedOwnerGroup
  selectedPath: string | null
  activePath: string | null
}) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div
        className="flex items-center gap-1.5 pl-7 pr-2 h-6 rounded text-[10.5px] uppercase tracking-wider font-semibold text-subtle hover:bg-hover cursor-pointer"
        onClick={() => setOpen((v) => !v)}
        title={`Shared by ${group.owner}`}
      >
        <ChevronRight
          size={10}
          className="text-subtle transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        />
        <UserIcon size={10} className="text-subtle" />
        <span className="truncate flex-1">{group.owner}</span>
        <span className="text-subtle font-semibold ml-auto">{group.shareCount}</span>
      </div>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {group.trees.map((n) => (
            <SharedNode
              key={`${n.owner}:${n.path}`}
              node={n}
              depth={2}
              selectedPath={selectedPath}
              activePath={activePath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FolderHitRow({
  hit,
  onOpen,
}: {
  hit: FolderHit
  onOpen: (h: FolderHit) => void
}) {
  return (
    <button
      onClick={() => onOpen(hit)}
      className="w-full flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-left text-fg hover:bg-hover"
      title={hit.path}
    >
      <Folder size={11} className="text-accent shrink-0" />
      <span className="truncate flex-1">{hit.name}</span>
      <span className="text-[10.5px] text-subtle truncate" style={{ maxWidth: 120 }}>
        {hit.path.includes('/') ? hit.path.slice(0, hit.path.lastIndexOf('/')) : ''}
      </span>
    </button>
  )
}

function FileHitRow({
  hit,
  isActive,
  onOpen,
}: {
  hit: FlatHit
  isActive: boolean
  onOpen: (h: FlatHit) => void
}) {
  return (
    <button
      onClick={() => onOpen(hit)}
      className={clsx(
        'w-full flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-left',
        !isActive && 'hover:bg-hover',
      )}
      style={{
        background: isActive ? 'var(--selected)' : 'transparent',
        color: isActive ? 'var(--accent)' : 'var(--fg)',
      }}
      title={hit.path}
    >
      <FileText size={11} className={isActive ? 'text-accent' : 'text-muted'} />
      <span className="truncate flex-1">{hit.name}</span>
    </button>
  )
}
