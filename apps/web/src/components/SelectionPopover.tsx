import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageSquarePlus, Quote, Sparkles, X } from 'lucide-react'

type CommentAnchor = {
  quote: string
  rangeStart: number
  rangeEnd: number
}

type Props = {
  /** The container whose text selections should trigger the popover.
   *  Selections outside this element (chat sidebar, toolbar, outline)
   *  are ignored. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Called when the user clicks "Explain with Reader AI" — fires
   *  off an auto-sent "Explain this: …" message. Optional so the
   *  popover can render with just the Comment / Reply actions when
   *  chat isn't enabled. */
  onExplain?: (selectedText: string) => void
  /** Called when the user clicks "Reply with Reader AI". The
   *  selection becomes a quote chip above the chat composer; the
   *  user can then type any question (explain, rephrase, edit,
   *  fact-check) against it. Optional — omit on read-only docs. */
  onReply?: (selectedText: string) => void
  /** Markdown body root — when provided, the popover also offers a
   *  Comment button (only when the active selection is inside
   *  bodyRef). Offsets are computed by walking text nodes from
   *  bodyRef so they line up with the doc body text the server
   *  stores. */
  bodyRef?: React.RefObject<HTMLElement | null>
  /** Called with the selection's anchor info + the user's comment
   *  text once they confirm. The composer UI is owned by this
   *  popover so the user never loses their place. */
  onComment?: (anchor: CommentAnchor, text: string) => Promise<void> | void
}

/**
 * Floating action chip that appears near the user's text selection
 * inside the doc viewer. Position-anchored to the selection's
 * bounding rect so it follows wherever the user dragged.
 *
 * Skips selections that:
 *   - are empty / collapsed
 *   - are outside the containerRef (e.g. in the chat sidebar)
 *   - have fewer than 5 chars (likely accidental)
 *
 * Long selections are passed through verbatim — the parent decides
 * how to trim before sending to the chat.
 */
function offsetWithinRoot(
  root: HTMLElement,
  node: Node,
  offsetInNode: number,
): number {
  // Earlier implementation walked SHOW_TEXT nodes manually — that
  // missed the case where `node` is an Element (selection landed on
  // an element boundary, e.g. cursor right after the last text node
  // in a paragraph). Walking failed to find the node and silently
  // returned the body's full text length, so comments stored
  // rangeEnd = "everything" — the highlight then spanned the entire
  // rest of the doc.
  //
  // Range.toString() serializes whatever the browser would have
  // copied to the clipboard for that range — handles element
  // boundaries, mixed inline / block nodes, the lot.
  try {
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(node, offsetInNode)
    return range.toString().length
  } catch {
    // Defensive: setEnd throws if the node isn't a descendant of
    // root. Fall back to the full body text length so the caller
    // can detect the bad offset rather than store NaN.
    return (root.textContent ?? '').length
  }
}

