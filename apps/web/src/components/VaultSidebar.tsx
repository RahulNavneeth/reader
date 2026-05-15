import { useCallback, useEffect, useState } from 'react'
import { Filter, X, AlertCircle, Loader2, Tag, ChevronRight, FileText } from 'lucide-react'
import clsx from 'clsx'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { VaultTree } from './VaultTree'
import { useVault } from '../lib/vault-context'

type FlatHit = {
  path: string
  name: string
  ext: string
  docId: string
  tags: string[]
  public: boolean
  score: number
  matchedTags: string[]
}

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
  const { uploadFiles, refreshNonce, uploadingName, vaultError, clearError, currentFolder } = useVault()
  const activePath = openPath ?? (currentFolder || null)

  const [tree, setTree] = useState<VaultNode[] | null>(null)
  const [tags, setTags] = useState<Array<{ tag: string; count: number }> | null>(null)
  // Collapsed by default — when the vault grows large the file tree is the
  // primary nav; tags are a secondary index the user expands when needed.
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [searchHits, setSearchHits] = useState<FlatHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const [list, tagsR] = await Promise.all([api.list(''), api.tags().catch(() => ({ tags: [] }))])
      setTree(list.items)
      setTags(tagsR.tags)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refetch()
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
      setSearching(false)
      return
    }
    setSearching(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await api.filesSearch(q, 50)
        if (!cancelled) setSearchHits(r.items)
      } catch {
        if (!cancelled) setSearchHits([])
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
            className="input pl-8 h-7 text-[12.5px]"
            placeholder="Filter files (⌘K for search)…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 btn-ghost h-5 w-5 px-0"
              onClick={() => setFilter('')}
            >
              <X size={11} />
            </button>
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
                                'w-full flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-left',
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
            if (matchedTags.length === 0 && (!searchHits || searchHits.length === 0)) {
              return (
                <div className="px-3 py-2 text-[12.5px] text-subtle">No matches for "{filter}"</div>
              )
            }
            return (
              <div className="space-y-2">
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
                          key={h.path}
                          onClick={() =>
                            navigate('/docs/' + h.path.split('/').map(encodeURIComponent).join('/'))
                          }
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
