import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Plug, AlertCircle, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { SettingsListCard, SettingsListEmpty } from './SettingsList'

type Grant = {
  clientId: string
  clientName: string
  scopes: string[]
  createdAt: number
  lastUsedAt?: number
}

type Prefs = { revokeOauthOnSignout: boolean }

/** Scope categories used to bucket the granted scopes into tidy
 *  rows in the connected-app card. Keys are display labels; values
 *  are the bare tool names (the `tool:` prefix gets stripped before
 *  the lookup). `meta` is a catch-all bucket for any leftover scope
 *  that doesn't match — the MCP scope itself, for instance. */
const SCOPE_GROUPS: Array<{ label: string; tools: string[] }> = [
  { label: 'Identity', tools: ['whoami'] },
  {
    label: 'Browse',
    tools: [
      'list_documents',
      'list_folder',
      'resolve_path',
      'list_pins',
      'list_tags',
      'list_versions',
    ],
  },
  { label: 'Read', tools: ['get_document', 'get_outline', 'get_section', 'get_chunk'] },
  { label: 'Search', tools: ['search_knowledge'] },
  {
    label: 'Edit',
    tools: [
      'replace_section',
      'insert_after',
      'append_to_section',
      'delete_section',
      'append_text',
      'prepend_text',
    ],
  },
  { label: 'Upload', tools: ['upload_text', 'upload_file', 'upload_from_url'] },
  {
    label: 'Organize',
    tools: [
      'set_tags',
      'set_visibility',
      'pin',
      'unpin',
      'move_file',
      'mkdir',
      'rmdir',
      'delete_document',
      'restore_version',
    ],
  },
  { label: 'PDF', tools: ['get_pdf_outline', 'pdf_page_count', 'pdf_page_text'] },
  { label: 'CSV', tools: ['csv_columns', 'csv_rows', 'csv_query'] },
]

function groupScopes(scopes: string[]): Array<{ label: string; names: string[] }> {
  const bare = new Set(scopes.map((s) => s.replace(/^tool:/, '')))
  const out: Array<{ label: string; names: string[] }> = []
  const seen = new Set<string>()
  for (const g of SCOPE_GROUPS) {
    const names = g.tools.filter((t) => bare.has(t))
    if (names.length === 0) continue
    names.forEach((n) => seen.add(n))
    out.push({ label: g.label, names })
  }
  const leftover = [...bare].filter((n) => !seen.has(n))
  if (leftover.length > 0) {
    out.push({ label: 'Other', names: leftover.sort() })
  }
  return out
}

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
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--surface-3)' }}>
      <div
        className="flex items-center gap-2 px-4 h-11 shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}
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
        <div className="max-w-2xl mx-auto p-6 space-y-4">
          <div>
            <div className="text-[14px] font-semibold text-fg">MCP clients</div>
            <div className="text-[11.5px] text-subtle mt-0.5">
              Third-party apps that have asked for access to your vault via the
              OAuth consent flow.
            </div>
          </div>

          {error && (
            <div
              className="px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2 w-full"
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger-fg)',
                border: '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
              }}
            >
              <AlertCircle size={13} />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-[11.5px] underline">
                dismiss
              </button>
            </div>
          )}

          <div
            className="rounded-md p-3 flex items-start gap-3"
            style={{ background: 'var(--viewer)', border: '1px solid var(--border)' }}
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
            <div className="text-subtle text-[12.5px] py-4">Loading…</div>
          ) : grants.length === 0 ? (
            <SettingsListEmpty
              title="No connected apps"
              hint="Apps that complete the OAuth flow show up here."
            />
          ) : (
            <SettingsListCard>
              {grants.map((g) => (
                <ConnectedAppRow
                  key={g.clientId}
                  grant={g}
                  busy={revokingId === g.clientId}
                  onRevoke={() => revoke(g)}
                />
              ))}
            </SettingsListCard>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Single connected-app row. Different from a stock `SettingsListRow`
 * because the user wants to see EVERY granted scope, not a truncated
 * preview — so the scope list lives on its own wrappable line below
 * the standard meta line and ignores `truncate`.
 */
function ConnectedAppRow({
  grant,
  busy,
  onRevoke,
}: {
  grant: Grant
  busy: boolean
  onRevoke: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Plug size={14} className="text-subtle shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg truncate">{grant.clientName}</div>
        <div className="text-[11.5px] text-subtle mt-0.5">
          <span>Connected {timeAgo(grant.createdAt)}</span>
          <span className="mx-1.5 opacity-60">·</span>
          <span>
            {grant.lastUsedAt ? `last used ${timeAgo(grant.lastUsedAt)}` : 'never used'}
          </span>
          <span className="mx-1.5 opacity-60">·</span>
          {grant.scopes.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-baseline gap-0.5 underline-offset-2 hover:underline focus:outline-none focus:underline"
              aria-expanded={expanded}
              aria-controls={`scopes-${grant.clientId}`}
            >
              {expanded ? (
                <ChevronDown size={11} className="self-center" />
              ) : (
                <ChevronRight size={11} className="self-center" />
              )}
              <span>
                {grant.scopes.length} scope{grant.scopes.length === 1 ? '' : 's'}
              </span>
            </button>
          ) : (
            <span>no scopes</span>
          )}
        </div>
        {grant.scopes.length > 0 && expanded && (
          <ol
            id={`scopes-${grant.clientId}`}
            className="mt-2 space-y-1.5 text-[11.5px] leading-relaxed"
          >
            {groupScopes(grant.scopes).map((g, gi) => (
              <li key={g.label}>
                <div className="flex items-baseline gap-1.5 text-fg">
                  <span className="text-subtle tabular-nums w-5 text-right">
                    {gi + 1}.
                  </span>
                  <span className="font-medium">{g.label}</span>
                </div>
                <ol className="ml-7 mt-0.5 space-y-0.5">
                  {g.names.map((n, ni) => (
                    <li
                      key={n}
                      className="flex items-baseline gap-1.5 text-subtle"
                    >
                      <span className="tabular-nums w-8 text-right opacity-70">
                        {gi + 1}.{ni + 1}
                      </span>
                      <span>{n}</span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </div>
      <button
        className="btn-ghost-danger shrink-0"
        onClick={onRevoke}
        disabled={busy}
        title="Revoke this app's access"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        Revoke
      </button>
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
