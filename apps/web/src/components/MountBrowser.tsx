import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Folder,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileCode,
  Download,
  ChevronLeft,
  HardDrive,
  Lock,
  Loader2,
  X,
  ArrowDownToLine,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Entry = {
  name: string
  path: string
  type: 'dir' | 'file'
  ext?: string
  size?: number
  mtime?: number
  hasChildren?: boolean
}

/**
 * Read-only browser for an admin-configured external library mount.
 * Mirrors FolderGrid's visual language but strips every mutation —
 * no upload, no tags, no public toggle, no delete. The server-side
 * route refuses writes regardless.
 *
 * Wildcard route: /library/:mountId/* → trailing segments are the
 * vault-relative path inside the mount.
 */
export function MountBrowser() {
  const params = useParams()
  const navigate = useNavigate()
  const mountId = params.mountId as string
  const subPath = (params['*'] || '').replace(/^\/+|\/+$/g, '')

  const [data, setData] = useState<{
    mountName: string
    path: string
    items: Entry[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Stale-while-revalidate: keep showing the previous folder's
  // grid until the new request lands, instead of blanking on
  // every navigation. Earlier `setData(null)` per click made the
  // header + grid both flash empty for the duration of the fetch
  // — read as a "flicker" between every folder click. We only
  // clear when the mount itself changes (i.e. user jumped to a
  // different drive); within-mount navigation just swaps items
  // on top of the previous render.
  const lastMountRef = useRef<string>('')
  useEffect(() => {
    let cancelled = false
    const mountChanged = lastMountRef.current !== mountId
    lastMountRef.current = mountId
    if (mountChanged) setData(null)
    setError(null)
    setLoading(true)
    api
      .listExternalMountEntries(mountId, subPath)
      .then((r) => {
        if (cancelled) return
        // sameJson-style identity check so identical payloads
        // don't trigger a re-render of every tile.
        setData((prev) => {
          if (
            prev &&
            prev.path === r.path &&
            prev.mountName === r.mountName &&
            prev.items.length === r.items.length &&
            JSON.stringify(prev.items) === JSON.stringify(r.items)
          ) {
            return prev
          }
          return { mountName: r.mountName, path: r.path, items: r.items }
        })
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mountId, subPath])

  const parentSegments = subPath ? subPath.split('/').filter(Boolean) : []
  const goUp = () => {
    if (parentSegments.length === 0) return
    const parent = parentSegments.slice(0, -1).map(encodeURIComponent).join('/')
    navigate(`/library/${encodeURIComponent(mountId)}${parent ? '/' + parent : ''}`)
  }

  // Bulk-select state for "import to vault". A plain click opens
  // the entry (navigate / new tab). Shift-click (or any modifier)
  // toggles selection — same gesture as the sidebar tree's
  // multi-select. The selection persists across folder navigation
  // within the SAME mount so the user can assemble a cross-folder
  // import in one pass.
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Wipe on mount switch.
  useEffect(() => {
    setSelected(new Set())
  }, [mountId])
  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const [importPickerOpen, setImportPickerOpen] = useState(false)
  const openEntry = (entry: Entry, e?: React.MouseEvent) => {
    if (e && (e.shiftKey || selected.size > 0)) {
      e.preventDefault()
      toggleSelect(entry.path)
      return
    }
    if (entry.type === 'dir') {
      const segs = entry.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
      navigate(`/library/${encodeURIComponent(mountId)}/${segs}`)
    } else {
      // Files open in a new tab via the raw-stream endpoint. No inline
      // viewer yet — extending the existing PathViewer to read from
      // mounts instead of /api/file/raw is a future enhancement.
      window.open(api.externalMountFileUrl(mountId, entry.path), '_blank')
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={parentSegments.length === 0 ? () => navigate('/') : goUp}
          title={parentSegments.length === 0 ? 'Back to vault' : 'Up one level'}
        >
          <ChevronLeft size={14} />
        </button>
        <HardDrive size={13} className="text-muted shrink-0" />
        <button
          className="text-[12.5px] text-fg hover:underline truncate"
          onClick={() => navigate(`/library/${encodeURIComponent(mountId)}`)}
          title={data?.mountName ?? mountId}
        >
          {data?.mountName ?? '…'}
        </button>
        {parentSegments.map((seg, i) => {
          const parts = parentSegments.slice(0, i + 1).map(encodeURIComponent).join('/')
          const isLast = i === parentSegments.length - 1
          return (
            <span key={i} className="flex items-center gap-1.5 min-w-0">
              <span className="text-subtle">/</span>
              {isLast ? (
                <span className="text-[12.5px] text-fg font-medium truncate">{seg}</span>
              ) : (
                <button
                  className="text-[12.5px] text-fg hover:underline truncate"
                  onClick={() => navigate(`/library/${encodeURIComponent(mountId)}/${parts}`)}
                >
                  {seg}
                </button>
              )}
            </span>
          )
        })}
        <div className="flex-1" />
        <span
          className="text-[10.5px] font-medium px-1.5 h-5 rounded inline-flex items-center"
          style={{
            background: 'var(--bg)',
            color: 'var(--fg-subtle)',
            border: '1px solid var(--border)',
          }}
          title="External library — server refuses writes under this path"
        >
          <Lock size={9} className="mr-1" /> read-only
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="px-2 py-4">
            <div className="flex items-center gap-2 text-fg font-semibold mb-1">
              <Lock size={14} style={{ color: '#BF2600' }} /> Couldn't open this folder
            </div>
            <div className="text-[13px] text-muted">{error}</div>
          </div>
        )}

        {data && data.items.length === 0 && !loading && !error && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div
                className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                style={{ background: 'var(--panel)' }}
              >
                <Folder size={22} className="text-subtle" />
              </div>
              <div className="text-fg font-semibold text-[15px]">This folder is empty</div>
            </div>
          </div>
        )}

        {data && data.items.length > 0 && (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
          >
            {data.items.map((entry) => {
              const isSelected = selected.has(entry.path)
              return (
              <button
                key={entry.path}
                onClick={(e) => openEntry(entry, e)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  toggleSelect(entry.path)
                }}
                className="group mount-tile-outer rounded-lg p-2 text-left hover:bg-hover transition-colors flex flex-col items-center gap-2 relative"
                style={{
                  border: isSelected
                    ? '1px solid var(--accent)'
                    : '1px solid var(--border)',
                  boxShadow: isSelected
                    ? '0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)'
                    : undefined,
                }}
              >
                {/* Selection checkbox — hidden by default to
                    keep the grid clean; reveals on hover OR when
                    the tile is selected (selected state needs
                    to stay visible so the user can see what's
                    already in the bulk set). */}
                <span
                  className={
                    'absolute top-1.5 left-1.5 inline-flex items-center justify-center w-4 h-4 rounded text-white transition-opacity ' +
                    (isSelected
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')
                  }
                  style={{
                    background: isSelected
                      ? 'var(--accent)'
                      : 'color-mix(in srgb, var(--panel) 60%, transparent)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSelect(entry.path)
                  }}
                >
                  {isSelected && <span className="text-[10px] leading-none">✓</span>}
                </span>
                <div
                  className="mount-tile-inner w-full aspect-square rounded-md overflow-hidden flex items-center justify-center"
                >
                  {entry.type === 'dir' ? (
                    <Folder size={36} className="text-accent" strokeWidth={1.4} />
                  ) : (
                    <FileIcon ext={entry.ext} />
                  )}
                </div>
                <div className="w-full text-[12px] text-fg truncate" title={entry.name}>
                  {entry.name}
                </div>
                {entry.type === 'dir' ? (
                  <div className="w-full text-[10.5px] text-subtle">
                    {entry.hasChildren ? 'folder' : 'empty'}
                  </div>
                ) : (
                  <div className="w-full flex items-center justify-between gap-2 text-[10.5px]">
                    <span className="text-subtle">{formatBytes(entry.size ?? 0)}</span>
                    <a
                      href={api.externalMountFileUrl(mountId, entry.path)}
                      download={entry.name}
                      onClick={(e) => e.stopPropagation()}
                      className="text-accent hover:underline inline-flex items-center gap-1"
                    >
                      <Download size={10} /> download
                    </a>
                  </div>
                )}
              </button>
              )
            })}
          </div>
        )}
      </div>
      {/* Bulk-import toolbar — appears as a sticky chip at the
          bottom of the viewport whenever the user has selected
          anything. Mirrors FolderGrid's bulk action bar so
          gestures feel consistent. */}
      {selected.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 h-11 rounded"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
          }}
        >
          <span
            className="text-[12.5px] font-medium px-1"
            style={{ color: 'var(--fg)' }}
          >
            {selected.size} selected
          </span>
          <button
            type="button"
            className="h-8 px-3 rounded-md inline-flex items-center gap-1.5 text-[12.5px] font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
            onClick={() => setImportPickerOpen(true)}
          >
            <ArrowDownToLine size={12} />
            Import to vault
          </button>
          <button
            type="button"
            className="btn-ghost h-8 w-8 px-0"
            onClick={() => setSelected(new Set())}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {importPickerOpen && (
        <ImportToVaultDialog
          mountId={mountId}
          paths={Array.from(selected)}
          onCancel={() => setImportPickerOpen(false)}
          onDone={(imported, failed) => {
            setImportPickerOpen(false)
            if (imported > 0) {
              setSelected(new Set())
              if (failed === 0) {
                document.title = `✓ Imported ${imported} item${imported === 1 ? '' : 's'}`
              } else {
                document.title = `Imported ${imported}, ${failed} failed`
              }
              window.setTimeout(() => {
                if (document.title.startsWith('✓') || document.title.startsWith('Imported')) {
                  document.title = 'Reader'
                }
              }, 2500)
            }
          }}
        />
      )}
    </div>
  )
}

function ImportToVaultDialog({
  mountId,
  paths,
  onCancel,
  onDone,
}: {
  mountId: string
  paths: string[]
  onCancel: () => void
  onDone: (imported: number, failed: number) => void
}) {
  const [dest, setDest] = useState('')
  const [folderList, setFolderList] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTimeout(() => folderRef.current?.focus(), 0)
    let cancelled = false
    api
      .folders()
      .then((r) => {
        if (!cancelled) setFolderList(['', ...r.folders])
      })
      .catch(() => {
        if (!cancelled) setFolderList([''])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const cleanDest = dest.trim().replace(/^\/+|\/+$/g, '')
  const matches = (() => {
    const q = cleanDest.toLowerCase()
    if (!q) return folderList.slice(0, 6)
    return folderList.filter((f) => f.toLowerCase().includes(q)).slice(0, 6)
  })()

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      const r = await api.importFromExternalMount(mountId, {
        paths,
        dest: cleanDest,
      })
      onDone(r.imported.length, r.failed.length)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanDest, paths.length])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, black 35%, transparent)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="rounded-md w-[420px] max-w-[92vw] overflow-hidden"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center gap-2 px-3 h-9"
          style={{
            background: 'var(--panel-2)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <ArrowDownToLine size={13} style={{ color: 'var(--fg-muted)' }} />
          <span
            className="text-[12.5px] font-semibold flex-1"
            style={{ color: 'var(--fg)' }}
          >
            Import {paths.length} item{paths.length === 1 ? '' : 's'} to vault
          </span>
          <button
            type="button"
            className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--hover)]"
            onClick={onCancel}
            aria-label="Cancel"
          >
            <X size={12} />
          </button>
        </div>
        <div className="px-3 py-3 flex flex-col gap-3">
          <div>
            <label
              className="block text-[10.5px] uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--subtle)' }}
            >
              Destination folder
            </label>
            <div className="relative">
              <Folder
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--subtle)' }}
              />
              <input
                ref={folderRef}
                type="text"
                value={dest}
                placeholder="(vault root)"
                onChange={(e) => setDest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActiveIdx((i) => Math.min(i + 1, matches.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActiveIdx((i) => Math.max(i - 1, 0))
                  } else if (e.key === 'Tab' && matches[activeIdx] != null) {
                    e.preventDefault()
                    setDest(matches[activeIdx])
                  }
                }}
                disabled={busy}
                className="input pl-8 h-8 text-[13px]"
              />
            </div>
            <div
              className="text-[11px] mt-1.5 flex items-center gap-2"
              style={{ color: 'var(--subtle)' }}
            >
              <span>
                Saving to{' '}
                <code style={{ color: 'var(--fg)' }}>
                  /{cleanDest || '(root)'}
                </code>{' '}
                · Tab to autocomplete · ↑↓ to pick
              </span>
            </div>
            {cleanDest && !folderList.includes(cleanDest) && (
              <div
                className="mt-1 text-[10.5px]"
                style={{ color: 'var(--accent)' }}
              >
                Folder will be created on import.
              </div>
            )}
          </div>
          {matches.length > 0 && (
            <div className="max-h-[180px] overflow-y-auto py-1 -mx-3 border-y" style={{ borderColor: 'var(--border)' }}>
              <div
                className="px-3 pt-1 pb-1 text-[10.5px] uppercase tracking-wider font-semibold"
                style={{ color: 'var(--subtle)' }}
              >
                Folders
              </div>
              {matches.map((m, i) => {
                const isActive = i === activeIdx
                return (
                  <div
                    key={m + i}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => {
                      setDest(m)
                      folderRef.current?.focus()
                    }}
                    className="px-2 py-1.5 mx-1 rounded cursor-pointer flex items-center gap-2"
                    style={{
                      background: isActive ? 'var(--selected)' : 'transparent',
                    }}
                  >
                    <Folder
                      size={13}
                      className="shrink-0"
                      style={{ color: 'var(--accent)' }}
                    />
                    <span
                      className="text-[12.5px] truncate"
                      style={{ color: 'var(--fg)' }}
                    >
                      {m || '(vault root)'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div
            className="text-[11px]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            Files keep their names. Folders become a subtree under{' '}
            <span style={{ color: 'var(--fg)' }}>
              {cleanDest || '(vault root)'}
            </span>
            . Name collisions are auto-suffixed.
          </div>
          {error && (
            <div
              className="text-[11px] px-2 py-1 rounded"
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger-fg)',
              }}
            >
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button
              className="btn-ghost h-7 px-2 text-[12px]"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="h-7 px-2.5 rounded text-[12px] inline-flex items-center gap-1 font-medium"
              style={{
                background: 'var(--accent)',
                color: 'white',
                opacity: busy ? 0.7 : 1,
              }}
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              Import
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FileIcon({ ext }: { ext?: string }) {
  const e = (ext ?? '').toLowerCase()
  const props = { size: 36, strokeWidth: 1.4 } as const
  if (e === '.pdf') return <FileType {...props} className="text-muted" />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.heic', '.heif', '.tiff'].includes(e))
    return <FileImage {...props} className="text-muted" />
  if (['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'].includes(e))
    return <FileVideo {...props} className="text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet {...props} style={{ color: '#40C057' }} />
  if (['.json', '.yaml', '.yml', '.html', '.htm', '.toml', '.xml'].includes(e))
    return <FileCode {...props} className="text-subtle" />
  return <FileText {...props} className="text-subtle" />
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
