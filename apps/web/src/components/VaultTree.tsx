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
  ArrowRight,
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
  /** When set, the tree belongs to another user's vault (shared-with-me).
   *  Every list/list-children call goes out with `?owner=<owner>` and
   *  file navigation preserves it too, so the recipient stays in the
   *  share context. Mutations (drag-to-move) are disabled. */
  owner?: string
}

export function VaultTree({ node, depth, selectedPath, activePath, owner }: Props) {
  const isAncestorOfActive =
    node.type === 'dir' &&
    !!activePath &&
    (activePath === node.path || activePath.startsWith(node.path + '/'))
  const [expanded, setExpanded] = useState(isAncestorOfActive)
  const [children, setChildren] = useState<VaultNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  const navigate = useNavigate()
  const { refreshNonce, refresh, setVaultError } = useVault()

  const isSelected = node.type === 'file' && selectedPath === node.path

  // Auto-expand when the active path is inside this folder (e.g. user navigated
  // to a deeper file via URL or via the breadcrumb).
  useEffect(() => {
    if (isAncestorOfActive && !expanded) setExpanded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAncestorOfActive])

  // `silent` skips the spinner placeholder so refresh-driven refetches don't
  // briefly blank out an already-populated folder (visible as flicker when
  // the sidebar refreshes on SSE events like visibility toggles).
  const loadChildren = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await api.list(node.path, owner ? { owner } : undefined)
      // Only replace state when the data actually changed — keeps the same
      // array reference for identical payloads and avoids re-rendering every
      // child row on every event.
      setChildren((prev) =>
        prev && JSON.stringify(prev) === JSON.stringify(r.items) ? prev : r.items,
      )
    } catch (e) {
      setVaultError(e instanceof ApiError ? e.message : String(e))
      setChildren((prev) => (prev ? prev : []))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // Initial expansion: load with spinner.
  useEffect(() => {
    if (node.type !== 'dir' || !expanded) return
    if (children === null) {
      loadChildren(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  // Refresh-driven refetch: silent (no spinner), only when this folder is
  // already populated. Avoids the "every expanded folder flashes Loading…"
  // cascade on each SSE event.
  useEffect(() => {
    if (node.type !== 'dir' || !expanded) return
    if (children === null) return
    loadChildren(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  const onClick = async () => {
    if (node.type === 'dir') {
      const next = !expanded
      setExpanded(next)
      if (next && children === null) {
        await loadChildren()
      }
    } else {
      const segs = node.path.split('/').map(encodeURIComponent).join('/')
      const suffix = owner ? `?owner=${encodeURIComponent(owner)}` : ''
      navigate(`/${segs}${suffix}`)
    }
  }

  const onDragStart = (e: React.DragEvent) => {
    // Drag-to-move is owner-only — share recipients can't restructure
    // someone else's vault.
    if (node.type !== 'file' || owner) return
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
    if (node.type !== 'dir' || owner) return
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
      setVaultError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div>
      <div
        className={clsx('tree-item group', isSelected && 'selected')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        draggable={node.type === 'file' && !owner}
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
        {/* Folder rows get a hover-only arrow that navigates INTO the
            folder (folder name click stays bound to expand/collapse).
            Without this, opening a folder's page from the sidebar
            required clicking a file inside it first. */}
        {node.type === 'dir' && (
          <button
            className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center w-5 h-5 rounded shrink-0 hover:bg-hover transition-opacity"
            onClick={(e) => {
              e.stopPropagation()
              const segs = node.path.split('/').map(encodeURIComponent).join('/')
              const suffix = owner ? `?owner=${encodeURIComponent(owner)}` : ''
              navigate(`/${segs}${suffix}`)
            }}
            title="Open folder"
            aria-label={`Open ${node.name}`}
          >
            <ArrowRight size={11} className="text-accent" />
          </button>
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
              owner={owner}
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
