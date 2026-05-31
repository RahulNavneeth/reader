import type { CSSProperties, MouseEvent } from 'react'

/**
 * Standardised file/folder selection affordance — the checkbox half
 * of "tinted background + corner checkbox" that's used everywhere
 * the user can multi-select rows or tiles.
 *
 * Settled on this shape after surveying FolderGrid (used it),
 * Timeline (was using a 2px outline + chip — out of step), and
 * the empty bulk-select states on Archive / Trash / Collections.
 * One source of truth makes the next surface (bulk Restore on
 * Archive, bulk Purge on Trash) a one-import affair.
 *
 * Sibling helpers:
 *   - `selectionTileStyle(selected)` — the tile wrapper background
 *     + outline values, also extracted so every grid uses the same
 *     tint / accent ring.
 *
 * The component is visual-only — wire up the click handler at the
 * call site so each surface can decide whether the indicator
 * itself toggles, or the whole tile toggles (Finder-style), or
 * both. We accept `onClick` so the caller can attach a handler
 * AND stop propagation when needed.
 */

export interface SelectIndicatorProps {
  checked: boolean
  /** Show the indicator at all. Most call sites show on hover OR
   *  when checked — see `visibility` for the standard pattern. */
  visible?: boolean
  /** Click handler — receives the event so callers can call
   *  `stopPropagation()` to keep the parent tile's onClick from
   *  also firing. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  /** Top/left/right/bottom offsets in `px`. Default places the
   *  indicator at the top-left of a relative-positioned tile. */
  position?: { top?: number; left?: number; right?: number; bottom?: number }
  /** Override the title / aria-label. Defaults to "Select" /
   *  "Selected". */
  title?: string
  /** `light` (default) — the checkbox renders dark on light
   *  surface, suitable for tinted-background tiles.
   *  `over-image` — adds a translucent scrim behind the box so
   *  it stays legible on photo / map thumbnails. */
  variant?: 'light' | 'over-image'
}

export function SelectIndicator({
  checked,
  visible = true,
  onClick,
  position,
  title,
  variant = 'light',
}: SelectIndicatorProps) {
  if (!visible) return null
  const pos: CSSProperties = {
    position: 'absolute',
    top: position?.top ?? 6,
    left: position?.left ?? 6,
    right: position?.right,
    bottom: position?.bottom,
    // Sit above any later-rendered tile content. The Timeline /
    // Archive tiles render their icon + label via an
    // `absolute inset-0` div AFTER the indicator; without this
    // z-index the indicator gets painted behind the tile's
    // viewer-coloured fill and disappears.
    zIndex: 10,
  }
  // Unchecked: solid `var(--bg)` fill with `var(--border)` outline
  // — the same recipe Timeline's hover-only check uses. Reads as
  // a small "page-surface" pill stamped on the tile in both
  // themes. Looks clean and matches the unified style the user
  // wanted across every grid (FolderGrid, Timeline, Archive,
  // Trash, etc.).
  //
  // The `over-image` variant keeps its translucent-white fallback
  // because photo / video thumbnails don't have a theme-tinted
  // background to contrast against — the image is whatever the
  // user uploaded.
  const boxStyle: CSSProperties =
    variant === 'over-image'
      ? {
          background: checked
            ? 'var(--accent)'
            : 'rgba(255, 255, 255, 0.9)',
          border: checked ? '1px solid var(--accent)' : 'none',
        }
      : {
          background: checked ? 'var(--accent)' : 'var(--bg)',
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
        }
  const wrapper: CSSProperties = pos
  return (
    <span style={wrapper}>
      <button
        type="button"
        onClick={(e) => {
          if (onClick) onClick(e)
        }}
        className="w-4 h-4 rounded flex items-center justify-center transition-colors"
        style={boxStyle}
        title={title ?? (checked ? 'Selected' : 'Select')}
        aria-label={title ?? (checked ? 'Selected' : 'Select')}
        aria-pressed={checked}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6L5 9L10 3"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </span>
  )
}

/** Background + outline styles for the surrounding tile. Apply
 *  via the spread operator onto the tile's `style` prop. Keeps
 *  the tint + ring identical across every selection grid. */
export function selectionTileStyle(
  checked: boolean,
  hover: boolean = false,
): CSSProperties {
  return {
    background: checked
      ? 'var(--selected)'
      : hover
        ? 'var(--hover)'
        : 'transparent',
    outline: checked ? '1px solid var(--accent)' : undefined,
    outlineOffset: checked ? '-1px' : undefined,
  }
}
