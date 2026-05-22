import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { api } from '../lib/api'

export type MentionDoc = {
  docId: string
  path: string
  name: string
}

type Props = {
  /** The text after `@` the user has typed so far. The popover
   *  filters its list against this. Empty string = show all
   *  recent docs. */
  query: string
  /** Docs already attached — excluded from the list so the user
   *  can't double-attach. */
  attachedIds: string[]
  /** Doc ID of the chat's anchor — excluded since the chat is
   *  already grounded in that doc. */
  excludeDocId?: string
  onPick: (doc: MentionDoc) => void
  onClose: () => void
}

/**
 * "@" mention popover for the chat composer. Lists every document
 * in the user's vault, filtered by what the user has typed after
 * the `@`. Click a row to attach the doc as additional context for
 * the next chat turn.
 *
 * Behaviour notes:
 *   • Mounted as long as the user has an unclosed `@token` in the
 *     draft; parent (ChatDock) handles open/close + token capture.
 *   • Up/Down/Enter for keyboard nav; Esc closes. Hover updates
 *     the highlighted row so mouse + keyboard stay in sync.
 *   • Sits above the composer (bottom-anchored) to match
 *     SlashMenu's positioning.
 */
export function MentionMenu({ query, attachedIds, excludeDocId, onPick, onClose }: Props) {
  const [items, setItems] = useState<MentionDoc[]>([])
  const [hover, setHover] = useState(0)
  /** True once at least one fetch has resolved. Until then, we
   *  suppress the "No documents found" empty-state so the popover
   *  doesn't flash that message in the ~80 ms before the first
   *  API response lands. */
  const [hasLoaded, setHasLoaded] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // Refetch the list as the query changes. The FIRST fetch (when
  // hasLoaded is still false) fires immediately so the popover
  // doesn't open into an empty body for ~80 ms; subsequent typed
  // changes are debounced so we don't fire one request per
  // keystroke.
  useEffect(() => {
    let cancelled = false
    const doFetch = async () => {
      try {
        const r = await api.filesSearch(query || '', 30)
        if (cancelled) return
        // Dedup by docId AND by display key (path + name). The
        // search endpoint can surface the same document twice when
        // both a filename match and a tag match hit (different
        // score entries), AND two separate documents can share the
        // same name + path (e.g. your own copy + one shared in by
        // another user). Either way the user sees identical rows;
        // collapse to the first occurrence.
        const seenById = new Set<string>()
        const seenByDisplay = new Set<string>()
        const filtered: MentionDoc[] = []
        for (const it of r.items) {
          if (seenById.has(it.docId)) continue
          if (attachedIds.includes(it.docId)) continue
          if (excludeDocId && it.docId === excludeDocId) continue
          const displayKey = `${it.path}::${it.name}`
          if (seenByDisplay.has(displayKey)) continue
          seenById.add(it.docId)
          seenByDisplay.add(displayKey)
          filtered.push({ docId: it.docId, path: it.path, name: it.name })
        }
        setItems(filtered)
        setHover(0)
        setHasLoaded(true)
      } catch {
        if (!cancelled) {
          setItems([])
          setHasLoaded(true)
        }
      }
    }
    if (!hasLoaded) {
      // First load — fire instantly, no debounce.
      void doFetch()
      return () => {
        cancelled = true
      }
    }
    const timer = setTimeout(doFetch, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, attachedIds.join(','), excludeDocId])

  // Keyboard navigation. The composer textarea keeps focus
  // throughout — we listen on document so up/down/Enter/Esc still
  // route to us even though the textarea has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHover((h) => Math.min(items.length - 1, h + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHover((h) => Math.max(0, h - 1))
      } else if (e.key === 'Enter' && items.length > 0) {
        e.preventDefault()
        const pick = items[Math.min(hover, items.length - 1)]
        if (pick) onPick(pick)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [items, hover, onPick, onClose])

  // Click-outside closer.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return
      if (ref.current.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const showEmpty = hasLoaded && items.length === 0

  // Don't paint the popover at all until the first fetch lands.
  // Otherwise the popover opens into an empty header-only shell
  // for ~20–80 ms before rows arrive — reads as a flicker.
  if (!hasLoaded) return null

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-3 right-3 mb-1 rounded-md overflow-hidden z-50"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 6px 18px rgba(15, 23, 42, 0.18)',
      }}
    >
      <div className="px-2.5 py-1.5 text-[10.5px] uppercase tracking-wider font-semibold text-subtle"
           style={{ borderBottom: '1px solid var(--border-soft)' }}>
        Mention a document
      </div>
      <div className="max-h-[240px] overflow-y-auto py-0.5">
        {showEmpty && (
          <div className="px-2.5 py-2 text-[11.5px] text-subtle">
            {query ? `No documents match “${query}”` : 'No documents found.'}
          </div>
        )}
        {items.map((it, i) => (
          <Row
            key={it.docId}
            item={it}
            highlighted={i === hover}
            onPick={onPick}
            onHover={() => setHover(i)}
          />
        ))}
      </div>
    </div>
  )
}

function Row({
  item,
  highlighted,
  onPick,
  onHover,
}: {
  item: MentionDoc
  highlighted: boolean
  onPick: (d: MentionDoc) => void
  onHover: () => void
}) {
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(item)}
      className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left"
      style={highlighted ? { background: 'var(--hover)' } : undefined}
      title={item.path}
    >
      <FileText size={11} className="shrink-0" style={{ color: 'var(--fg-subtle)' }} />
      <span className="flex-1 min-w-0 truncate text-fg">{item.name}</span>
      <span className="text-[10.5px] text-subtle truncate min-w-0 max-w-[160px]">
        {item.path.replace(/\/[^/]+$/, '') || '/'}
      </span>
    </button>
  )
}
