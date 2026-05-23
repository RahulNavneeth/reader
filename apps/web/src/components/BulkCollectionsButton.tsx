import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, Loader2, Plus, AlertCircle, Check } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

/**
 * Bulk "Add N files to a collection" trigger for the folder-grid
 * selection toolbar. Same chip-field-style search input as the
 * single-file CollectionsToolbarButton, but no chip strip on top —
 * bulk has no clean "currently in" semantic, so we just show a
 * filterable list with a per-row "Added ✓" affirmation that sticks
 * around without closing the popover.
 *
 * Type a name + Enter creates a brand-new collection and adds every
 * selected file to it (matches the Tags popover's create-and-apply).
 */
export function BulkCollectionsButton({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<Array<{ id: string; name: string }> | null>(null)
  // Track which collections have been actioned in this open session
  // so the rows show a persistent ✓ confirmation without closing
  // the popover or auto-dismissing.
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [hover, setHover] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolvedAlign = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 320,
    open,
  })

  const refresh = async () => {
    try {
      const r = await api.listCollections()
      setAll(r.mine.map((c) => ({ id: c.id, name: c.name })))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!open) return
    refresh()
    setAdded(new Set())
    requestAnimationFrame(() => inputRef.current?.focus())
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

  const suggestions = useMemo(() => {
    if (!all) return []
    const q = draft.trim().toLowerCase()
    if (!q) return all
    return all.filter((c) => c.name.toLowerCase().includes(q))
  }, [all, draft])

  const showCreateRow =
    !!draft.trim() &&
    !!all &&
    !all.some((c) => c.name.toLowerCase() === draft.trim().toLowerCase())

  const addToCollection = async (cid: string) => {
    setBusy(cid)
    setError(null)
    try {
      const r = await api.addCollectionItems(cid, { paths })
      if (r.skipped.length > 0 && r.added.length === 0) {
        setError(r.skipped[0]?.reason ?? 'could not add')
        return
      }
      setAdded((prev) => new Set(prev).add(cid))
      setDraft('')
      setHover(0)
      inputRef.current?.focus()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const createAndAdd = async () => {
    const name = draft.trim()
    if (!name) return
    setBusy('__new__')
    setError(null)
    try {
      const c = await api.createCollection({ name })
      await api.addCollectionItems(c.collection.id, { paths })
      setDraft('')
      setHover(0)
      await refresh()
      setAdded((prev) => new Set(prev).add(c.collection.id))
      inputRef.current?.focus()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (showCreateRow && hover === -1) return createAndAdd()
      const pick = suggestions[hover]
      if (pick) return addToCollection(pick.id)
      if (showCreateRow) return createAndAdd()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHover((h) => Math.min(suggestions.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHover((h) => Math.max(showCreateRow ? -1 : 0, h - 1))
    }
  }

  const hasSuggestionArea = suggestions.length > 0 || showCreateRow

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        disabled={paths.length === 0}
        onClick={() => setOpen((v) => !v)}
        title={`Add ${paths.length} file${paths.length === 1 ? '' : 's'} to a collection`}
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <Layers size={13} />
        Collections
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 w-[320px] rounded-md shadow-card overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            ...alignStyle(resolvedAlign),
          }}
        >
          <div
            className="px-2 py-1.5 cursor-text"
            style={{
              background: 'var(--bg)',
              borderBottom: hasSuggestionArea
                ? '1px solid var(--border)'
                : undefined,
            }}
            onClick={() => inputRef.current?.focus()}
          >
            <input
              ref={inputRef}
              className="w-full h-[22px] bg-transparent outline-none text-[12.5px] text-fg placeholder:text-subtle"
              placeholder={`Add ${paths.length} file${paths.length === 1 ? '' : 's'} — search or create…`}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setHover(0)
              }}
              onKeyDown={onInputKey}
              disabled={busy != null}
            />
          </div>

          <div className="max-h-[240px] overflow-y-auto">
            {showCreateRow && (
              <button
                className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left hover:bg-hover"
                onClick={createAndAdd}
                onMouseEnter={() => setHover(-1)}
                style={hover === -1 ? { background: 'var(--selected)' } : undefined}
                disabled={busy != null}
              >
                <Plus size={12} className="text-accent" />
                <span className="text-fg">Create</span>
                <span className="text-accent font-medium">{draft.trim()}</span>
              </button>
            )}
            {!all ? (
              <div className="px-2.5 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Loading…
              </div>
            ) : suggestions.length === 0 && !showCreateRow ? (
              <div className="px-2.5 py-2 text-[11.5px] text-subtle">
                {all.length === 0
                  ? 'No collections yet. Type a name above to create one.'
                  : 'No matches.'}
              </div>
            ) : (
              suggestions.map((s, i) => {
                const isAdded = added.has(s.id)
                const isBusy = busy === s.id
                return (
                  <button
                    key={s.id}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => addToCollection(s.id)}
                    className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left text-fg"
                    style={hover === i ? { background: 'var(--hover)' } : undefined}
                    disabled={isBusy}
                  >
                    <Layers size={11} className="text-muted" />
                    <span className="flex-1 truncate">{s.name}</span>
                    {isBusy ? (
                      <Loader2 size={11} className="animate-spin text-subtle" />
                    ) : isAdded ? (
                      <span
                        className="inline-flex items-center gap-1 text-[10.5px] font-medium"
                        style={{ color: 'var(--accent)' }}
                      >
                        <Check size={10} strokeWidth={3} />
                        added
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>

          {error && (
            <div
              className="px-2.5 py-1.5 text-[11px] flex items-center gap-1.5"
              style={{ background: '#FFEBE6', color: '#BF2600' }}
            >
              <AlertCircle size={10} /> {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
