import { useCallback, useEffect, useState } from 'react'
import type { CommentDTO } from '../lib/api'

type Props = {
  /** Markdown body root — character offsets in comments are
   *  measured from this node. */
  bodyRef: React.RefObject<HTMLElement | null>
  comments: CommentDTO[] | null | undefined
  /** Bumped by the parent when it knows the layout shifted (doc
   *  load, edit-toggle, etc.) so we recompute even if no scroll
   *  or resize fired. */
  recomputeKey?: number
  /** Click handler — fired with the comment whose range was hit by
   *  the click. Parent opens the Comments rail + scrolls to the row. */
  onClickComment?: (c: CommentDTO) => void
}

type HighlightRect = {
  comment: CommentDTO
  top: number
  left: number
  width: number
  height: number
}

/** Walk the bodyRef's text nodes, summing lengths, and return a
 *  Range covering [start, end). Returns null if the offsets are
 *  past the end of the body (which can happen if the doc was
 *  edited and the comment's range drifted). */
function rangeForOffsets(
  root: HTMLElement,
  start: number,
  end: number,
): Range | null {
  if (end <= start) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let pos = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  let cur: Node | null = walker.nextNode()
  while (cur) {
    const t = cur as Text
    const len = t.data.length
    if (startNode === null && pos + len >= start) {
      startNode = t
      startOffset = start - pos
    }
    if (pos + len >= end) {
      endNode = t
      endOffset = end - pos
      break
    }
    pos += len
    cur = walker.nextNode()
  }
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.data.length)))
    range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.data.length)))
    return range
  } catch {
    return null
  }
}

/** Substring fallback: when the offsets drift past the end of the
 *  body (edits ahead of the comment shrank the doc), search the
 *  rendered text for the original quote and rebuild the range from
 *  there. Returns null if the quote no longer appears verbatim. */
function rangeForQuote(root: HTMLElement, quote: string): Range | null {
  const txt = root.textContent ?? ''
  const idx = txt.indexOf(quote)
  if (idx < 0) return null
  return rangeForOffsets(root, idx, idx + quote.length)
}

export function CommentHighlights({
  bodyRef,
  comments,
  recomputeKey,
  onClickComment,
}: Props) {
  const [rects, setRects] = useState<HighlightRect[]>([])

  const compute = useCallback(() => {
    const root = bodyRef.current
    if (!root || !comments || comments.length === 0) {
      setRects([])
      return
    }
    const out: HighlightRect[] = []
    for (const c of comments) {
      if (c.resolved) continue // Resolved comments fade out of the doc; still in the rail.
      // Try the stored offsets first, but VERIFY the resulting
      // range's text matches the saved quote — earlier comment
      // writes shipped with a buggy offset calculator that stored
      // rangeEnd = "everything past the start", which made the
      // highlight balloon to cover the rest of the doc. When the
      // offset-based range doesn't match the quote, fall back to a
      // textContent substring search.
      let range = rangeForOffsets(root, c.rangeStart, c.rangeEnd)
      if (range) {
        const actual = range.toString()
        // Length-only check (cheap); skip strict equality so minor
        // whitespace drift (CRDT autoformatting) doesn't invalidate
        // an otherwise-good range.
        const expectedLen = c.quote.length
        if (actual.length > expectedLen * 3 + 16) {
          // Range is grossly larger than the quote — almost
          // certainly the bad-offset case. Drop it and re-locate
          // by quote.
          range = rangeForQuote(root, c.quote)
        }
      } else {
        range = rangeForQuote(root, c.quote)
      }
      if (!range) continue
      const clientRects = range.getClientRects()
      for (let i = 0; i < clientRects.length; i++) {
        const r = clientRects[i]
        // Skip 0-area rects (line wraps sometimes report one).
        if (r.width === 0 || r.height === 0) continue
        out.push({
          comment: c,
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        })
      }
    }
    // Merge rects that visually overlap so a pixel never gets the
    // tint painted twice (which compounded to a much darker shade
    // and made it look like "double highlighting" on overlapping
    // comments). Two rects on the same line that intersect get
    // collapsed; we keep BOTH source comments' click targets by
    // chaining the on-click to fire whichever was on top. For
    // simplicity here we just keep the first comment as the click
    // target (the rail already shows the full list).
    // Convert from viewport-relative coords to body-relative
    // coords so the overlays can be position:absolute inside the
    // body root. This way they're clipped to the body area and
    // scroll with it natively — no need to recompute on every
    // scroll tick, and no chance of them painting over the
    // toolbar/breadcrumb while scrolling catches up.
    const rootRect = root.getBoundingClientRect()
    for (const r of out) {
      r.top = r.top - rootRect.top + root.scrollTop
      r.left = r.left - rootRect.left + root.scrollLeft
    }
    // Per-line dedupe: getClientRects can return multiple rects
    // for the same visual line (italic sub-rects, glyph-shaping
    // boundaries around `≤`/`→`, leading whitespace ticks).
    // Stacking them with semi-transparent fills compounded into
    // a darker shade — `mix-blend-mode: lighten` didn't fully
    // neutralize the alpha compositing. Keep only the WIDEST
    // rect per (commentId, line) so each line gets exactly one
    // overlay and there's nothing to stack.
    const wideByLine = new Map<string, HighlightRect>()
    for (const r of out) {
      const lineKey = `${r.comment.id}:${Math.round(r.top / 2)}`
      const cur = wideByLine.get(lineKey)
      if (!cur || r.width > cur.width) {
        wideByLine.set(lineKey, r)
      }
    }
    setRects(Array.from(wideByLine.values()))
  }, [bodyRef, comments])

  // Recompute on every input that could change layout: scroll,
  // resize, content mutation, parent re-render via recomputeKey.
  useEffect(() => {
    let rafId: number | null = null
    const schedule = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        compute()
      })
    }
    schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    // Watch for content size changes (images load, expand/collapse,
    // CRDT push-from-server). MutationObserver covers most of these
    // — ResizeObserver on the body would too but generates more
    // noise.
    const root = bodyRef.current
    let mo: MutationObserver | null = null
    let ro: ResizeObserver | null = null
    if (root) {
      mo = new MutationObserver(schedule)
      mo.observe(root, { childList: true, subtree: true, characterData: true })
      ro = new ResizeObserver(schedule)
      ro.observe(root)
    }
    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (mo) mo.disconnect()
      if (ro) ro.disconnect()
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [compute, bodyRef, recomputeKey])

  if (rects.length === 0) return null
  return (
    <>
      {rects.map((r, i) => (
        <div
          key={`${r.comment.id}:${i}`}
          onClick={(e) => {
            e.stopPropagation()
            onClickComment?.(r.comment)
          }}
          title={`${r.comment.author}: ${r.comment.text.length > 80 ? r.comment.text.slice(0, 80) + '…' : r.comment.text}`}
          style={{
            // Position is now body-relative so the overlay clips
            // naturally to the doc area and scrolls with it — no
            // more painting over the toolbar / breadcrumb mid-
            // scroll, and no per-scroll-tick recompute cost.
            position: 'absolute',
            top: r.top,
            left: r.left,
            width: r.width,
            height: r.height,
            // Soft accent tint that's readable over the markdown
            // surface in both light and dark themes. Pointer cursor
            // + auto pointer-events so the click opens the thread
            // instead of just starting a selection.
            background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
            cursor: 'pointer',
            pointerEvents: 'auto',
            zIndex: 0,
          }}
        />
      ))}
    </>
  )
}
