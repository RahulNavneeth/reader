import { useEffect, useState } from 'react'
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
  Loader2,
  Lock,
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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    api
      .listExternalMountEntries(mountId, subPath)
      .then((r) => {
        if (cancelled) return
        setData({ mountName: r.mountName, path: r.path, items: r.items })
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

  const openEntry = (entry: Entry) => {
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
        style={{ background: 'var(--panel-2)' }}
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
            border: '1px solid var(--border-soft)',
          }}
          title="External library — server refuses writes under this path"
        >
          <Lock size={9} className="mr-1" /> read-only
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {loading && (
          <div className="flex items-center justify-center h-full text-muted text-[12.5px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        )}

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
            {data.items.map((entry) => (
              <button
                key={entry.path}
                onClick={() => openEntry(entry)}
                className="rounded-lg p-2 text-left hover:bg-hover transition-colors flex flex-col items-center gap-2"
                style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
              >
                <div
                  className="w-full aspect-square rounded-md overflow-hidden flex items-center justify-center"
                  style={{ background: 'var(--bg)' }}
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
                <div className="w-full text-[10.5px] text-subtle">
                  {entry.type === 'dir'
                    ? entry.hasChildren ? 'folder' : 'empty'
                    : formatBytes(entry.size ?? 0)}
                </div>
                {entry.type === 'file' && (
                  <a
                    href={api.externalMountFileUrl(mountId, entry.path)}
                    download={entry.name}
                    onClick={(e) => e.stopPropagation()}
                    className="text-[10.5px] text-accent hover:underline inline-flex items-center gap-1"
                  >
                    <Download size={10} /> download
                  </a>
                )}
              </button>
            ))}
          </div>
        )}
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
