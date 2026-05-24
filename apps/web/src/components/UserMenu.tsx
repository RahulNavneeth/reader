import { useEffect, useRef, useState } from 'react'
import {
  LogOut,
  Shield,
  User as UserIcon,
  Settings,
  Trash2,
  MapPin,
  Clock,
  Layers,
  KeyRound,
  Send,
  Plug,
  Download,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type PublicUser } from '../lib/api'

type Props = {
  user: PublicUser
  onLogout: () => void
}

export function UserMenu({ user, onLogout }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const isAdmin = user.role === 'admin'
  const [reindexing, setReindexing] = useState(false)
  const [reindexResult, setReindexResult] = useState<{
    ok: boolean
    msg: string
  } | null>(null)

  const runReindex = async () => {
    if (reindexing) return
    setReindexing(true)
    setReindexResult(null)
    try {
      const r = await api.accountReembed()
      const ok = r.failed === 0
      const parts = [`${r.ok}/${r.total} ok`]
      if (r.failed > 0) parts.push(`${r.failed} failed`)
      if (r.removed > 0) parts.push(`${r.removed} stale removed`)
      setReindexResult({ ok, msg: parts.join(' · ') })
      // Auto-clear the status after a few seconds so the dropdown
      // returns to a clean state next time it's opened.
      setTimeout(() => setReindexResult(null), 5_000)
    } catch (e) {
      setReindexResult({
        ok: false,
        msg: e instanceof ApiError ? e.message : String(e),
      })
    } finally {
      setReindexing(false)
    }
  }

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost" onClick={() => setOpen((o) => !o)} title={user.username}>
        <UserIcon size={14} />
        <span className="hidden sm:inline">{user.username}</span>
        {isAdmin && <Shield size={12} className="text-accent ml-0.5" />}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[220px] rounded-md shadow-raised z-50 overflow-hidden"
          style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
        >
          <div
            className="px-3 py-2 border-b"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="text-[13px] font-medium text-fg truncate">{user.username}</div>
            <div className="text-[11.5px] text-muted capitalize flex items-center gap-1">
              {isAdmin && <Shield size={10} />}
              {user.role}
            </div>
          </div>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/timeline')
            }}
          >
            <Clock size={13} className="text-muted" />
            Timeline
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/collections')
            }}
          >
            <Layers size={13} className="text-muted" />
            Collections
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/map')
            }}
          >
            <MapPin size={13} className="text-muted" />
            Map
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/trash')
            }}
          >
            <Trash2 size={13} className="text-muted" />
            Trash
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors border-t"
            style={{ borderColor: 'var(--border)' }}
            onClick={() => {
              setOpen(false)
              navigate('/account/tokens')
            }}
          >
            <KeyRound size={13} className="text-muted" />
            API tokens
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/account/webhooks')
            }}
          >
            <Send size={13} className="text-muted" />
            Webhooks
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/account/connected-apps')
            }}
          >
            <Plug size={13} className="text-muted" />
            Connected apps
          </button>
          <a
            href={api.exportUrl()}
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors no-underline"
            onClick={() => setOpen(false)}
          >
            <Download size={13} className="text-muted" />
            Export vault
          </a>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors disabled:opacity-60"
            onClick={runReindex}
            disabled={reindexing}
          >
            {reindexing ? (
              <Loader2 size={13} className="text-muted animate-spin" />
            ) : reindexResult?.ok ? (
              <Check size={13} className="text-accent" />
            ) : reindexResult ? (
              <AlertCircle size={13} style={{ color: '#BF2600' }} />
            ) : (
              <RefreshCw size={13} className="text-muted" />
            )}
            <span className="flex-1">
              {reindexing ? 'Re-indexing…' : 'Re-index my files'}
            </span>
          </button>
          {reindexResult && !reindexing && (
            <div
              className="px-3 pb-2 text-[11px]"
              style={{ color: reindexResult.ok ? 'var(--fg-subtle)' : '#BF2600' }}
            >
              {reindexResult.msg}
            </div>
          )}
          {isAdmin && (
            <button
              className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors border-t"
              style={{ borderColor: 'var(--border)' }}
              onClick={() => {
                setOpen(false)
                navigate('/settings')
              }}
            >
              <Settings size={13} className="text-muted" />
              Workspace settings
            </button>
          )}
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors border-t"
            style={{ borderColor: 'var(--border)' }}
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
          >
            <LogOut size={13} className="text-muted" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

