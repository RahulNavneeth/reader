import { useEffect, useRef, useState } from 'react'
import { Globe, Lock } from 'lucide-react'
import { ApiError } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

type Props = {
  /** Override the trigger label. Defaults to `Public (N)`. */
  triggerLabel?: string
  /** Count surfaced in the default trigger label and body copy. */
  publicCount?: number
  /** Whether the target itself has a single cascading public link
   *  (file is published, or folder is cascade-published). When false
   *  the body falls back to "N items publicly accessible" — used by
   *  the folder toolbar when only descendants are individually public
   *  and the folder itself has no URL. */
  folderPublic: boolean
  folderExpiresAt?: number | null
  folderHasPassword?: boolean
  /** Action invoked when the user clicks "Make private". Throw to
   *  surface an error inside the popover; resolve to close it. */
  onRevoke: () => Promise<void>
}

/**
 * "Public" trigger + revoke popover used by both single files and folder
 * toolbars. Click opens a minimal popover with the expiry summary and a
 * single "Make private" link — files revoke themselves, folders cascade
 * the revoke through every nested file and sub-folder.
 *
 * Deliberately bare: no URL/Copy row inside, since the URL is just the
 * bare path the user can construct mentally and we wanted file +
 * folder popovers to be visually identical.
 */
export function RevokePublicPopover({
  triggerLabel,
  publicCount = 1,
  folderPublic,
  folderExpiresAt,
  folderHasPassword,
  onRevoke,
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const resolvedAlign = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 340,
    open,
  })

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRevoke()
      setOpen(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title={
          publicCount > 1
            ? `Revoke ${publicCount} public items`
            : 'Public — configure'
        }
        aria-expanded={open}
        // The Public button always tints accent-green; when the
        // popover is open we deepen the background so the active
        // state matches the other toolbar triggers.
        style={{ color: '#00875A', ...(open ? { background: 'var(--selected)' } : null) }}
      >
        <Globe size={13} />
        {triggerLabel ?? `Public (${publicCount})`}
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            ...alignStyle(resolvedAlign),
          }}
        >
          <div
            className="flex items-center gap-2 px-3 h-8"
            style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border-soft)' }}
          >
            <Globe size={13} style={{ color: '#00875A' }} />
            <span className="text-[12px] font-semibold text-fg">Public link</span>
          </div>
          <div className="p-3 space-y-2">
            <div className="flex items-center gap-2 text-[11px]">
              <div className="flex-1 text-subtle">
                {folderPublic ? (
                  <>
                    <span>
                      {folderExpiresAt
                        ? `Expires ${describeExpiry(folderExpiresAt)}`
                        : 'Never expires'}
                    </span>
                    {folderHasPassword && (
                      <span className="inline-flex items-center gap-1 ml-1">
                        <span>·</span>
                        <Lock size={10} />
                        <span className="text-fg">Password protected</span>
                      </span>
                    )}
                  </>
                ) : (
                  <span>
                    {publicCount} item{publicCount === 1 ? '' : 's'} publicly accessible
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={revoke}
                disabled={busy}
                className="text-[11px] font-medium hover:underline shrink-0"
                style={{ color: '#BF2600' }}
              >
                {busy ? 'Working…' : 'Make private'}
              </button>
            </div>
            {error && (
              <div className="text-[11px]" style={{ color: '#BF2600' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function describeExpiry(ts: number): string {
  const ms = ts - Date.now()
  if (ms < 0) return 'expired'
  const days = ms / 86_400_000
  if (days < 1) {
    const hours = Math.max(1, Math.round(ms / 3_600_000))
    return `in ${hours}h`
  }
  if (days < 14) return `in ${Math.round(days)} days`
  return `on ${new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`
}
