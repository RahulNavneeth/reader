import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { api } from '../lib/api'

type Props = {
  path: string
  owner?: string
  isFolder?: boolean
  onChanged?: () => void
}

/**
 * Toolbar pin/unpin toggle. Reads the user's pin list on mount to seed
 * its visual state, then flips optimistically — the API call goes out
 * in the background, the UI doesn't wait. This is what makes the
 * button feel snappy: clicking doesn't swap the star for a spinner
 * mid-frame. If the server rejects (extremely rare for an authed
 * write), we revert the local state. The parent's `onChanged` callback
 * is fired after the API confirms so dependent surfaces (sidebar) only
 * refetch on durable state.
 */
export function PinButton({ path, owner, isFolder, onChanged }: Props) {
  const [pinned, setPinned] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listPins()
      .then((r) => {
        if (cancelled) return
        const norm = path.replace(/^\/+|\/+$/g, '')
        const ownerKey = owner || ''
        const match = r.pins.some(
          (p) =>
            p.storageKey === norm &&
            (ownerKey === '' ? true : p.owner === ownerKey),
        )
        setPinned(match)
      })
      .catch(() => setPinned(false))
    return () => {
      cancelled = true
    }
  }, [path, owner])

  const toggle = () => {
    if (pinned == null) return
    const next = !pinned
    // Optimistic — flip immediately so the click feels instant.
    setPinned(next)
    const op = next
      ? api.addPin({ path, owner, isFolder })
      : api.removePin({ path, owner })
    op.then(
      () => onChanged?.(),
      () => {
        // Server rejected the write — undo the optimistic flip.
        setPinned(!next)
      },
    )
  }

  return (
    <button
      className="btn-ghost"
      onClick={toggle}
      title={pinned ? 'Unpin' : 'Pin to sidebar'}
      disabled={pinned == null}
      style={
        pinned
          ? { color: 'var(--accent)', background: 'var(--selected)' }
          : undefined
      }
    >
      <Star
        size={13}
        fill={pinned ? 'currentColor' : 'none'}
        strokeWidth={1.8}
      />
      {pinned ? 'Pinned' : 'Pin'}
    </button>
  )
}
