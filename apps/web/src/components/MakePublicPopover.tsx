import { useEffect, useRef, useState } from 'react'
import { Globe, Lock, Loader2 } from 'lucide-react'

type Props = {
  /** Element rendered as the popover trigger (the toolbar button). */
  trigger: React.ReactNode
  /** Title shown in the header. e.g. "Public link" or "Make 4 public". */
  title: string
  /** Submit handler — receives the chosen expiry + password, returns when done. */
  onConfirm: (opts: { expiresInSeconds: number | null; password: string | null }) => Promise<void>
  /** Label on the confirm button. */
  confirmLabel?: string
  /** Anchor side — defaults to right edge. */
  align?: 'left' | 'right'
}

const EXPIRY_OPTIONS: Array<{ label: string; seconds: number | null }> = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 86400 * 7 },
  { label: '30 days', seconds: 86400 * 30 },
  { label: 'Never', seconds: null },
]

/**
 * Reusable "make public" popover with expiry + optional password. Shared
 * between PathViewer's single-file PublicButton and FolderGrid's bulk
 * Public action so both flows offer the same options.
 */
export function MakePublicPopover({
  trigger,
  title,
  onConfirm,
  confirmLabel = 'Make public',
  align = 'right',
}: Props) {
  const [open, setOpen] = useState(false)
  const [expiry, setExpiry] = useState<number | null>(86400 * 7)
  const [requirePassword, setRequirePassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm({
        expiresInSeconds: expiry,
        password: requirePassword ? password : null,
      })
      setOpen(false)
      setRequirePassword(false)
      setPassword('')
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <span onClick={() => setOpen((v) => !v)} className="inline-flex">
        {trigger}
      </span>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
          }}
        >
          <div
            className="flex items-center gap-2 px-3 h-8"
            style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border-soft)' }}
          >
            <Lock size={13} className="text-muted" />
            <span className="text-[12px] font-semibold text-fg flex-1">{title}</span>
            <span className="text-[10.5px] text-subtle">Off</span>
          </div>
          <div className="p-3 space-y-2">
            <select
              className="input h-7 text-[12.5px]"
              value={expiry === null ? 'null' : String(expiry)}
              onChange={(e) => setExpiry(e.target.value === 'null' ? null : Number(e.target.value))}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.seconds === null ? 'null' : o.seconds}>
                  Expires after {o.label.toLowerCase()}
                </option>
              ))}
            </select>
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
                autoFocus
              />
            )}
            <button
              className="btn-primary w-full h-7"
              onClick={submit}
              disabled={busy || (requirePassword && !password.trim())}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
              {confirmLabel}
            </button>
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
