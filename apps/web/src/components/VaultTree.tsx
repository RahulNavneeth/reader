import { useEffect, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileType,
  FileImage,
  FileSpreadsheet,
  FileCode,
  Sparkles,
} from 'lucide-react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { useVault } from '../lib/vault-context'

type Props = {
  node: VaultNode
  depth: number
  /** Selected file path (highlights matching file row). */
  selectedPath: string | null
  /** Auto-expand this branch when activePath is a descendant of `node.path`. */
  activePath: string | null
}

export function VaultTree({ node, depth, selectedPath, activePath }: Props) {
  const isAncestorOfActive =
    node.type === 'dir' &&
    !!activePath &&
    (activePath === node.path || activePath.startsWith(node.path + '/'))
  const [expanded, setExpanded] = useState(isAncestorOfActive)
  const [children, setChildren] = useState<VaultNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  const navigate = useNavigate()
  const { refreshNonce, refresh } = useVault()

  const isSelected = node.type === 'file' && selectedPath === node.path

  // Auto-expand when the active path is inside this folder (e.g. user navigated
  // to a deeper file via URL or via the breadcrumb).
  useEffect(() => {
    if (isAncestorOfActive && !expanded) setExpanded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAncestorOfActive])

  const loadChildren = async () => {
    setLoading(true)
    try {
      const r = await api.list(node.path)
      setChildren(r.items)
    } catch (e) {
      console.error(e)
      setChildren([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (node.type !== 'dir' || !expanded) return
    loadChildren()
    // refetch whenever the global refreshNonce bumps (after uploads, mkdir, etc.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce, expanded])

  const onClick = async () => {
    if (node.type === 'dir') {
      const next = !expanded
      setExpanded(next)
      if (next && children === null) {
        await loadChildren()
      }
    } else {
      navigate(`/docs/${node.path.split('/').map(encodeURIComponent).join('/')}`)
    }
  }

  const onDragStart = (e: React.DragEvent) => {
    if (node.type !== 'file') return
    e.dataTransfer.setData('application/x-reader-path', node.path)
    e.dataTransfer.effectAllowed = 'move'
    // Use the row itself as the drag image, anchored to where the cursor
    // actually grabbed it, so the preview follows the pointer instead of
    // floating off to one side.
    if (e.currentTarget instanceof HTMLElement) {
      const target = e.currentTarget
      const rect = target.getBoundingClientRect()
      const offsetX = e.clientX - rect.left
      const offsetY = e.clientY - rect.top
      e.dataTransfer.setDragImage(target, offsetX, offsetY)
    }
  }

  const onDragOver = (e: React.DragEvent) => {
    if (node.type !== 'dir') return
    if (!e.dataTransfer.types.includes('application/x-reader-path')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dropTarget) setDropTarget(true)
  }

  const onDragLeave = () => setDropTarget(false)

  const onDrop = async (e: React.DragEvent) => {
    if (node.type !== 'dir') return
    setDropTarget(false)
    const src = e.dataTransfer.getData('application/x-reader-path')
    if (!src) return
    e.preventDefault()
    e.stopPropagation()
    const filename = src.split('/').pop()
    if (!filename) return
    const target = node.path ? `${node.path}/${filename}` : filename
    if (src === target) return
    // Bail if dropping a file into its own current directory.
    const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
    if (srcParent === node.path) return
    try {
      await api.move(src, target)
      if (!expanded) {
        setExpanded(true)
        await loadChildren()
      }
      refresh()
    } catch (err) {
      console.error(err instanceof ApiError ? err.message : err)
    }
  }

  return (
    <div>
      <div
        className={clsx('tree-item', isSelected && 'selected')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        draggable={node.type === 'file'}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {node.type === 'dir' ? (
          <>
            {expanded ? (
              <ChevronDown size={13} className="text-subtle" />
            ) : (
              <ChevronRight size={13} className="text-subtle" />
            )}
            {expanded ? (
              <FolderOpen size={14} className="text-accent" />
            ) : (
              <Folder size={14} className="text-muted" />
            )}
          </>
        ) : (
          <>
            <span className="w-[13px] inline-block" />
            <TypeIcon ext={node.ext} selected={isSelected} />
          </>
        )}
        <span className="truncate flex-1">{node.name}</span>
        {node.type === 'file' && node.embedded && (
          <Sparkles size={11} className="text-accent shrink-0" aria-label="indexed for AI search" />
        )}
      </div>
      {dropTarget && (
        <div className="drop-indicator" style={{ marginLeft: 8 + (depth + 1) * 14 }} />
      )}
      {expanded && (
        <div>
          {loading && (
            <div
              className="text-[12px] text-subtle px-2 py-1"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              Loading…
            </div>
          )}
          {children && children.length === 0 && !loading && (
            <div
              className="text-[12px] text-subtle px-2 py-1 italic"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              empty
            </div>
          )}
          {children?.map((c) => (
            <VaultTree
              key={c.path}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              activePath={activePath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TypeIcon({ ext, selected }: { ext?: string; selected: boolean }) {
  const cls = clsx('shrink-0', selected ? 'text-accent' : 'text-subtle')
  const e = (ext || '').toLowerCase()
  if (e === '.pdf') return <FileType size={14} className={clsx('shrink-0', selected ? 'text-accent' : 'text-muted')} />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(e))
    return <FileImage size={14} className={clsx('shrink-0', selected ? 'text-accent' : 'text-muted')} />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet size={14} className={clsx('shrink-0', selected ? 'text-accent' : 'text-muted')} style={{ color: selected ? undefined : '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(e))
    return <FileCode size={14} className={cls} />
  return <FileText size={14} className={cls} />
}
