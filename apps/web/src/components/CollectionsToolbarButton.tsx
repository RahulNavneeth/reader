import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, X, Loader2, Plus, AlertCircle } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

/**
 * "Add to collection" trigger for the PathViewer toolbar, modeled on
 * TagsButton so the two affordances feel identical:
 *
 *   - Top: chip field listing collections this doc is currently in.
 *     Click the chip's X to remove. Inline input merged into the
 *     same outlined box filters the suggestion list and accepts a
 *     fresh name (Enter creates + adds).
 *   - Bottom: filterable suggestion list of every other collection
 *     the user owns. Click a row to add the doc.
 *   - Popover stays open across every add/remove so you can pick
 *     multiple collections without re-opening.
 *
 * Authoritative source for "currently in" is `api.collectionsByDoc`
 * — re-fetched after each mutation so the chip field stays in sync
 * with the server's view.
 */
export function CollectionsToolbarButton({ docId }: { docId: string }) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<Array<{ id: string; name: string }> | null>(null)
  const [containing, setContaining] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [hover, setHover] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolvedAlign = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 320,
    open,
  })

  const refresh = async () => {
    try {
      const [list, byDoc] = await Promise.all([
        api.listCollections(),
        api.collectionsByDoc(docId),
      ])
      setAll(list.mine.map((c) => ({ id: c.id, name: c.name })))
      setContaining(new Set(byDoc.collections.map((c) => c.id)))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  // Eager fetch of just the membership set on mount / docId change
  // so the trigger label shows "1 collection" instead of "Collections"
  // before the user has ever opened the popover. The full collection
  // list still loads lazily on open via refresh() below.
  useEffect(() => {
    let cancelled = false
    api
      .collectionsByDoc(docId)
      .then((r) => {
        if (cancelled) return
        setContaining(new Set(r.collections.map((c) => c.id)))
      })
      .catch(() => {
        /* trigger label silently degrades to "Collections" */
      })
    return () => {
      cancelled = true
    }
  }, [docId])

  useEffect(() => {
    if (!open) return
    refresh()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docId])

  // Suggestions = all collections the doc isn't already in,
  // filtered by the input text.
  const suggestions = useMemo(() => {
    if (!all) return []
    const q = draft.trim().toLowerCase()
    return all
      .filter((c) => !containing.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
  }, [all, containing, draft])

  // Show "Create <name>" when the typed text doesn't match anything
  // existing — same affordance as the Tags popover's create row.
  const showCreateRow =
    !!draft.trim() &&
    !!all &&
    !all.some((c) => c.name.toLowerCase() === draft.trim().toLowerCase())

  const inChips = useMemo(() => {
    if (!all) return []
    return all.filter((c) => containing.has(c.id))
  }, [all, containing])

  const add = async (cid: string) => {
    setBusy(cid)
    setError(null)
    try {
      const r = await api.addCollectionItems(cid, { docIds: [docId] })
      if (r.skipped.length > 0 && r.added.length === 0) {
        setError(r.skipped[0]?.reason ?? 'could not add')
        return
      }
      setContaining((prev) => new Set(prev).add(cid))
      setDraft('')
      setHover(0)
      // Keep focus in the input so the user can keep typing /
      // picking — popover deliberately stays open.
      inputRef.current?.focus()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (cid: string) => {
    setBusy(cid)
    setError(null)
    try {
      await api.removeCollectionItem(cid, docId)
      setContaining((prev) => {
        const n = new Set(prev)
        n.delete(cid)
        return n
      })
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
      await api.addCollectionItems(c.collection.id, { docIds: [docId] })
      setDraft('')
      setHover(0)
      // Refresh so the brand-new collection shows up as a chip.
      await refresh()
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
      if (pick) return add(pick.id)
      if (showCreateRow) return createAndAdd()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHover((h) => Math.min(suggestions.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHover((h) => Math.max(showCreateRow ? -1 : 0, h - 1))
    } else if (e.key === 'Backspace' && draft === '' && inChips.length > 0) {
      // Backspace on empty input removes the last applied chip.
      remove(inChips[inChips.length - 1].id)
    }
  }

  const triggerLabel =
    containing.size === 0
      ? 'Collections'
      : containing.size === 1
        ? '1 collection'
        : `${containing.size} collections`
  const hasSuggestionArea = suggestions.length > 0 || showCreateRow

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Add to collection"
        aria-expanded={open}
        style={{
          ...(containing.size > 0 ? { color: 'var(--accent)' } : null),
          ...(open ? { background: 'var(--selected)', color: 'var(--accent)' } : null),
        }}
      >
        <Layers size={13} />
        <span className="truncate max-w-[140px]">{triggerLabel}</span>
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
          {/* Chip field — applied chips + inline filter input in one
              outlined row. Same shape as the Tags popover. */}
          <div
            className="px-2 py-1.5 flex flex-wrap items-center gap-1 cursor-text max-h-[120px] overflow-y-auto"
            style={{
              background: 'var(--bg)',
              borderBottom: hasSuggestionArea
                ? '1px solid var(--border)'
                : undefined,
            }}
            onClick={() => inputRef.current?.focus()}
          >
            {inChips.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 px-1.5 h-[22px] rounded text-[11.5px] font-medium"
                style={{ background: 'var(--selected)', color: 'var(--accent)' }}
              >
                {c.name}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(c.id)
                  }}
                  disabled={busy === c.id}
                  className="inline-flex items-center justify-center w-3.5 h-3.5 rounded hover:bg-white/60"
                  title={`Remove from ${c.name}`}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              className="flex-1 min-w-[80px] h-[22px] bg-transparent outline-none text-[12.5px] text-fg placeholder:text-subtle"
              placeholder={
                inChips.length === 0
                  ? 'Search or create…'
                  : 'Add another…'
              }
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setHover(0)
              }}
              onKeyDown={onInputKey}
              disabled={busy != null}
            />
            {busy != null && <Loader2 size={12} className="animate-spin text-muted" />}
          </div>

          <div className="max-h-[220px] overflow-y-auto">
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
                  : containing.size === all.length
                    ? 'In every one of your collections.'
                    : 'No matches.'}
              </div>
            ) : (
              suggestions.map((s, i) => (
                <button
                  key={s.id}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => add(s.id)}
                  className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left text-fg"
                  style={hover === i ? { background: 'var(--hover)' } : undefined}
                  disabled={busy != null}
                >
                  <Layers size={11} className="text-muted" />
                  <span className="flex-1 truncate">{s.name}</span>
                </button>
              ))
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
