import { useEffect, useState } from 'react'
import {
  Tag,
  ChevronLeft,
  Loader2,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileCode,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useVault } from '../lib/vault-context'
import { ApiError, api } from '../lib/api'

type Item = {
  path: string
  name: string
  ext: string
  docId: string
  tags: string[]
  public: boolean
  owner: string
  type: 'file' | 'dir'
}

export function TaggedFilesView() {
  const { tag = '' } = useParams()
  const navigate = useNavigate()
  const { currentUsername } = useVault()
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    api
      .filesByTag(tag)
      .then((r) => {
        if (cancelled) return
        setItems(r.items)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [tag])

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header
        className="flex items-center gap-2 px-3 h-11 border-b shrink-0"
        style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
      >
        <button className="btn-ghost h-7 w-7 px-0" onClick={() => navigate('/')} title="Back to vault">
          <ChevronLeft size={14} />
        </button>
        <Tag size={13} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">#{tag}</span>
        <div className="flex-1" />
        <span className="text-[11.5px] text-subtle">
          {items ? `${items.length} match${items.length === 1 ? '' : 'es'}` : ''}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {items == null && !error && (
          <div className="flex items-center justify-center h-full text-muted text-[12.5px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        )}

        {error && (
          <div className="text-[12.5px]" style={{ color: '#BF2600' }}>
            {error}
          </div>
        )}

        {items && items.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-[12.5px] text-muted">No files tagged with #{tag}.</div>
          </div>
        )}

        {items && items.length > 0 && (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
          >
            {items.map((it) => (
              <TaggedTile
                key={`${it.owner}:${it.path}`}
                item={it}
                onOpen={() => {
                  const segs = it.path.split('/').map(encodeURIComponent).join('/')
                  const suffix =
                    it.owner && it.owner !== currentUsername
                      ? `?owner=${encodeURIComponent(it.owner)}`
                      : ''
                  navigate(`/${segs}${suffix}`)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TaggedTile({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [hover, setHover] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const ext = item.ext
  const tryThumb = [
    '.pdf',
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
    '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
    '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
  ].includes(ext)

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      className="flex flex-col items-center justify-start gap-2 p-3 rounded-md cursor-pointer text-left transition-colors"
      style={{ background: hover ? 'var(--border)' : 'transparent' }}
    >
      <div className="w-full h-20 flex items-center justify-center overflow-hidden rounded">
        {tryThumb && !thumbFailed ? (
          <img
            src={api.thumbnailUrl(item.path)}
            alt=""
            className="max-w-full max-h-full object-contain"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <BigTypeIcon ext={ext} />
        )}
      </div>
      <div className="w-full text-[11.5px] text-fg text-center leading-tight">
        <span className="line-clamp-2 break-words">{item.name}</span>
        <div className="text-[10.5px] text-subtle truncate mt-0.5">{folderOf(item.path)}</div>
      </div>
    </div>
  )
}

function folderOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? 'Vault root' : p.slice(0, i)
}

function BigTypeIcon({ ext }: { ext: string }) {
  const e = ext.toLowerCase()
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
