import { useEffect, useRef, useState } from 'react'
import { Users, Loader2, X } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Props = { path: string }

type ShareRow = {
  id: string
  recipient: string
  canEdit: boolean
  isFolder: boolean
}

/**
 * Private user-to-user share control. Owner picks another username and
 * (optionally) grants edit access. The recipient sees the path in their
 * sidebar's "Shared with me" section.
 */
export function ShareWithUserButton({ path }: Props) {
  const [open, setOpen] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shares, setShares] = useState<ShareRow[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    refresh()
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path])

  const refresh = async () => {
    try {
      const r = await api.listUserSharesFrom()
      const rows = r.shares
        .filter((s) => s.storageKey === path)
        .map((s) => ({ id: s.id, recipient: s.recipient, canEdit: s.canEdit, isFolder: s.isFolder }))
      setShares(rows)
    } catch (e) {
      setShares([])
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const create = async () => {
    if (!recipient.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.createUserShare({ path, recipient: recipient.trim(), canEdit })
      setRecipient('')
      setCanEdit(false)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteUserShare(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button className="btn-ghost" onClick={() => setOpen((v) => !v)} title="Share with another user">
        <Users size={13} />
        Share
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <div className="p-3 space-y-2" style={{ borderBottom: '1px solid var(--border-soft)' }}>
            <div className="text-[12.5px] font-medium text-fg">Share with a user</div>
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
          <div className="max-h-[200px] overflow-y-auto">
            {shares == null ? (
              <div className="px-3 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : shares.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-subtle">Not shared with anyone yet.</div>
            ) : (
              shares.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 px-3 py-1.5"
                  style={{ borderTop: '1px solid var(--border-soft)' }}
                >
                  <span className="text-[12px] text-fg flex-1 truncate">{s.recipient}</span>
                  <span className="text-[10.5px] text-subtle">{s.canEdit ? 'edit' : 'read-only'}</span>
                  <button
                    className="btn-ghost h-6 w-6 px-0"
                    onClick={() => revoke(s.id)}
                    disabled={busy}
                    title="Revoke"
                    style={{ color: '#BF2600' }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
