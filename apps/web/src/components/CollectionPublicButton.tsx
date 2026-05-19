import { useEffect, useRef, useState } from 'react'
import { Globe, Lock, Loader2, Copy, Check } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'
import { copyText } from '../lib/clipboard'

type Props = {
  collectionId: string
  isPublic: boolean
  publicSlug: string | null | undefined
  publicExpiresAt: number | null | undefined
  hasPassword: boolean
  onChanged: () => void
}

/**
 * Per-collection public-link control. Two modes inside the same
 * popover shape as MakePublicPopover:
 *   - Off  → form with optional password + preset expiry, Publish button
 *   - On   → slug URL + Copy + status line + Revoke
 *
 * Header bar status pill flips between "Off" and "On" so the
 * trigger button's deeper state is visible at a glance — matches
 * the per-file Public popover.
 */
export function CollectionPublicButton({
  collectionId,
  isPublic,
  publicSlug,
  publicExpiresAt,
  hasPassword,
  onChanged,
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [requirePassword, setRequirePassword] = useState(false)
  const [expiry, setExpiry] = useState<'1' | '7' | '30' | 'never'>('7')
  const [error, setError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
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

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      const expiresInSeconds =
        expiry === 'never' ? null : Number(expiry) * 24 * 60 * 60
      await api.publishCollection(collectionId, {
        isPublic: true,
        expiresInSeconds,
        password: requirePassword ? password.trim() || null : null,
      })
      setPassword('')
      setRequirePassword(false)
      setExpiry('7')
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const unpublish = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.publishCollection(collectionId, { isPublic: false })
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (!publicSlug) return
    const url = `${window.location.origin}/pc/${publicSlug}`
    const ok = await copyText(url)
    if (!ok) {
      setError('Could not copy automatically — select the URL above to copy manually.')
      return
    }
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  const Icon = isPublic ? Globe : Lock
  const triggerLabel = isPublic ? 'Public' : 'Private'

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title={isPublic ? 'Public link is on' : 'Publish a public link'}
        aria-expanded={open}
        style={{
          // Open default: accent text. Public state overrides with
          // the green tint (matches per-file PublicButton). Background
          // always flips to selected when open.
          ...(open ? { color: 'var(--accent)' } : null),
          ...(isPublic ? { color: '#00875A' } : null),
          ...(open ? { background: 'var(--selected)' } : null),
        }}
      >
        <Icon size={13} />
        {triggerLabel}
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
            <Globe size={13} className="text-muted" />
            <span className="text-[12px] font-semibold text-fg flex-1">
              Public link
            </span>
            <span
              className="text-[10.5px]"
              style={{ color: isPublic ? 'var(--accent)' : 'var(--fg-subtle)' }}
            >
              {isPublic ? 'On' : 'Off'}
            </span>
          </div>
          {isPublic && publicSlug ? (
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 px-2 py-1.5 rounded text-[11.5px] truncate"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border-soft)' }}
                >
                  {window.location.origin}/pc/{publicSlug}
                </code>
                <button className="btn-ghost h-7" onClick={copyLink} title="Copy URL">
                  {linkCopied ? <Check size={12} className="text-accent" /> : <Copy size={12} />}
                  {linkCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="text-[11px] text-subtle">
                {hasPassword ? 'Password-gated · ' : ''}
                {publicExpiresAt
                  ? `expires ${new Date(publicExpiresAt).toLocaleDateString()}`
                  : 'no expiry'}
              </div>
              <button
                className="btn-ghost h-7 self-start"
                onClick={unpublish}
                disabled={busy}
                style={{ color: '#BF2600' }}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
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
              <label className="flex items-center gap-2 text-[12px] text-fg">
                <span className="text-subtle min-w-[60px]">Expires</span>
                <select
                  className="input h-7 text-[12.5px] flex-1"
                  value={expiry}
                  onChange={(e) =>
                    setExpiry(e.target.value as '1' | '7' | '30' | 'never')
                  }
                  disabled={busy}
                >
                  <option value="1">in 1 day</option>
                  <option value="7">in 7 days</option>
                  <option value="30">in 30 days</option>
                  <option value="never">never</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-[12px] text-fg">
                <input
                  type="checkbox"
                  checked={requirePassword}
                  onChange={(e) => {
                    setRequirePassword(e.target.checked)
                    if (!e.target.checked) setPassword('')
                  }}
                />
                Require a password
              </label>
              {requirePassword && (
                <input
                  type="text"
                  className="input h-7 text-[12.5px]"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              )}
              <button
                className="btn-primary w-full h-7"
                onClick={publish}
                disabled={busy || (requirePassword && !password.trim())}
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
