import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'

type Props = {
  /** The container whose text selections should trigger the popover.
   *  Selections outside this element (chat sidebar, toolbar, outline)
   *  are ignored. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Called when the user clicks the popover button. */
  onExplain: (selectedText: string) => void
}

/**
 * Floating "Explain with Reader AI" button that appears near the
 * user's text selection inside the doc viewer. Position-anchored to
 * the selection's bounding rect so it follows wherever the user
 * dragged.
 *
 * Skips selections that:
 *   - are empty / collapsed
 *   - are outside the containerRef (e.g. in the chat sidebar)
 *   - have fewer than 5 chars (likely accidental)
 *
 * Long selections are passed through verbatim — the parent decides
 * how to trim before sending to the chat.
 */
export function SelectionPopover({ containerRef, onExplain }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number; text: string } | null>(null)
  const popoverRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const onSelectionChange = () => {
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

      const POPOVER_HEIGHT = 32
      const POPOVER_WIDTH = 168
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
      setPos({ top, left, text })
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
  }, [containerRef])

  if (!pos) return null

  return (
    <button
      ref={popoverRef}
      className="fixed z-50 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[12px] font-medium transition-transform hover:scale-105"
      style={{
        top: pos.top,
        left: pos.left,
        background: 'var(--accent)',
        color: 'white',
        boxShadow: '0 6px 18px rgba(15, 23, 42, 0.18)',
      }}
      onMouseDown={(e) => {
        // Prevent the click from collapsing the selection before
        // we read it.
        e.preventDefault()
      }}
      onClick={() => {
        const text = pos.text
        setPos(null)
        // Clear the selection so the popover doesn't immediately
        // re-pop on the next selectionchange fire.
        window.getSelection()?.removeAllRanges()
        onExplain(text)
      }}
    >
      <Sparkles size={12} />
      Explain with Reader AI
    </button>
  )
}
