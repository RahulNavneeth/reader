import clsx from 'clsx'
import type { Heading } from '../types'

export function TOC({ headings, active }: { headings: Heading[]; active: string | null }) {
  if (headings.length === 0) return null
  return (
    <nav className="px-4 py-6 sticky top-0">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-3">On this page</div>
      <ul className="space-y-1">
        {headings.map((h, i) => (
          <li key={`${h.id}-${i}`}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault()
                const el = document.getElementById(h.id)
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                history.replaceState(null, '', `#${h.id}`)
              }}
              className={clsx(
                'block text-[12.5px] py-0.5 border-l-2 transition-colors hover:text-fg',
                active === h.id
                  ? 'text-accent font-medium'
                  : 'text-muted',
              )}
              style={{
                paddingLeft: 8 + (h.level - 1) * 10,
                borderLeftColor: active === h.id ? 'var(--accent)' : 'transparent',
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
