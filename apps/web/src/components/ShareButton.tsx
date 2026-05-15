import { useEffect, useRef, useState } from 'react'
import { Share2, Copy, Trash2, Loader2, X, Lock, Globe2 } from 'lucide-react'
import { ApiError, api, type ShareInfo } from '../lib/api'

type Props = { path: string }

const EXPIRY_OPTIONS: Array<{ label: string; seconds: number | null }> = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 86400 * 7 },
  { label: '30 days', seconds: 86400 * 30 },
  { label: 'Never', seconds: null },
]

/**
 * Doc-viewer header trigger that opens a popover for creating + managing
 * share links. Each share is a token-addressable URL (/s/<token>) gated by
 * optional password and/or expiry.
 */
export function ShareButton({ path }: Props) {
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<ShareInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState<number | null>(86400 * 7)
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = () =>
    api
      .listShares(path)
      .then((r) => setShares(r.shares))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    if (!open) return
    refresh()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.createShare(path, {
        expiresInSeconds: expiry,
        password: password || undefined,
        label: label || undefined,
      })
      setPassword('')
      setLabel('')
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
      await api.deleteShare(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const linkOf = (id: string) => `${window.location.origin}/s/${id}`

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Create or manage share links"
      >
        <Share2 size={13} />
        Share
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[360px] rounded-md shadow-card overflow-hidden"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <div
            className="px-3 py-2 space-y-2"
            style={{ borderBottom: '1px solid var(--border-soft)' }}
          >
            <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
              New share link
            </div>
            <input
              className="input h-7 text-[12.5px]"
              placeholder="Label (optional, just for you)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                className="input h-7 text-[12.5px]"
                value={expiry === null ? 'null' : String(expiry)}
                onChange={(e) => setExpiry(e.target.value === 'null' ? null : Number(e.target.value))}
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={o.seconds === null ? 'null' : o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                type="password"
                className="input h-7 text-[12.5px]"
                placeholder="Password (optional)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button
              className="btn-primary w-full h-7"
              onClick={create}
              disabled={busy}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
              Create link
            </button>
            {error && (
              <div className="text-[11px]" style={{ color: '#BF2600' }}>
                {error}
              </div>
            )}
          </div>

          <div className="max-h-[260px] overflow-y-auto">
            {shares == null ? (
              <div className="px-3 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : shares.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-subtle">No active share links.</div>
            ) : (
              shares.map((s) => (
                <div
                  key={s.id}
                  className="px-3 py-2"
                  style={{ borderTop: '1px solid var(--border-soft)' }}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-fg truncate">
                        {s.label || s.id}
                      </div>
                      <div className="text-[10.5px] text-subtle flex items-center gap-1.5">
                        {s.hasPassword ? (
                          <span className="inline-flex items-center gap-0.5">
                            <Lock size={9} /> password
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5">
                            <Globe2 size={9} /> open
                          </span>
                        )}
                        <span>·</span>
                        <span>
                          {s.expiresAt
                            ? `expires ${formatRel(s.expiresAt)}`
                            : 'never expires'}
                        </span>
                        <span>·</span>
                        <span>{s.accessCount} view{s.accessCount === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                    <button
                      className="btn-ghost h-6 w-6 px-0"
                      onClick={() => navigator.clipboard.writeText(linkOf(s.id))}
                      title="Copy link"
                    >
                      <Copy size={11} />
                    </button>
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
                  <code
                    className="block mt-1 px-1.5 py-1 rounded text-[10.5px] break-all"
                    style={{ background: 'var(--bg)', border: '1px solid var(--border-soft)' }}
                  >
                    {linkOf(s.id)}
                  </code>
                </div>
              ))
            )}
          </div>
          {shares && shares.length > 0 && (
            <div
              className="px-3 py-1.5 text-[10.5px] text-subtle"
              style={{ borderTop: '1px solid var(--border-soft)' }}
            >
              <Trash2 size={9} className="inline mr-0.5" /> = revoke
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatRel(ts: number): string {
  const ms = ts - Date.now()
  if (ms < 0) return 'expired'
  const s = Math.round(ms / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h}h`
  const d = Math.round(h / 24)
  return `in ${d}d`
}
