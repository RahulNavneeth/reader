import { useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { ActivityPanel } from './ActivityPanel'

/**
 * Header trigger that opens the file's activity log in a small popover.
 * Mirrors TagsButton's interaction pattern so the toolbar feels consistent.
 */
export function ActivityButton({
  path,
  kind = 'file',
}: {
  path: string
  kind?: 'file' | 'folder'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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
      <button className="btn-ghost" onClick={() => setOpen((v) => !v)} title="Activity">
        <History size={13} />
        Activity
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[320px] max-h-[420px] overflow-y-auto p-2 rounded-md shadow-card"
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
        >
          <ActivityPanel path={path} kind={kind} />
        </div>
      )}
    </div>
  )
}
