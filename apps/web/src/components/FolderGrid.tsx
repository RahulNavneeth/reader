import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Folder,
  FileText,
  FileType,
  FileImage,
  FileSpreadsheet,
  FileCode,
  Sparkles,
  Upload,
  Loader2,
  Globe,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { PathBreadcrumb } from './PathBreadcrumb'

export function FolderGrid() {
  const navigate = useNavigate()
  const { triggerUpload, refreshNonce, currentFolder, setCurrentFolder } = useVault()
  const [dir, setDir] = useState<string>(currentFolder)
  const [items, setItems] = useState<VaultNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  }, [dir, load, refreshNonce, setCurrentFolder])

  const onOpen = (node: VaultNode) => {
    if (node.type === 'dir') {
      setDir(node.path)
    } else {
      navigate('/docs/' + node.path.split('/').map(encodeURIComponent).join('/'))
    }
  }

  const parent = useMemo(() => {
    if (!dir) return null
    const i = dir.lastIndexOf('/')
    return i < 0 ? '' : dir.slice(0, i)
  }, [dir])

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <div
        className="flex items-center gap-2 px-3 h-11 border-b shrink-0"
        style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
      >
        <PathBreadcrumb
          dir={dir}
          onNavigate={(p) => setDir(p)}
          onBack={parent !== null ? () => setDir(parent) : undefined}
        />
        <div className="flex-1" />
        <span className="text-[11.5px] text-subtle">
          {items ? `${items.length} item${items.length === 1 ? '' : 's'}` : ''}
        </span>
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
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
            {items.map((node) => (
              <GridTile key={node.path} node={node} onOpen={() => onOpen(node)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function GridTile({ node, onOpen }: { node: VaultNode; onOpen: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      className="group flex flex-col items-center justify-start gap-2 p-3 rounded-md transition-colors text-left focus:outline-none"
      style={{ background: hover ? 'var(--border)' : 'transparent' }}
    >
      <div className="w-12 h-12 flex items-center justify-center">
        {node.type === 'dir' ? (
          <Folder size={42} className="text-accent" strokeWidth={1.4} />
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
    </button>
  )
}

function BigTypeIcon({ ext }: { ext?: string }) {
  const e = (ext || '').toLowerCase()
  const props = { size: 42, strokeWidth: 1.3 } as const
  if (e === '.pdf') return <FileType {...props} className="text-muted" />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(e))
    return <FileImage {...props} className="text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(e))
    return <FileCode {...props} className="text-subtle" />
  return <FileText {...props} className="text-subtle" />
}
