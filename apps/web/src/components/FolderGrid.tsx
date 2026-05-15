import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Folder,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileCode,
  Sparkles,
  Upload,
  Loader2,
  Globe,
  Lock,
  Trash2,
  X,
  CheckSquare,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { PathBreadcrumb } from './PathBreadcrumb'

export function FolderGrid() {
  const navigate = useNavigate()
  const { triggerUpload, refresh, refreshNonce, currentFolder, setCurrentFolder } = useVault()
  const [dir, setDir] = useState<string>(currentFolder)
  const [items, setItems] = useState<VaultNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<null | 'public' | 'private' | 'delete'>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (rel: string) => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.list(rel)
      setItems(r.items)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(dir)
    setCurrentFolder(dir)
    setSelection(new Set())
  }, [dir, load, refreshNonce, setCurrentFolder])

  const onOpen = (node: VaultNode) => {
    if (node.type === 'dir') {
      setDir(node.path)
    } else {
      navigate('/docs/' + node.path.split('/').map(encodeURIComponent).join('/'))
    }
  }

  const toggleSelect = (path: string) => {
    setSelection((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const parent = useMemo(() => {
    if (!dir) return null
    const i = dir.lastIndexOf('/')
    return i < 0 ? '' : dir.slice(0, i)
  }, [dir])

  const selectedPaths = useMemo(() => Array.from(selection), [selection])
  const selectableCount = useMemo(
    () => (items ? items.filter((n) => n.type === 'file').length : 0),
    [items],
  )

  // The selected files' current visibility — drives which of Public/Private to
  // show in the toolbar (avoid offering an action that's a no-op for every
  // selected item).
  const { anyPublic, anyPrivate } = useMemo(() => {
    if (!items) return { anyPublic: false, anyPrivate: false }
    let pub = false
    let priv = false
    for (const n of items) {
      if (n.type !== 'file' || !selection.has(n.path)) continue
      if (n.public) pub = true
      else priv = true
    }
    return { anyPublic: pub, anyPrivate: priv }
  }, [items, selection])

  // Clear selection whenever the user clicks somewhere that isn't a tile or
  // the bulk-actions toolbar — both inside this view (empty grid space) and
  // outside it (sidebar, chat panel, breadcrumb, etc.).
  useEffect(() => {
    if (selection.size === 0) return
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-grid-tile]') || t.closest('[data-grid-toolbar]')) return
      setSelection(new Set())
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(new Set())
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [selection.size])

  const runBulk = async (kind: 'public' | 'private' | 'delete') => {
    if (selectedPaths.length === 0) return
    if (kind === 'delete' && !confirm(`Move ${selectedPaths.length} item${selectedPaths.length === 1 ? '' : 's'} to Trash?`)) {
      return
    }
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'delete') {
        await api.bulkDelete(selectedPaths)
      } else {
        await api.bulkSetVisibility(selectedPaths, kind === 'public')
      }
      setSelection(new Set())
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const selectAll = () => {
    if (!items) return
    setSelection(new Set(items.filter((n) => n.type === 'file').map((n) => n.path)))
  }

  return (
    <div ref={rootRef} className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <div
        data-grid-toolbar=""
        className="flex items-center gap-2 px-3 h-11 border-b shrink-0"
        style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
      >
        <PathBreadcrumb
          dir={dir}
          onNavigate={(p) => setDir(p)}
          onBack={parent !== null ? () => setDir(parent) : undefined}
        />
        <div className="flex-1" />
        {selection.size > 0 ? (
          <>
            <span className="text-[11.5px] text-fg font-medium">
              {selection.size} selected
            </span>
            {anyPrivate && (
              <button
                className="btn-ghost"
                disabled={!!busy}
                onClick={() => runBulk('public')}
                title="Make public"
              >
                {busy === 'public' ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
                Public
              </button>
            )}
            {anyPublic && (
              <button
                className="btn-ghost"
                disabled={!!busy}
                onClick={() => runBulk('private')}
                title="Make private"
              >
                {busy === 'private' ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                Private
              </button>
            )}
            <button
              className="btn-ghost"
              disabled={!!busy}
              onClick={() => runBulk('delete')}
              title="Move to Trash"
              style={{ color: '#BF2600' }}
            >
              {busy === 'delete' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete
            </button>
            <button
              className="btn-ghost h-7 w-7 px-0"
              onClick={() => setSelection(new Set())}
              title="Clear selection"
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <>
            {selectableCount > 0 && (
              <button
                className="btn-ghost"
                onClick={selectAll}
                title="Select all files in this folder"
              >
                <CheckSquare size={13} />
                Select all
              </button>
            )}
            <span className="text-[11.5px] text-subtle">
              {items ? `${items.length} item${items.length === 1 ? '' : 's'}` : ''}
            </span>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading && !items && (
          <div className="flex items-center justify-center h-full text-muted text-[12.5px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        )}

        {error && (
          <div className="text-[12.5px]" style={{ color: '#BF2600' }}>
            {error}
          </div>
        )}

        {items && items.length === 0 && !loading && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div
                className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                style={{ background: 'var(--panel)' }}
              >
                <Upload size={22} className="text-accent" />
              </div>
              <div className="text-fg font-semibold text-[15px]">This folder is empty</div>
              <div className="text-[12.5px] text-muted mt-1 mb-4">
                Drop files anywhere on this page to upload.
              </div>
              <button className="btn-primary" onClick={triggerUpload}>
                <Upload size={14} />
                Upload files
              </button>
            </div>
          </div>
        )}

        {items && items.length > 0 && (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
            {items.map((node) => (
              <GridTile
                key={node.path}
                node={node}
                selected={selection.has(node.path)}
                onOpen={() => onOpen(node)}
                onToggleSelect={() => toggleSelect(node.path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function GridTile({
  node,
  selected,
  onOpen,
  onToggleSelect,
}: {
  node: VaultNode
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
}) {
  const [hover, setHover] = useState(false)
  const isFile = node.type === 'file'
  // Treat any image-y or PDF file as a thumbnail candidate. The endpoint 404s
  // for types it can't render; we fall back to the type icon on error.
  const ext = (node.ext || '').toLowerCase()
  const tryThumb =
    isFile &&
    [
      '.pdf',
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico',
      '.heic', '.heif', '.tiff', '.tif', '.jxl',
      '.mp4', '.mov', '.m4v', '.mkv', '.webm',
      '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
      '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
    ].includes(ext)
  const [thumbFailed, setThumbFailed] = useState(false)

  return (
    <div
      data-grid-tile=""
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        // Cmd/Ctrl-click toggles selection; plain click opens.
        if ((e.metaKey || e.ctrlKey) && isFile) {
          e.preventDefault()
          onToggleSelect()
          return
        }
        onOpen()
      }}
      className="group relative flex flex-col items-center justify-start gap-2 p-3 rounded-md transition-colors text-left cursor-pointer"
      style={{
        background: selected ? 'var(--selected)' : hover ? 'var(--border)' : 'transparent',
        outline: selected ? '1px solid var(--accent)' : undefined,
      }}
    >
      {isFile && (hover || selected) && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
          className="absolute top-1.5 left-1.5 w-4 h-4 rounded flex items-center justify-center"
          style={{
            background: selected ? 'var(--accent)' : 'var(--bg)',
            border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
          }}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
      <div className="w-full h-20 flex items-center justify-center overflow-hidden rounded">
        {node.type === 'dir' ? (
          <Folder size={42} className="text-accent" strokeWidth={1.4} />
        ) : tryThumb && !thumbFailed ? (
          <img
            src={api.thumbnailUrl(node.path)}
            alt=""
            className="max-w-full max-h-full object-contain"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <BigTypeIcon ext={node.ext} />
        )}
      </div>
      <div className="w-full text-[11.5px] text-fg text-center leading-tight">
        <span className="line-clamp-2 break-words">{node.name}</span>
        {node.type === 'file' && node.embedded && (
          <Sparkles size={9} className="text-accent inline-block ml-1 align-middle" />
        )}
        {node.type === 'file' && node.public && (
          <Globe size={9} className="inline-block ml-1 align-middle" style={{ color: '#00875A' }} />
        )}
      </div>
    </div>
  )
}

function BigTypeIcon({ ext }: { ext?: string }) {
  const e = (ext || '').toLowerCase()
  const props = { size: 42, strokeWidth: 1.3 } as const
  if (e === '.pdf') return <FileType {...props} className="text-muted" />
  if ([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
  ].includes(e))
    return <FileImage {...props} className="text-muted" />
  if ([
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
    '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
    '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
  ].includes(e))
    return <FileVideo {...props} className="text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(e))
    return <FileCode {...props} className="text-subtle" />
  return <FileText {...props} className="text-subtle" />
}
