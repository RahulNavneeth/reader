import { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  Folder,
  Library,
  FileText,
  FileType,
  FileImage,
  FileSpreadsheet,
  FileCode,
  MoreHorizontal,
} from 'lucide-react'

type Props = {
  /** Folder path (vault-relative) used to render breadcrumb chain. "" = root. */
  dir: string
  /** When rendering a file's location, pass the filename — shown as the active non-clickable crumb. */
  currentName?: string
  /** Optional inline element rendered right after `currentName` (e.g. info button). */
  currentAction?: React.ReactNode
  /** Click on a crumb or the Vault link. */
  onNavigate: (dir: string) => void
  /** Click on the back chevron. Disabled if omitted. */
  onBack?: () => void
  /** When set, the breadcrumb is showing another user's vault (shared
   *  context). The root crumb reads "Vault (<owner>)" so the recipient
   *  immediately sees whose vault they're inside. */
  ownerLabel?: string
}

/** Show all crumbs up to this depth; beyond that, collapse the
 *  middle ones behind a "…" popover so the breadcrumb stays on
 *  one line and doesn't push the toolbar actions to a new row.
 *  Vault root + first crumb + (collapsed) + last crumb + filename
 *  fits comfortably on any viewport. */
const MAX_INLINE_CRUMBS = 3

export function PathBreadcrumb({ dir, currentName, currentAction, onNavigate, onBack, ownerLabel }: Props) {
  const parts = dir
    ? dir.split('/').filter(Boolean).map((name, idx, arr) => ({
        name,
        path: arr.slice(0, idx + 1).join('/'),
      }))
    : []

  const canGoBack = !!onBack && (dir.length > 0 || !!currentName)

  // Collapse middle crumbs once the chain gets deeper than the
  // inline budget. Always show the first and last so the user has
  // navigational anchors at both ends.
  const collapsed = parts.length > MAX_INLINE_CRUMBS
  const visibleHead = collapsed ? parts.slice(0, 1) : parts
  const visibleTail = collapsed ? parts.slice(-1) : []
  const hiddenCrumbs = collapsed ? parts.slice(1, -1) : []

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <button
        className="btn-ghost h-7 w-7 px-0 shrink-0"
        disabled={!canGoBack}
        style={{ opacity: canGoBack ? 1 : 0.35 }}
        onClick={() => onBack?.()}
        title="Up one level"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        className="text-[12.5px] font-medium hover:underline text-fg inline-flex items-center gap-1.5 shrink-0"
        onClick={() => onNavigate('')}
        title={ownerLabel ? `${ownerLabel}'s vault` : 'Your vault'}
      >
        <Library size={13} className="text-accent" />
        Vault
        {ownerLabel && <span>({ownerLabel})</span>}
      </button>
      {visibleHead.map((p) => (
        <CrumbButton key={p.path} crumb={p} onNavigate={onNavigate} />
      ))}
      {collapsed && (
        <CollapsedCrumbs hidden={hiddenCrumbs} onNavigate={onNavigate} />
      )}
      {visibleTail.map((p) => (
        <CrumbButton key={p.path} crumb={p} onNavigate={onNavigate} />
      ))}
      {currentName && (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-subtle shrink-0">/</span>
          <span
            className="text-[12.5px] font-semibold text-fg truncate inline-flex items-center gap-1.5 min-w-0"
            style={{ maxWidth: 'min(40vw, 360px)' }}
            title={currentName}
          >
            <FileIcon name={currentName} />
            <span className="truncate">{currentName}</span>
          </span>
          {currentAction}
        </span>
      )}
    </div>
  )
}

function CrumbButton({
  crumb,
  onNavigate,
}: {
  crumb: { name: string; path: string }
  onNavigate: (dir: string) => void
}) {
  return (
    <span className="flex items-center gap-1.5 min-w-0 shrink-0">
      <span className="text-subtle shrink-0">/</span>
      <button
        className="text-[12.5px] font-medium text-fg hover:underline truncate max-w-[160px] inline-flex items-center gap-1.5"
        onClick={() => onNavigate(crumb.path)}
        title={crumb.name}
      >
        <Folder size={13} className="text-accent shrink-0" />
        <span className="truncate">{crumb.name}</span>
      </button>
    </span>
  )
}

function CollapsedCrumbs({
  hidden,
  onNavigate,
}: {
  hidden: Array<{ name: string; path: string }>
  onNavigate: (dir: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span ref={ref} className="flex items-center gap-1.5 shrink-0 relative">
      <span className="text-subtle shrink-0">/</span>
      <button
        className="btn-ghost h-6 w-6 px-0"
        onClick={() => setOpen((v) => !v)}
        title={hidden.map((h) => h.name).join(' / ')}
        aria-label="Show hidden folders"
        aria-expanded={open}
        style={
          open
            ? { background: 'var(--selected)', color: 'var(--accent)' }
            : undefined
        }
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 rounded shadow-card z-50 py-1 min-w-[160px]"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          {hidden.map((h) => (
            <button
              key={h.path}
              className="w-full text-left px-2.5 py-1 text-[12.5px] text-fg hover:bg-hover inline-flex items-center gap-1.5"
              onClick={() => {
                setOpen(false)
                onNavigate(h.path)
              }}
            >
              <Folder size={12} className="text-accent shrink-0" />
              <span className="truncate">{h.name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function FileIcon({ name }: { name: string }) {
  const i = name.lastIndexOf('.')
  const ext = i >= 0 ? name.slice(i).toLowerCase() : ''
  const props = { size: 13, className: 'shrink-0' } as const
  if (ext === '.pdf') return <FileType {...props} style={{ color: '#BF2600' }} />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext))
    return <FileImage {...props} className="shrink-0 text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(ext))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(ext))
    return <FileCode {...props} className="shrink-0 text-subtle" />
  return <FileText {...props} className="shrink-0 text-accent" />
}
