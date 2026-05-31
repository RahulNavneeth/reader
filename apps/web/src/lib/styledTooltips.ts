/**
 * Replaces native browser `title` tooltips on `.btn-ghost` buttons
 * with the theme-styled CSS tooltip (see `.btn-ghost[data-tooltip]`
 * in index.css). The browser's default tooltip fires after ~700ms
 * AND overlaps our styled one — two tooltips for the same button
 * look broken. Stripping `title` on mount + watching for newly-
 * inserted buttons via MutationObserver keeps the styled one
 * exclusive.
 *
 * Mount once at app startup. Idempotent: subsequent calls no-op.
 */

let started = false

function migrate(el: Element): void {
  if (!(el instanceof HTMLElement)) return
  if (!el.classList.contains('btn-ghost')) return
  if (el.hasAttribute('data-no-tooltip')) return
  const title = el.getAttribute('title')
  if (!title) return
  el.setAttribute('data-tooltip', title)
  el.removeAttribute('title')
}

function scanAll(root: ParentNode): void {
  for (const el of root.querySelectorAll('.btn-ghost[title]')) migrate(el)
}

export function initStyledTooltips(): void {
  if (started) return
  if (typeof document === 'undefined') return
  started = true
  // Initial pass on whatever is already in the DOM.
  scanAll(document)
  // Watch for future button mounts (React renders, popovers, etc).
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target instanceof HTMLElement) {
        migrate(m.target)
        continue
      }
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          migrate(node)
          scanAll(node)
        }
      }
    }
  })
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['title', 'class'],
  })
}