export function SelectionPopover({
  containerRef,
  onExplain,
  onReply,
  bodyRef,
  onComment,
}: Props) {
  const [pos, setPos] = useState<{
    top: number
    left: number
    text: string
    /** Populated only when the selection sits inside bodyRef AND
     *  onComment is provided — drives the Comment button + the
     *  composer payload. Null when commenting isn't available for
     *  this selection. */
    anchor: CommentAnchor | null
  } | null>(null)
  const [composing, setComposing] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [busy, setBusy] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // Persisted client rects of the selection captured at the
  // moment the user clicked Comment. Painted as accent overlays
  // for the duration of the composer so the user can SEE what
  // they're commenting on — the native selection collapses the
  // moment focus moves to the textarea.
  const [composingHighlight, setComposingHighlight] = useState<DOMRect[] | null>(null)
  /** Frozen popover position (top/left) while composing.
   *  Tracks the selection as the user scrolls so the composer
   *  + highlight stay glued to the commented text instead of
   *  floating fixed in the viewport. */
  const [composingPos, setComposingPos] = useState<{ top: number; left: number } | null>(null)
  /** The selection's Range, captured at compose-open. Cloned so
   *  it survives the native selection collapsing when focus
   *  moves to the textarea. */
  const composingRangeRef = useRef<Range | null>(null)

  useEffect(() => {
    const onSelectionChange = () => {
      // Don't recompute the anchor while the composer is open —
      // the user clicked Comment and we still need the original
      // selection state. selectionchange WILL fire (textarea focus
      // collapses the doc selection) and would otherwise wipe pos
      // mid-compose.
      if (composing) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPos(null)
        return
      }
      const text = sel.toString().trim()
      if (text.length < 5) {
        setPos(null)
        return
      }
      // Selection must live INSIDE the container ref — otherwise we
      // pop up over the chat sidebar / outline / toolbar too.
      const container = containerRef.current
      if (!container) {
        setPos(null)
        return
      }
      const range = sel.getRangeAt(0)
      // commonAncestorContainer can be a text node — walk up to
      // its element parent before doing the contains() check.
      const anchorEl =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement
      if (!anchorEl || !container.contains(anchorEl)) {
        setPos(null)
        return
      }

      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        // Some browsers return an empty rect for selections inside
        // shadow DOM or input elements — bail rather than render a
        // popover at (0, 0).
        setPos(null)
        return
      }

      // Selection direction: when the user drags from top to
      // bottom, focus follows anchor → "forward". When dragging
      // bottom to top, focus precedes anchor → "backward". The
      // popover should appear where the cursor *ends up* — at the
      // bottom of the selection for forward drags, at the top for
      // backward ones — so the button is close to where the user's
      // attention naturally lands.
      const isForward = (() => {
        if (!sel.anchorNode || !sel.focusNode) return true
        if (sel.anchorNode === sel.focusNode) {
          return sel.anchorOffset <= sel.focusOffset
        }
        const pos = sel.anchorNode.compareDocumentPosition(sel.focusNode)
        return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING)
      })()

      // Comment-anchor offsets vs the markdown body root. Only
      // computed when bodyRef is provided AND the selection sits
      // entirely inside it — the offsets need to line up with the
      // server-stored body text, which only matches when the
      // selection is purely in the rendered article (not in code
      // blocks rendered outside the body, etc).
      const body = bodyRef?.current ?? null
      let anchor: CommentAnchor | null = null
      if (
        body &&
        onComment &&
        body.contains(range.startContainer) &&
        body.contains(range.endContainer)
      ) {
        const a = offsetWithinRoot(body, range.startContainer, range.startOffset)
        const b = offsetWithinRoot(body, range.endContainer, range.endOffset)
        const [start, end] = a <= b ? [a, b] : [b, a]
        anchor = {
          quote: sel.toString(),
          rangeStart: start,
          rangeEnd: end,
        }
      }

      const POPOVER_HEIGHT = 32
      // Width depends on which buttons are rendered. Recompute as a
      // sum so adding/removing actions doesn't drift the centering.
      const widths: number[] = []
      if (onExplain) widths.push(108)
      if (onReply) widths.push(84)
      if (anchor) widths.push(108)
      if (widths.length === 0) {
        setPos(null)
        return
      }
      const POPOVER_WIDTH = widths.reduce((a, b) => a + b, 0)
      const PADDING = 8
      // Safe zone = the doc-scroller's bounding rect, not the
      // viewport. Without this the popover above a top-of-pane
      // selection would slip behind the toolbar / breadcrumb /
      // search bar that sit above the scroller.
      const containerRect = container.getBoundingClientRect()
      const safeTop = containerRect.top + PADDING
      const safeBottom = containerRect.bottom - PADDING
      const belowTop = rect.bottom + PADDING
      const aboveTop = rect.top - POPOVER_HEIGHT - PADDING
      const preferredTop = isForward ? belowTop : aboveTop
      const fallbackTop = isForward ? aboveTop : belowTop
      // Each slot is valid only if the popover fits entirely
      // inside the container's safe zone.
      const fits = (t: number) => t >= safeTop && t + POPOVER_HEIGHT <= safeBottom
      let top: number
      if (fits(preferredTop)) top = preferredTop
      else if (fits(fallbackTop)) top = fallbackTop
      else top = Math.max(safeTop, Math.min(preferredTop, safeBottom - POPOVER_HEIGHT))
      const rawLeft = rect.left + rect.width / 2 - POPOVER_WIDTH / 2
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - POPOVER_WIDTH - 8))
      // Final safety: if the selection has scrolled out of the
      // container's visible area entirely, don't show the popover.
      if (rect.bottom < safeTop || rect.top > safeBottom) {
        setPos(null)
        return
      }
      setPos({ top, left, text, anchor })
    }

    // rAF-debounce: selectionchange + scroll + resize all fan into
    // the same recompute. Without this the popover would lag the
    // selection during a scroll (it's position: fixed) — recomputing
    // on each scroll frame keeps it glued to the selection.
    let rafId: number | null = null
    const handler = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        onSelectionChange()
      })
    }
    document.addEventListener('selectionchange', handler)
    window.addEventListener('resize', handler)
    // Scroll events don't bubble — listen on the actual scroll
    // container plus window for the body-scroll case. `capture: true`
    // catches scrolls inside nested scrollers too (e.g. an inner
    // markdown article inside the file pane).
    window.addEventListener('scroll', handler, true)
    const container = containerRef.current
    if (container) container.addEventListener('scroll', handler, { passive: true })

    // Also hide when the user clicks outside the popover. Without
    // this the popover would stick around after the user dismisses
    // the selection by clicking elsewhere — `selectionchange` doesn't
    // always fire on a no-op click.
    const onMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      setPos(null)
      setComposing(false)
      setCommentText('')
      setComposeError(null)
      setComposingHighlight(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('selectionchange', handler)
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
      if (container) container.removeEventListener('scroll', handler)
      document.removeEventListener('mousedown', onMouseDown)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [containerRef, onReply, bodyRef, onComment, composing])

  // Recompute the composer position + highlight on every scroll /
  // resize tick so the popover stays glued to the commented text
  // as the user scrolls the doc. MUST live above the early-return
  // so hook ordering stays stable across renders.
  useEffect(() => {
    if (!composing) return
    let rafId: number | null = null
    const recompute = () => {
      const r = composingRangeRef.current
      if (!r) return
      const rects: DOMRect[] = []
      const clientRects = r.getClientRects()
      for (let i = 0; i < clientRects.length; i++) {
        const rect = clientRects[i]
        if (rect.width > 0 && rect.height > 0) rects.push(rect)
      }
      const wideByLine = new Map<string, DOMRect>()
      for (const rect of rects) {
        const key = String(Math.round(rect.top / 2))
        const cur = wideByLine.get(key)
        if (!cur || rect.width > cur.width) wideByLine.set(key, rect)
      }
      const deduped = Array.from(wideByLine.values())
      setComposingHighlight(deduped)
      const container = containerRef.current
      if (container && deduped.length > 0) {
        const containerRect = container.getBoundingClientRect()
        const last = deduped[deduped.length - 1]
        const POPOVER_HEIGHT = 220
        const POPOVER_WIDTH = 280
        const PADDING = 8
        const safeTop = containerRect.top + PADDING
        const safeBottom = containerRect.bottom - PADDING
        let top = last.bottom + PADDING
        if (top + POPOVER_HEIGHT > safeBottom) {
          const aboveFirst = deduped[0]
          top = aboveFirst.top - POPOVER_HEIGHT - PADDING
        }
        top = Math.max(safeTop, Math.min(top, safeBottom - POPOVER_HEIGHT))
        const rawLeft = last.left + last.width / 2 - POPOVER_WIDTH / 2
        const left = Math.max(
          8,
          Math.min(rawLeft, window.innerWidth - POPOVER_WIDTH - 8),
        )
        setComposingPos({ top, left })
      }
    }
    // Initial layout: defer to next frame so the popover has
    // mounted before we measure.
    rafId = requestAnimationFrame(() => {
      rafId = null
      recompute()
    })
    const schedule = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        recompute()
      })
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const container = containerRef.current
    if (container) container.addEventListener('scroll', schedule, { passive: true })
    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (container) container.removeEventListener('scroll', schedule)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [composing, containerRef])

  if (!pos) return null

  const dispatch = (kind: 'explain' | 'reply') => {
    const text = pos.text
    setPos(null)
    // Clear the selection so the popover doesn't immediately re-pop
    // on the next selectionchange fire.
    window.getSelection()?.removeAllRanges()
    if (kind === 'explain') onExplain?.(text)
    else onReply?.(text)
  }

  const openCompose = () => {
    // Snapshot the selection's Range BEFORE the click collapses
    // it. We clone so the Range is independent of the live
    // Selection — stays valid as long as the underlying DOM
    // nodes do, which is enough for the compose lifetime. The
    // useEffect above will pick this up on the next render and
    // start tracking it.
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      composingRangeRef.current = sel.getRangeAt(0).cloneRange()
    }
    setComposing(true)
    setCommentText('')
    setComposeError(null)
  }

  const closeCompose = () => {
    setComposing(false)
    setCommentText('')
    setComposeError(null)
    setComposingHighlight(null)
    setComposingPos(null)
    composingRangeRef.current = null
  }

  const saveComment = async () => {
    if (!pos?.anchor || !onComment) return
    const trimmed = commentText.trim()
    if (!trimmed) {
      setComposeError('Add a comment first')
      return
    }
    setBusy(true)
    try {
      await onComment(pos.anchor, trimmed)
      // Defer clearing the composing highlight so the new
      // permanent comment-highlight (rendered by CommentHighlights
      // once `comments` updates) has a chance to paint first. Two
      // rAFs covers layout + paint; without this the user sees a
      // 1-2 frame gap where neither overlay is visible, reading
      // as a flicker.
      setComposing(false)
      setCommentText('')
      setComposeError(null)
      setComposingPos(null)
      setPos(null)
      window.getSelection()?.removeAllRanges()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setComposingHighlight(null)
          composingRangeRef.current = null
        })
      })
    } catch (e) {
      setComposeError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  // While composing, swap the chip for a textarea popover anchored
  // at the same coords. Keeps the user's eye where it was.
  if (composing && pos.anchor && onComment) {
    return (
      <>
        {composingHighlight?.map((r, i) => (
          <div
            key={i}
            style={{
              position: 'fixed',
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
              background:
                'color-mix(in srgb, var(--accent) 24%, transparent)',
              pointerEvents: 'none',
              zIndex: 49,
            }}
          />
        ))}
      <div
        ref={popoverRef}
        className="fixed z-50 rounded-md"
        style={{
          // composingPos tracks the selection as the user scrolls
          // the doc, so the composer stays glued to the
          // highlighted text. Falls back to the initial pos
          // until the first recompute lands (one rAF later).
          top: composingPos?.top ?? pos.top,
          left: composingPos?.left ?? pos.left,
          width: 280,
          // Match the surrounding doc viewer surface so the
          // composer doesn't read as a different "panel" tone in
          // either theme.
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          padding: 10,
          color: 'var(--fg)',
        }}
        onMouseDown={(e) => {
          // Don't let mousedown bubble out — would trigger the
          // outside-click handler and close the composer.
          e.stopPropagation()
        }}
      >
        <div
          className="text-[11px] mb-2 truncate"
          style={{ color: 'var(--subtle)' }}
          title={pos.anchor.quote}
        >
          “{pos.anchor.quote.length > 60 ? pos.anchor.quote.slice(0, 60) + '…' : pos.anchor.quote}”
        </div>
        <textarea
          autoFocus
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          placeholder="Comment…"
          rows={3}
          className="w-full text-[12.5px] rounded outline-none resize-none"
          style={{
            background: 'var(--surface-3)',
            border: '1px solid var(--border)',
            padding: '6px 8px',
            color: 'var(--fg)',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void saveComment()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              closeCompose()
            }
          }}
        />
        {composeError && (
          <div
            className="text-[11px] mt-1.5"
            style={{ color: 'var(--danger-fg)' }}
          >
            {composeError}
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5 mt-2">
          <button
            className="btn-ghost h-7 px-2 text-[12px] inline-flex items-center gap-1"
            onClick={closeCompose}
            disabled={busy}
          >
            <X size={12} /> Cancel
          </button>
          <button
            className="h-7 px-2.5 rounded text-[12px] inline-flex items-center gap-1 font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              opacity: busy ? 0.7 : 1,
            }}
            onClick={() => void saveComment()}
            disabled={busy}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
      </>
    )
  }

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 inline-flex items-center h-8 rounded-md overflow-hidden"
      style={{
        top: pos.top,
        left: pos.left,
        background: 'var(--accent)',
        color: 'white',
      }}
      onMouseDown={(e) => {
        // Prevent the click from collapsing the selection before
        // we read any button.
        e.preventDefault()
      }}
    >
      {onExplain && (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 h-8 text-[12px] font-medium transition-colors hover:bg-white/10"
          onClick={() => dispatch('explain')}
        >
          <Sparkles size={12} />
          Explain
        </button>
      )}
      {onReply && (
        <>
          {onExplain && <div className="h-4 w-px bg-white/25" />}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-2.5 h-8 text-[12px] font-medium transition-colors hover:bg-white/10"
            onClick={() => dispatch('reply')}
          >
            <Quote size={12} />
            Reply
          </button>
        </>
      )}
      {pos.anchor && onComment && (
        <>
          {(onExplain || onReply) && <div className="h-4 w-px bg-white/25" />}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-2.5 h-8 text-[12px] font-medium transition-colors hover:bg-white/10"
            onClick={openCompose}
          >
            <MessageSquarePlus size={12} />
            Comment
          </button>
        </>
      )}
    </div>
  )
}
