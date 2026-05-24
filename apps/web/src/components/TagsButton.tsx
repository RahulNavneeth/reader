import { useEffect, useMemo, useRef, useState } from 'react'
import { Tag, X, Loader2, Plus } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

type Props = {
  path: string
  tags: string[]
  /** Which API to hit. Folders use /api/folder/tags; files use /api/file/tags. */
  kind?: 'file' | 'folder'
  /** Owner of the path when caller is editing via a share grant. */
  owner?: string
  /** Called after a successful save so the parent can refresh its meta. */
  onSaved?: (next: string[]) => void
}

/**
 * Inline tag editor for the doc viewer header. Click → popover with a
 * Gmail-style chip field at the top (chips + inline input share one
 * outlined box) and a list of existing-vault-tag suggestions below.
 *
 *   • Typing filters the suggestion list.
 *   • Enter saves the typed value as a new tag (or selects the highlighted
 *     suggestion).
 *   • Clicking a suggestion adds it. Clicking an applied chip's × removes it.
 *
 * All mutations hit /api/file/tags immediately so there's no separate
 * "Save" step.
 */
export function TagsButton({ path, tags, kind = 'file', owner, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<string[]>(tags)
  const [allTags, setAllTags] = useState<{ tag: string; count: number }[]>([])
  const [hover, setHover] = useState<number>(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolvedAlign = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 320,
    open,
  })

  useEffect(() => setLocal(tags), [tags])

  // Prefetch the vault tag list on mount so the popover opens with
  // suggestions already populated (no "empty → fill" flash on first open).
  useEffect(() => {
    api
      .tags()
      .then((r) => setAllTags(r.tags))
      .catch(() => setAllTags([]))
  }, [])

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

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase()
    return allTags
      .filter((t) => !local.includes(t.tag))
      .filter((t) => !q || t.tag.includes(q))
      .slice(0, 8)
  }, [allTags, local, draft])

  const trimmedDraft = draft.trim().toLowerCase()
  const showCreateRow =
    !!trimmedDraft &&
    !allTags.some((t) => t.tag === trimmedDraft) &&
    !local.includes(trimmedDraft)
  const hasSuggestionArea = showCreateRow || suggestions.length > 0

  const persist = async (next: string[]) => {
    setBusy(true)
    setError(null)
    try {
      const saved =
        kind === 'folder'
          ? (await api.setFolderTags(path, next)).folder.tags
          : (await api.setTags(path, next, owner ? { owner } : undefined)).document.tags
      setLocal(saved)
      onSaved?.(saved)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addTag = async (raw: string) => {
    const t = raw.trim().toLowerCase()
    if (!t || local.includes(t)) {
      setDraft('')
      return
    }
    setDraft('')
    setHover(0)
    // Optimistically reflect the new tag in the vault-wide cache so a popover
    // reopen doesn't visually transition from "no such tag" → "tag now exists"
    // when the next mount's fetch lands.
    setAllTags((cur) => {
      const idx = cur.findIndex((x) => x.tag === t)
      if (idx >= 0) {
        const next = cur.slice()
        next[idx] = { ...next[idx], count: next[idx].count + 1 }
        return next
      }
      return [...cur, { tag: t, count: 1 }].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    })
    await persist([...local, t].sort())
  }

  const removeTag = (t: string) => {
    // Mirror the decrement so reopen doesn't see an out-of-date count.
    setAllTags((cur) =>
      cur
        .map((x) => (x.tag === t ? { ...x, count: x.count - 1 } : x))
        .filter((x) => x.count > 0),
    )
    return persist(local.filter((x) => x !== t))
  }

  const onInputKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // If the user is on a suggestion, prefer it; otherwise create whatever they typed.
      const pick = suggestions[hover]?.tag ?? draft
      await addTag(pick)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHover((h) => Math.min(h + 1, Math.max(0, suggestions.length - 1)))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHover((h) => Math.max(h - 1, 0))
    }
    if (e.key === 'Backspace' && !draft && local.length > 0) {
      // Backspace on empty input pops the last chip — Gmail-style.
      e.preventDefault()
      await removeTag(local[local.length - 1])
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title={local.length === 0 ? 'Tags' : `Tags: ${local.join(', ')}`}
        aria-label="Tags"
        aria-expanded={open}
        style={{
          ...(local.length > 0 ? { color: 'var(--accent)' } : null),
          ...(open ? { background: 'var(--selected)', color: 'var(--accent)' } : null),
        }}
      >
        <Tag size={13} />
        {local.length > 0 && (
          <span className="text-[10px] font-semibold tabular-nums">{local.length}</span>
        )}
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
          {/* Chip field: applied chips + inline input share one outlined box.
              Caps height so a few hundred tags still scroll instead of pushing
              the input off-screen. The bottom border only appears when the
              suggestion area below has content, to avoid an orphaned divider. */}
          <div
            className="px-2 py-1.5 flex flex-wrap items-center gap-1 cursor-text max-h-[120px] overflow-y-auto"
            style={{
              background: 'var(--bg)',
              borderBottom: hasSuggestionArea ? '1px solid var(--border)' : undefined,
            }}
            onClick={() => inputRef.current?.focus()}
          >
            {local.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 px-1.5 h-[22px] rounded text-[11.5px] font-medium"
                style={{ background: 'var(--selected)', color: 'var(--accent)' }}
              >
                {t}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTag(t)
                  }}
                  disabled={busy}
                  className="inline-flex items-center justify-center w-3.5 h-3.5 rounded hover:bg-white/60"
                  title={`Remove ${t}`}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              className="flex-1 min-w-[80px] h-[22px] bg-transparent outline-none text-[12.5px] text-fg placeholder:text-subtle"
              placeholder={local.length === 0 ? 'Type a tag and press Enter…' : 'Add another…'}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setHover(0)
              }}
              onKeyDown={onInputKey}
              disabled={busy}
            />
            {busy && <Loader2 size={12} className="animate-spin text-muted" />}
          </div>

          {/* Suggestions: existing vault tags. If the user has typed something
              that doesn't match an existing tag, surface a "Create" row at the
              top so they know Enter will work. */}
          <div className="max-h-[220px] overflow-y-auto">
            {draft.trim() &&
              !allTags.some((t) => t.tag === draft.trim().toLowerCase()) &&
              !local.includes(draft.trim().toLowerCase()) && (
                <button
                  className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left hover:bg-hover"
                  onClick={() => addTag(draft)}
                  style={hover === -1 ? { background: 'var(--selected)' } : undefined}
                >
                  <Plus size={12} className="text-accent" />
                  <span className="text-fg">Create</span>
                  <span className="text-accent font-medium">{draft.trim().toLowerCase()}</span>
                </button>
              )}
            {suggestions.length === 0 && !draft.trim() && allTags.length === 0 && (
              <div className="px-2.5 py-2 text-[11.5px] text-subtle">
                No tags yet. Type one above and press Enter.
              </div>
            )}
            {suggestions.map((s, i) => (
              <button
                key={s.tag}
                onMouseEnter={() => setHover(i)}
                onClick={() => addTag(s.tag)}
                className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left text-fg"
                // Subtle hover — avoids the "selected chip" look that made the
                // row read like the tag was already applied.
                style={hover === i ? { background: 'var(--hover)' } : undefined}
              >
                <Tag size={11} className="text-muted" />
                <span className="flex-1 truncate">{s.tag}</span>
                <span className="text-[10.5px] text-subtle">{s.count}</span>
              </button>
            ))}
          </div>

          {error && (
            <div
              className="px-2.5 py-1.5 text-[11px]"
              style={{ background: '#FFEBE6', color: '#BF2600' }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
