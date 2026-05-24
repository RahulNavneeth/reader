import { useEffect, useState } from 'react'
import { Loader2, Plug, AlertCircle, Trash2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

type Client = {
  clientId: string
  clientName: string
  redirectUris: string[]
  softwareId?: string
  softwareVersion?: string
  hasSecret: boolean
  createdAt: number
  createdBy?: string
  activeGrants: number
  lastUsedAt?: number
}

/**
 * Workspace admin view of every registered OAuth client. DCR is open
 * by policy so admins need a way to inspect what's been registered
 * and delete anything rogue or stale. Delete cascades through FK to
 * drop the client's auth codes, access tokens, and refresh tokens.
 */
export function AdminOauthClientsPanel(): JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const confirm = useConfirm()

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await api.adminOauthClients()
      setClients(r.clients)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const remove = async (c: Client) => {
    const ok = await confirm({
      title: `Delete ${c.clientName}?`,
      message:
        c.activeGrants > 0
          ? `This client has ${c.activeGrants} active grant(s). Deleting drops every grant and forces those users to re-authorize.`
          : 'This client has no active grants. Deleting frees the client_id for re-registration.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setDeletingId(c.clientId)
    try {
      await api.adminDeleteOauthClient(c.clientId)
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="space-y-4">
      <div
        className="flex items-center justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div>
          <div className="text-[14px] font-semibold text-fg">OAuth clients</div>
          <div className="text-[11.5px] text-subtle mt-0.5">
            Third-party MCP apps that have self-registered via Dynamic Client
            Registration.
          </div>
        </div>
      </div>

      {error && (
        <div
          className="flex items-start gap-2 px-3 py-2 rounded text-[12px]"
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

      {loading ? (
        <div className="text-subtle text-[12px] py-4">Loading…</div>
      ) : clients.length === 0 ? (
        <div className="text-subtle text-[12px] py-4">
          No clients registered yet. Apps appear here automatically when they
          complete the OAuth flow.
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {clients.map((c) => (
            <li key={c.clientId} className="py-3 flex items-start gap-3">
              <Plug size={13} className="text-muted mt-1 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-fg break-all">
                  {c.clientName}
                </div>
                <div className="text-[11.5px] text-subtle mt-0.5 break-all">
                  <span style={{ background: 'var(--panel-2)', padding: '0 4px', borderRadius: 3 }}>
                    {c.clientId}
                  </span>
                  {c.softwareId && (
                    <>
                      {' · '}
                      {c.softwareId}
                      {c.softwareVersion ? ` ${c.softwareVersion}` : ''}
                    </>
                  )}
                </div>
                <div className="text-[11.5px] text-subtle mt-1">
                  {c.activeGrants > 0 ? (
                    <span style={{ color: 'var(--accent)' }}>
                      {c.activeGrants} active grant{c.activeGrants === 1 ? '' : 's'}
                    </span>
                  ) : (
                    'no active grants'
                  )}
                  {' · '}registered {timeAgo(c.createdAt)}
                  {c.lastUsedAt ? ` · last used ${timeAgo(c.lastUsedAt)}` : ''}
                  {c.hasSecret ? ' · confidential' : ' · public (PKCE)'}
                </div>
                <div className="text-[11px] text-subtle mt-1">
                  {c.redirectUris.map((u, i) => (
                    <span key={u}>
                      {i > 0 && ', '}
                      <span className="break-all">{u}</span>
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="btn-ghost h-7 px-2 text-[11.5px] inline-flex items-center gap-1 shrink-0"
                style={{ color: '#BF2600' }}
                onClick={() => remove(c)}
                disabled={deletingId === c.clientId}
                title="Delete client + cascade-revoke every grant"
              >
                {deletingId === c.clientId ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Trash2 size={11} />
                )}
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
