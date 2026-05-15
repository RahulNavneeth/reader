import { useEffect, useRef, useState } from 'react'
import { Tag, X, Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Props = {
  path: string
  tags: string[]
  /** Called after a successful save so the parent can refresh its meta. */
  onSaved?: (next: string[]) => void
}

/**
 * Inline tag editor for the doc viewer header. Click → popover with the
 * current chips + an input. Enter or "," commits the new tag; clicking a
 * chip's × removes it. Saves to /api/file/tags on every change.
 */
export function TagsButton({ path, tags, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<string[]>(tags)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setLocal(tags), [tags])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
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

  const persist = async (next: string[]) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.setTags(path, next)
      setLocal(r.document.tags)
      onSaved?.(r.document.tags)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    const t = draft.trim().toLowerCase()
    if (!t) return
    if (local.includes(t)) {
      setDraft('')
      return
    }
    setDraft('')
    await persist([...local, t].sort())
  }

  const remove = async (t: string) => {
    await persist(local.filter((x) => x !== t))
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Edit tags"
      >
        <Tag size={13} />
        {local.length > 0 ? `Tags (${local.length})` : 'Tags'}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[280px] rounded-md shadow-card"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <div className="p-2 flex flex-wrap gap-1">
            {local.length === 0 && (
              <div className="text-[11.5px] text-muted py-0.5">No tags yet.</div>
            )}
            {local.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px]"
                style={{ background: 'var(--selected)', color: 'var(--accent)' }}
              >
                {t}
                <button
                  className="hover:bg-hover rounded"
                  onClick={() => remove(t)}
                  disabled={busy}
                  title={`Remove ${t}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <div className="p-2 border-t" style={{ borderColor: 'var(--border-soft)' }}>
            <div className="flex items-center gap-1">
              <input
                ref={inputRef}
                className="input flex-1 h-7 text-[12px]"
                placeholder="Add tag…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    commit()
                  }
                }}
                disabled={busy}
              />
              {busy && <Loader2 size={12} className="animate-spin text-muted" />}
            </div>
            {error && (
              <div className="text-[11px] mt-1" style={{ color: '#BF2600' }}>
                {error}
              </div>
            )}
            <div className="text-[10.5px] text-subtle mt-1">Enter to add, × to remove.</div>
          </div>
        </div>
      )}
    </div>
  )
}
