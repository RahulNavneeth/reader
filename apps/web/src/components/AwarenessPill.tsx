import { useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'

type Peer = {
  clientId: number
  name: string
  color: string
}

type Props = {
  awareness: Awareness | null
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

  if (peers.length === 0) return null

  return (
    <div
      className="inline-flex items-center gap-1 h-7 px-1.5 rounded-md text-[11px]"
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border)',
        color: 'var(--subtle)',
      }}
      title={
        peers.length === 1
          ? `${peers[0].name} is also here`
          : `${peers.length} other devices: ${peers.map((p) => p.name).join(', ')}`
      }
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
            {p.name.charAt(0).toUpperCase()}
          </div>
        ))}
      </div>
      {peers.length > 3 && (
        <span style={{ color: 'var(--subtle)' }}>+{peers.length - 3}</span>
      )}
    </div>
  )
}
