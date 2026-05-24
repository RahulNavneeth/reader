import { useEffect, useMemo, useRef, useState } from 'react'
import { Tag, Loader2, Plus, AlertCircle, Check } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

/**
 * Bulk "Add tag to N items" trigger for the folder-grid selection
 * toolbar. Works on any mix of files and folders — the
 * /api/file/bulk-tags endpoint dispatches to document metas vs
 * folder metas based on what each path resolves to.
 *
 * Mirror of the Tags popover's shape but without the chip strip
 * (bulk has no clean "currently tagged" view — different items may
 * already carry different sets). Search-as-you-type filters the
 * suggestion list of vault tags; typing something new and hitting
 * Enter creates+applies it.
 *
 * Stays open across actions; rows the popover has already added in
 * this session show a persistent ✓ until the popover is closed.
 */
export function BulkTagsButton({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState(false)
  const [allTags, setAllTags] = useState<Array<{ tag: string; count: number }> | null>(null)
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
      const r = await api.tags()
      setAllTags(r.tags)
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
    if (!allTags) return []
    const q = draft.trim().toLowerCase()
    if (!q) return allTags
    return allTags.filter((t) => t.tag.includes(q))
  }, [allTags, draft])

  const showCreateRow =
    !!draft.trim() &&
    !!allTags &&
    !allTags.some((t) => t.tag === draft.trim().toLowerCase())

  const applyTag = async (tag: string) => {
    const t = tag.trim().toLowerCase()
    if (!t) return
    setBusy(t)
    setError(null)
    try {
      const r = await api.bulkTags({ paths, add: [t] })
      if (r.ok === 0 && r.errors.length > 0) {
        setError(r.errors[0]?.reason ?? 'no items updated')
        return
      }
      setAdded((prev) => new Set(prev).add(t))
      // Bump local tag list so a freshly-created tag appears.
      setAllTags((cur) => {
        const next = cur ? [...cur] : []
        if (!next.some((x) => x.tag === t)) next.push({ tag: t, count: 1 })
        return next.sort((a, b) => a.tag.localeCompare(b.tag))
      })
      setDraft('')
      setHover(0)
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
      if (showCreateRow && hover === -1) return applyTag(draft)
      const pick = suggestions[hover]
      if (pick) return applyTag(pick.tag)
      if (showCreateRow) return applyTag(draft)
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
        title={`Tag ${paths.length} item${paths.length === 1 ? '' : 's'}`}
        aria-label="Tag selected"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <Tag size={13} />
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
              placeholder={`Add tag to ${paths.length} item${paths.length === 1 ? '' : 's'}…`}
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
                onClick={() => applyTag(draft)}
                onMouseEnter={() => setHover(-1)}
                style={hover === -1 ? { background: 'var(--selected)' } : undefined}
                disabled={busy != null}
              >
                <Plus size={12} className="text-accent" />
                <span className="text-fg">Create</span>
                <span className="text-accent font-medium">{draft.trim().toLowerCase()}</span>
              </button>
            )}
            {!allTags ? (
              <div className="px-2.5 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Loading…
              </div>
            ) : suggestions.length === 0 && !showCreateRow ? (
              <div className="px-2.5 py-2 text-[11.5px] text-subtle">
                {allTags.length === 0
                  ? 'No tags yet. Type one above and press Enter.'
                  : 'No matches.'}
              </div>
            ) : (
              suggestions.map((s, i) => {
                const isAdded = added.has(s.tag)
                const isBusy = busy === s.tag
                return (
                  <button
                    key={s.tag}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => applyTag(s.tag)}
                    className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left text-fg"
                    style={hover === i ? { background: 'var(--hover)' } : undefined}
                    disabled={isBusy}
                  >
                    <Tag size={11} className="text-muted" />
                    <span className="flex-1 truncate">{s.tag}</span>
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
                    ) : (
                      <span className="text-[10.5px] text-subtle">{s.count}</span>
                    )}
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
