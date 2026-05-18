import { type RefObject, useLayoutEffect, useState } from 'react'

/**
 * Resolve where to anchor a popover relative to its trigger so it
 * never spills past the viewport edges.
 *
 * Returns one of:
 *   - 'center' — popover hangs centered under the trigger (default)
 *   - 'right'  — popover anchors to the trigger's right edge,
 *               extending leftward (used when centered would overflow
 *               the right side of the viewport — e.g. a button near
 *               the toolbar's right edge with a 340px popover)
 *   - 'left'   — popover anchors to the trigger's left edge,
 *               extending rightward (symmetric for the left edge)
 *
 * Re-evaluates on open and on window resize so the popover doesn't
 * stay stuck in the wrong slot if the viewport changes while open.
 *
 * The wrapper element measured is whatever the caller passes in as
 * `triggerRef` — the same ref already used for the popover's
 * outside-click handler is the natural choice, since it bounds the
 * trigger button exactly.
 */
export function useAnchoredAlign(opts: {
  triggerRef: RefObject<HTMLElement>
  popoverWidth: number
  open: boolean
  /** Viewport-edge margin to keep clear. Defaults to 8 px so the
   *  popover doesn't kiss the scrollbar / window chrome. */
  margin?: number
}): 'center' | 'left' | 'right' {
  const { triggerRef, popoverWidth, open, margin = 8 } = opts
  const [align, setAlign] = useState<'center' | 'left' | 'right'>('center')

  useLayoutEffect(() => {
    if (!open) return
    const el = triggerRef.current
    if (!el) return
    const recompute = () => {
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const halfW = popoverWidth / 2
      const center = rect.left + rect.width / 2
      if (center + halfW > vw - margin) setAlign('right')
      else if (center - halfW < margin) setAlign('left')
      else setAlign('center')
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [triggerRef, popoverWidth, open, margin])

  return align
}

/** Inline styles for the resolved align value. Designed to match the
 *  popover containers that have `position: absolute` + `top: 100%`. */
export function alignStyle(align: 'center' | 'left' | 'right'): React.CSSProperties {
  if (align === 'right') return { right: 0 }
  if (align === 'left') return { left: 0 }
  return { left: '50%', transform: 'translateX(-50%)' }
}
