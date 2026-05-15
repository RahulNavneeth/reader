import { useEffect, useRef, useState } from 'react'
import { Globe, Lock, Copy, Check, Loader2 } from 'lucide-react'
import { ApiError, api, type DocumentMeta } from '../lib/api'

type Props = {
  path: string
  meta: DocumentMeta
  onSaved: (next: DocumentMeta) => void
}

const EXPIRY_OPTIONS: Array<{ label: string; seconds: number | null }> = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 86400 * 7 },
  { label: '30 days', seconds: 86400 * 30 },
  { label: 'Never', seconds: null },
]

/**
 * Public-visibility control. Replaces the old ShareButton/Public-toggle pair
 * with a single popover that:
 *
 *   - flips the file Public/Private
 *   - configures optional expiry (relative seconds)
 *   - configures optional password (sent as the doc's publicPasswordHash)
 *   - copies the public URL (the regular /docs/<rel> link)
 *
 * The server stores expiry + password on the DocumentMeta itself, so the
 * public URL is stable across sessions — no opaque tokens.
 */
export function PublicButton({ path, meta, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState<number | null>(86400 * 7)
  const [password, setPassword] = useState('')
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  // Friendly /docs/<rel> URL — stable, no token.
  const sharingUrl = `${window.location.origin}/docs/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sharingUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const setPublic = async (nextPublic: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.setVisibility(path, nextPublic, {
        expiresInSeconds: nextPublic ? expiry : null,
        password: nextPublic ? (password || null) : null,
      })
      onSaved(r.document)
      if (nextPublic) {
        // Refresh the local password input so we don't show a stale value.
        setPassword('')
      }
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
        title={meta.public ? 'Public — configure' : 'Make public'}
        style={meta.public ? { color: '#00875A' } : undefined}
      >
        {meta.public ? <Globe size={13} /> : <Lock size={13} />}
        {meta.public ? 'Public' : 'Private'}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          {meta.public ? (
            <div className="p-3 space-y-2">
              <div className="text-[12.5px] font-medium text-fg">This file is public</div>
              <div className="text-[11px] text-subtle">
                {meta.publicPasswordHash ? 'Password-protected · ' : 'Open · '}
                {meta.publicExpiresAt
                  ? `expires ${new Date(meta.publicExpiresAt).toLocaleString()}`
                  : 'never expires'}
              </div>
              <div
                className="flex items-stretch rounded overflow-hidden"
                style={{ border: '1px solid var(--border-soft)' }}
              >
                <button
                  type="button"
                  onClick={copy}
                  className="flex-1 text-left px-2 py-1 text-[11px] truncate"
                  style={{ background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'ui-monospace, monospace' }}
                  title="Click to copy"
                >
                  {sharingUrl}
                </button>
                <button
                  type="button"
                  onClick={copy}
                  className="px-2 inline-flex items-center gap-1 text-[11px] font-medium"
                  style={{
                    background: copied ? 'var(--selected)' : 'var(--panel)',
                    color: copied ? 'var(--accent)' : 'var(--fg)',
                    borderLeft: '1px solid var(--border-soft)',
                  }}
                >
                  {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                </button>
              </div>
              <button
                className="btn-ghost w-full"
                onClick={() => setPublic(false)}
                disabled={busy}
                style={{ color: '#BF2600' }}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                Make private
              </button>
              {error && (
                <div className="text-[11px]" style={{ color: '#BF2600' }}>
                  {error}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 space-y-2">
              <div className="text-[12.5px] font-medium text-fg">Make this file public</div>
              <div className="text-[11px] text-subtle">
                Anyone with the link will be able to open it.
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="input h-7 text-[12px]"
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
                  className="input h-7 text-[12px]"
                  placeholder="Password (optional)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button
                className="btn-primary w-full h-7"
                onClick={() => setPublic(true)}
                disabled={busy}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
                Make public
              </button>
              {error && (
                <div className="text-[11px]" style={{ color: '#BF2600' }}>
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
