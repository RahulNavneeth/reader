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
import { useSidebarSelection } from '../lib/sidebarSelection'

/**
 * Module-level scratchpad holding the current drag's source
 * path(s). dataTransfer reads are blocked in `dragover` for
 * security, but we still need to know what's being dragged to
 * tell whether a hovered folder is a valid target. The source
 * row sets this on drag start, clears on drag end.
 */
const currentDragSrcRef: { path: string; bulk: string[] } = {
  path: '',
  bulk: [],
}

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
  const [dropReject, setDropReject] = useState(false)
  const navigate = useNavigate()
  const { refreshNonce, refresh, setVaultError } = useVault()
  const multiSel = useSidebarSelection()
  const isMultiSelected = multiSel.isSelected(node.path)

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
      // 401 fires at the moment auth is restoring; the bootstrap
      // flow redirects to sign-in on its own. Surfacing the toast
      // would just look like a real error to the user.
      if (!(e instanceof ApiError && e.status === 401)) {
        setVaultError(e instanceof ApiError ? e.message : String(e))
      }
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

  const onClick = async (e: React.MouseEvent) => {
    // Shift-click: toggle multi-select instead of navigating or
    // expanding. Lets the user assemble a bulk selection across
    // folders and drag the whole set in one gesture.
    if (e.shiftKey) {
      if (owner) return // share recipients don't get bulk-move
      e.preventDefault()
      e.stopPropagation()
      multiSel.toggle(node.path)
      return
    }
    // Plain click clears any prior multi-selection and falls
    // through to the normal navigate / expand.
    if (multiSel.selected.size > 0) multiSel.clear()
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
    if (owner) return
    // Folder drag now allowed alongside files. The server's
    // `/api/file/move` accepts either and rewrites every
    // descendant's storageKey when given a folder path.
    // If THIS node is part of a multi-selection (>1 paths),
    // ship the whole set as a JSON array so the drop target can
    // bulk-move. Otherwise just the single path.
    const sel = multiSel.selected
    const isInSel = sel.has(node.path) && sel.size > 1
    if (isInSel) {
      const arr = Array.from(sel)
      e.dataTransfer.setData(
        'application/x-reader-paths',
        JSON.stringify(arr),
      )
      currentDragSrcRef.path = ''
      currentDragSrcRef.bulk = arr
    } else {
      e.dataTransfer.setData('application/x-reader-path', node.path)
      currentDragSrcRef.path = node.path
      currentDragSrcRef.bulk = []
    }
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
    const types = e.dataTransfer.types
    if (
      !types.includes('application/x-reader-path') &&
      !types.includes('application/x-reader-paths')
    ) {
      return
    }
    // Reject self-as-parent and folder-into-self / descendant.
    // We can't read dataTransfer DATA in dragover (browser
    // security), but the dragged path is in the DOM via
    // `data-reader-drag-src` set on the source row at dragStart.
    // Check it to decide whether to show a "won't accept" cue.
    const dragSrc = currentDragSrcRef.path
    const dragBulk = currentDragSrcRef.bulk
    const wouldReject = (() => {
      if (dragSrc) {
        if (node.path === dragSrc) return true
        if (node.path === dragSrc + '/' || node.path.startsWith(dragSrc + '/'))
          return true
        const srcParent = dragSrc.includes('/')
          ? dragSrc.slice(0, dragSrc.lastIndexOf('/'))
          : ''
        if (srcParent === node.path) return true
      }
      if (dragBulk.length > 0) {
        // If every bulk item would be rejected at this target,
        // the whole drop is a no-op.
        const allRejected = dragBulk.every((s) => {
          if (node.path === s) return true
          if (node.path === s + '/' || node.path.startsWith(s + '/')) return true
          const sp = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : ''
          return sp === node.path
        })
        if (allRejected) return true
      }
      return false
    })()
    if (wouldReject) {
      e.dataTransfer.dropEffect = 'none'
      setDropReject(true)
      setDropTarget(false)
      e.preventDefault()
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropReject(false)
    if (!dropTarget) setDropTarget(true)
  }

  const onDragLeave = () => {
    setDropTarget(false)
    setDropReject(false)
  }

  const onDrop = async (e: React.DragEvent) => {
    if (node.type !== 'dir') return
    setDropTarget(false)
    // Bulk move (Cmd-click multi-select): JSON array of paths.
    // Single move: plain string. Both are file OR folder paths
    // — the server's /api/file/move handles either.
    let srcs: string[] = []
    const bulkRaw = e.dataTransfer.getData('application/x-reader-paths')
    if (bulkRaw) {
      try {
        const parsed = JSON.parse(bulkRaw)
        if (Array.isArray(parsed)) srcs = parsed.filter((p): p is string => typeof p === 'string')
      } catch {
        /* fall through to single-path branch */
      }
    }
    if (srcs.length === 0) {
      const single = e.dataTransfer.getData('application/x-reader-path')
      if (single) srcs = [single]
    }
    if (srcs.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    // Refuse drops that would create a cycle (folder into itself
    // or any descendant) or no-op moves (drop into the same
    // parent the file already lives in).
    const targetDir = node.path
    const filtered: { src: string; target: string }[] = []
    for (const src of srcs) {
      const filename = src.split('/').pop()
      if (!filename) continue
      const target = targetDir ? `${targetDir}/${filename}` : filename
      if (src === target) continue
      if (targetDir === src) continue // folder into itself
      if (targetDir === `${src}/` || targetDir.startsWith(src + '/')) continue
      const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
      if (srcParent === targetDir) continue
      filtered.push({ src, target })
    }
    if (filtered.length === 0) return
    try {
      for (const { src, target } of filtered) {
        await api.move(src, target)
      }
      multiSel.clear()
      if (!expanded) {
        setExpanded(true)
        await loadChildren()
      }
      refresh()
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setVaultError(err instanceof ApiError ? err.message : String(err))
      }
    }
  }

  return (
    <div>
      <div
        className={clsx(
          'tree-item group',
          (isSelected || isMultiSelected) && 'selected',
        )}
        style={{
          paddingLeft: 8 + depth * 14,
          // Drag-state visuals (in priority order):
          //   - dropReject: red dashed outline (current target
          //     would refuse the drop — same parent / self /
          //     descendant) so the user knows nothing will move.
          //   - isMultiSelected: accent tint marking the bulk-
          //     drag selection.
          ...(dropReject
            ? {
                outline: '1px dashed var(--danger-fg)',
                outlineOffset: -2,
                cursor: 'not-allowed',
              }
            : isMultiSelected
              ? {
                  background:
                    'color-mix(in srgb, var(--accent) 16%, transparent)',
                  outline: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
                }
              : null),
        }}
        onClick={onClick}
        draggable={!owner}
        onDragStart={onDragStart}
        onDragEnd={() => {
          currentDragSrcRef.path = ''
          currentDragSrcRef.bulk = []
          setDropReject(false)
        }}
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
          {/* +27 accounts for the chevron (13px) + folder icon (14px)
              that sibling rows render before their label — without it
              the "Loading…" / "empty" text reads as flush with where
              child carets would be, not where child labels start. */}
          {loading && (
            <div
              className="text-[12px] text-subtle px-2 py-1"
              style={{ paddingLeft: 8 + (depth + 1) * 14 + 27 }}
            >
              Loading…
            </div>
          )}
          {children && children.length === 0 && !loading && (
            <div
              className="text-[12px] text-subtle px-2 py-1 italic"
              style={{ paddingLeft: 8 + (depth + 1) * 14 + 27 }}
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
