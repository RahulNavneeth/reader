import { useEffect, useMemo, useRef, useState } from 'react'
import { Users, Loader2, X } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

type Share = {
  recipient: string
  canEdit: boolean
}

/**
 * Per-collection "Share with a user" anchored popover. Shaped to
 * match MakePublicPopover / ShareWithUserButton so all three
 * access-control affordances on the collection detail page read as
 * the same component family.
 *
 * Hits the collection-specific endpoints (`/api/collections/:id/shares`)
 * instead of the per-file share endpoints — same UX, different
 * persistence.
 */
export function CollectionShareButton({
  collectionId,
  shares,
  onChanged,
}: {
  collectionId: string
  shares: Share[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
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

  const create = async () => {
    const r = recipient.trim()
    if (!r) return
    setBusy(true)
    setError(null)
    try {
      await api.shareCollection(collectionId, { recipient: r, canEdit })
      setRecipient('')
      setCanEdit(false)
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const togglePermission = async (s: Share) => {
    setRowBusy(s.recipient)
    setError(null)
    try {
      await api.shareCollection(collectionId, {
        recipient: s.recipient,
        canEdit: !s.canEdit,
      })
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRowBusy(null)
    }
  }

  const revoke = async (recipient: string) => {
    setRowBusy(recipient)
    setError(null)
    try {
      await api.unshareCollection(collectionId, recipient)
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRowBusy(null)
    }
  }

  const triggerLabel = useMemo(() => {
    if (shares.length === 0) return 'Share'
    if (shares.length === 1) return `Shared · ${shares[0].recipient}`
    return `Shared · ${shares.length}`
  }, [shares])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Share with another user"
        aria-expanded={open}
        style={{
          ...(shares.length > 0 ? { color: 'var(--accent)' } : null),
          ...(open ? { background: 'var(--selected)', color: 'var(--accent)' } : null),
        }}
      >
        <Users size={13} />
        <span className="truncate max-w-[160px]">{triggerLabel}</span>
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
            <Users size={13} className="text-muted" />
            <span className="text-[12px] font-semibold text-fg flex-1">
              Share with a user
            </span>
            <span className="text-[10.5px] text-subtle">
              {shares.length === 0 ? 'Not shared' : `Shared with ${shares.length}`}
            </span>
          </div>
          <div className="p-3 space-y-2" style={{ borderBottom: '1px solid var(--border-soft)' }}>
            <input
              className="input h-7 text-[12.5px]"
              placeholder="Username"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              autoFocus
            />
            <label className="flex items-center gap-2 text-[12px] text-fg">
              <input
                type="checkbox"
                checked={canEdit}
                onChange={(e) => setCanEdit(e.target.checked)}
              />
              Allow this user to edit
            </label>
            <button
              className="btn-primary w-full h-7"
              onClick={create}
              disabled={busy || !recipient.trim()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />}
              Share
            </button>
            {error && (
              <div className="text-[11px]" style={{ color: '#BF2600' }}>
                {error}
              </div>
            )}
          </div>
          {shares.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto">
              {shares.map((s) => (
                <div
                  key={s.recipient}
                  className="flex items-center gap-2 px-3 py-1.5"
                  style={{ borderTop: '1px solid var(--border-soft)' }}
                >
                  <span className="text-[12px] text-fg flex-1 truncate">{s.recipient}</span>
                  <button
                    className="text-[10.5px] font-medium px-1.5 h-5 rounded"
                    onClick={() => togglePermission(s)}
                    disabled={rowBusy === s.recipient}
                    title={`Click to switch to ${s.canEdit ? 'read-only' : 'edit'}`}
                    style={{
                      background: s.canEdit ? 'var(--selected)' : 'var(--bg)',
                      color: s.canEdit ? 'var(--accent)' : 'var(--fg)',
                      border: '1px solid var(--border-soft)',
                    }}
                  >
                    {s.canEdit ? 'edit' : 'read-only'}
                  </button>
                  <button
                    className="btn-ghost h-6 w-6 px-0"
                    onClick={() => revoke(s.recipient)}
                    disabled={rowBusy === s.recipient}
                    title="Revoke"
                    style={{ color: '#BF2600' }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
