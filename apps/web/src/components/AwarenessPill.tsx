import { useEffect, useRef, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'

type Peer = {
  clientId: number
  name: string
  color: string
}

type Props = {
  awareness: Awareness | null
}

function peerInitial(name: string): string {
  // First non-whitespace character, uppercased. Falls back to "•"
  // for an empty name so the chip never collapses to a 0-width
  // gap (would otherwise look like a styling glitch).
  const trimmed = name.trim()
  if (!trimmed) return '•'
  return trimmed.charAt(0).toUpperCase()
}

/**
 * Compact toolbar chip listing every OTHER peer currently attached
 * to this doc's Y.Doc — i.e. other tabs / devices / users editing
 * or viewing alongside you. Hidden when alone (no clutter when
 * the multi-tab story is irrelevant), pops in when a second peer
 * connects.
 *
 * The user's own clientID is excluded so the pill doesn't show
 * "you, here" — only "someone else is also here." Avatars are
 * single-character initials over the peer's awareness colour;
 * stacking with a small offset so 3+ peers don't blow out the
 * toolbar width.
 */
export function AwarenessPill({ awareness }: Props) {
  const [peers, setPeers] = useState<Peer[]>([])
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!awareness) return
    const refresh = () => {
      const out: Peer[] = []
      const localId = awareness.clientID
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === localId) return
        const user = (state as { user?: { name?: string; color?: string } })?.user
        if (!user?.name) return
        out.push({
          clientId,
          name: String(user.name),
          color: String(user.color ?? 'var(--accent)'),
        })
      })
      // Sort by clientId for a stable rendering order; otherwise
      // every refresh re-orders the chips and the eye darts around.
      out.sort((a, b) => a.clientId - b.clientId)
      setPeers(out)
    }
    refresh()
    awareness.on('change', refresh)
    return () => awareness.off('change', refresh)
  }, [awareness])

  // Click-outside dismissal — keeps the popover behaving like the
  // rest of Reader's popovers (UserMenu, ThreadMenu).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const root = containerRef.current
      if (root && !root.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (peers.length === 0) return null

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 h-7 px-1.5 rounded-md text-[11px] transition-colors hover:bg-[var(--hover)]"
        style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          color: 'var(--subtle)',
        }}
        title={
          peers.length === 1
            ? `${peers[0].name} is also here · click for details`
            : `${peers.length} other devices · click for details`
        }
        aria-expanded={open}
      >
        <div className="flex items-center">
          {peers.slice(0, 3).map((p, i) => (
            <div
              key={p.clientId}
              className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold text-white"
              style={{
                background: p.color,
                marginLeft: i === 0 ? 0 : -6,
                border: '1.5px solid var(--surface-2)',
              }}
            >
              {peerInitial(p.name)}
            </div>
          ))}
        </div>
        {peers.length > 3 && (
          <span style={{ color: 'var(--subtle)' }}>+{peers.length - 3}</span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-60 rounded-md shadow-card overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
          }}
        >
          <div
            className="px-3 py-2 text-[11px] font-semibold"
            style={{
              color: 'var(--subtle)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            Editing now · {peers.length}
          </div>
          <ul className="py-1">
            {peers.map((p) => (
              <li
                key={p.clientId}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px]"
              >
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold text-white shrink-0"
                  style={{ background: p.color }}
                >
                  {peerInitial(p.name)}
                </span>
                <span className="text-fg truncate flex-1">{p.name}</span>
                <span
                  className="text-[10.5px] tabular-nums"
                  style={{ color: 'var(--subtle)' }}
                  title="Their cursor uses this colour in the editor"
                >
                  {p.color.startsWith('hsl(')
                    ? p.color.slice(4).split(',')[0] + '°'
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          <div
            className="px-3 py-2 text-[10.5px]"
            style={{
              color: 'var(--subtle)',
              borderTop: '1px solid var(--border)',
            }}
          >
            Their cursors are coloured inline in the editor — open
            Edit mode to see live caret + selection.
          </div>
        </div>
      )}
    </div>
  )
}
