import { useEffect, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import type { Awareness } from 'y-protocols/awareness'

export type Peer = {
  clientId: number
  name: string
  color: string
}

/** Track every OTHER peer's awareness state for a given Y.Doc. The
 *  local clientID is excluded so callers don't show "you, here".
 *  Used by both AwarenessPill (toolbar popover) and DocRail (peers
 *  sidebar section). */
export function usePeers(awareness: Awareness | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([])
  useEffect(() => {
    if (!awareness) {
      setPeers([])
      return
    }
    const refresh = () => {
      const out: Peer[] = []
      const localId = awareness.clientID
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === localId) return
        const user = (state as { user?: { name?: string; color?: string } })
          ?.user
        if (!user?.name) return
        out.push({
          clientId,
          name: String(user.name),
          color: String(user.color ?? 'var(--accent)'),
        })
      })
      // Stable order — without this the chip stack reshuffles on
      // every awareness tick and the eye darts around.
      out.sort((a, b) => a.clientId - b.clientId)
      setPeers(out)
    }
    refresh()
    awareness.on('change', refresh)
    return () => awareness.off('change', refresh)
  }, [awareness])
  // Dedupe by username so two tabs of the same user collapse
  // into a single row in the panel — and so brief overlap on
  // refresh (old WS state lingering for ~30s before y-protocols
  // staleness sweep clears it) doesn't surface as a count
  // bouncing between 1 → 3 → 1. Keep the freshest (highest
  // clientID) entry per name; rendering picks up that one's
  // colour for the avatar swatch.
  const deduped: Peer[] = []
  const seen = new Set<string>()
  for (let i = peers.length - 1; i >= 0; i--) {
    const p = peers[i]
    if (seen.has(p.name)) continue
    seen.add(p.name)
    deduped.unshift(p)
  }
  return deduped
}

export function peerInitial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '•'
  return trimmed.charAt(0).toUpperCase()
}

type Props = {
  awareness: Awareness | null
  /** Layout variant:
   *    `toolbar` — the default horizontal pill (stacked avatar chips
   *                + dropdown below-right).
   *    `rail`    — single Users icon with a tiny count badge,
   *                designed to sit in the DocRail's icon strip. The
   *                popover anchors to the LEFT of the icon since the
   *                rail lives on the right edge of the viewer. */
  variant?: 'toolbar' | 'rail'
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
export function AwarenessPill({ awareness, variant = 'toolbar' }: Props) {
  const peers = usePeers(awareness)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

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
      {variant === 'rail' ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative w-8 h-8 inline-flex items-center justify-center transition-colors hover:bg-[var(--hover)]"
          style={{ color: 'var(--fg-muted)' }}
          title={
            peers.length === 1
              ? `${peers[0].name} is also here · click for details`
              : `${peers.length} other devices · click for details`
          }
          aria-expanded={open}
          aria-label={`Editing now · ${peers.length}`}
        >
          <Users size={12} />
          <span
            className="absolute top-1 right-1 inline-flex items-center justify-center text-[9px] font-semibold rounded-full leading-none"
            style={{
              background: 'var(--accent)',
              color: 'white',
              minWidth: 12,
              height: 12,
              padding: '0 3px',
            }}
          >
            {peers.length}
          </span>
        </button>
      ) : (
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
      )}
      {open && (
        <div
          className={`absolute z-50 w-60 rounded-md overflow-hidden ${
            variant === 'rail'
              ? 'right-full top-0 mr-1'
              : 'right-0 top-full mt-1'
          }`}
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
