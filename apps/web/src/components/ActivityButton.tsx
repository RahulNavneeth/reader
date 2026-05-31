import { useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { ActivityPanel } from './ActivityPanel'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

/**
 * Header trigger that opens the file's activity log in a small popover.
 * Mirrors TagsButton's interaction pattern so the toolbar feels consistent.
 */
export function ActivityButton({
  path,
  kind = 'file',
  owner,
}: {
  path: string
  kind?: 'file' | 'folder'
  /** Owner hint for shared-with-me file activity. Threaded
   *  through so the audit endpoint can resolve via the same
   *  shared-grant path as the read endpoints. */
  owner?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const resolvedAlign = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 320,
    open,
  })

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Activity"
        aria-label="Activity"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <History size={13} />
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden flex flex-col"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            maxHeight: 460,
            ...alignStyle(resolvedAlign),
          }}
        >
          {/* Header bar — same shape as Public / Share so the toolbar's
              popover family reads as one component. */}
          <div
            className="flex items-center gap-2 px-3 h-8 shrink-0"
            style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' }}
          >
            <History size={13} className="text-muted" />
            <span className="text-[12px] font-semibold text-fg flex-1">
              Activity
            </span>
            <span className="text-[10.5px] text-subtle">
              {kind === 'folder' ? 'Folder history' : 'File history'}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ActivityPanel path={path} kind={kind} owner={owner} />
          </div>
        </div>
      )}
    </div>
  )
}
