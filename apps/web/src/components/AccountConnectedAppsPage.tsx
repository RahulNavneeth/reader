import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Plug, AlertCircle, Trash2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

type Grant = {
  clientId: string
  clientName: string
  scopes: string[]
  createdAt: number
  lastUsedAt?: number
}

type Prefs = { revokeOauthOnSignout: boolean }

/**
 * Connected Apps — third-party MCP clients (Claude Desktop, Cursor,
 * Inspector, etc.) that the user authorized via the OAuth flow. One
 * row per (this user, client) pair. Revoke drops every access +
 * refresh token; the client app then needs to re-walk the consent
 * flow to reconnect.
 */
export function AccountConnectedAppsPage(): JSX.Element {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [grants, setGrants] = useState<Grant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Prefs>({ revokeOauthOnSignout: false })
  const [savingPref, setSavingPref] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const [g, me] = await Promise.all([api.accountOauthGrants(), api.me()])
      setGrants(g.grants)
      setPrefs({ revokeOauthOnSignout: !!me.user?.revokeOauthOnSignout })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const togglePref = async () => {
    const next = !prefs.revokeOauthOnSignout
    setSavingPref(true)
    setPrefs({ revokeOauthOnSignout: next })
    try {
      await api.accountUpdatePreferences({ revokeOauthOnSignout: next })
    } catch (e) {
      setPrefs({ revokeOauthOnSignout: !next }) // roll back
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSavingPref(false)
    }
  }

  const revoke = async (g: Grant) => {
    const ok = await confirm({
      title: `Revoke ${g.clientName}?`,
      message:
        'This app will lose access immediately. It can reconnect by going through the authorization flow again.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    setRevokingId(g.clientId)
    try {
      await api.accountRevokeOauthGrant(g.clientId)
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rail)' }}>
      <div
        className="flex items-center gap-2 px-4 h-11 shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0"
          onClick={() => navigate('/')}
          aria-label="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <Plug size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">Connected apps</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6">
          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'var(--viewer)', border: '1px solid var(--border)' }}
          >
            <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="text-[14px] font-semibold text-fg">MCP clients</div>
              <div className="text-[11.5px] text-subtle mt-0.5">
                Third-party apps that have asked for access to your vault via the
                OAuth consent flow.
              </div>
            </div>
            {error && (
              <div
                className="px-4 py-2 flex items-start gap-2 text-[12px]"
                style={{
                  background: 'color-mix(in srgb, #BF2600 12%, transparent)',
                  color: '#BF2600',
                }}
              >
                <AlertCircle size={12} className="mt-0.5" />
                <span className="flex-1">{error}</span>
                <button onClick={() => setError(null)} className="text-[11px] underline">
                  dismiss
                </button>
              </div>
            )}
            <div
              className="px-4 py-3 flex items-start gap-3"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
                <input
                  type="checkbox"
                  checked={prefs.revokeOauthOnSignout}
                  onChange={togglePref}
                  disabled={savingPref}
                  className="mt-0.5 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-fg">
                    Revoke all connected apps when I sign out
                  </div>
                  <div className="text-[11px] text-subtle mt-0.5">
                    Off by default — OAuth grants are normally independent of
                    your browser session. Turn this on if you want
                    &ldquo;sign out everywhere&rdquo; behavior.
                  </div>
                </div>
              </label>
              {savingPref && <Loader2 size={12} className="animate-spin text-subtle mt-1" />}
            </div>
            {loading ? (
              <div className="px-4 py-4 text-[12px] text-subtle">Loading…</div>
            ) : grants.length === 0 ? (
              <div className="px-4 py-4 text-[12px] text-subtle">
                No connected apps. Apps that complete the OAuth flow will show up
                here.
              </div>
            ) : (
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {grants.map((g) => (
                  <li key={g.clientId} className="px-4 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-fg">{g.clientName}</div>
                      <div className="text-[11.5px] text-subtle mt-0.5">
                        Connected {timeAgo(g.createdAt)}
                        {g.lastUsedAt
                          ? ` · last used ${timeAgo(g.lastUsedAt)}`
                          : ' · never used'}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {g.scopes.map((s) => (
                          <span
                            key={s}
                            className="inline-flex items-center px-1.5 h-4 rounded text-[10.5px]"
                            style={{ background: 'var(--hover)', color: 'var(--fg-subtle)' }}
                          >
                            {s.replace(/^tool:/, '')}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      className="btn-ghost h-7 px-2 text-[11.5px] inline-flex items-center gap-1 shrink-0"
                      style={{ color: '#BF2600' }}
                      onClick={() => revoke(g)}
                      disabled={revokingId === g.clientId}
                      title="Revoke this app's access"
                    >
                      {revokingId === g.clientId ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Trash2 size={11} />
                      )}
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
