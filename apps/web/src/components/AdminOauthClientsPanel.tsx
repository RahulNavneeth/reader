import { useEffect, useState } from 'react'
import { Loader2, Plug, AlertCircle, Trash2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import {
  MetaDot,
  SettingsListCard,
  SettingsListEmpty,
  SettingsListRow,
} from './SettingsList'

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
 *
 * Visual style follows the Trash page: each entry is a row inside a
 * single bordered viewer-surface card, two lines of text per row
 * (title + dot-separated subtle metadata), inline action buttons.
 * Drops the previous per-id badge chip in favour of plain text so
 * the list reads as a continuous list, not a wall of pills.
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
          className="px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2"
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

      {loading ? (
        <div className="text-subtle text-[12.5px] py-4">Loading…</div>
      ) : clients.length === 0 ? (
        <SettingsListEmpty
          title="No clients registered"
          hint="Apps show up here automatically when they complete an OAuth flow."
        />
      ) : (
        <SettingsListCard>
          {clients.map((c) => {
            const idShort = c.clientId.length > 28 ? c.clientId.slice(0, 26) + '…' : c.clientId
            const grants =
              c.activeGrants > 0
                ? `${c.activeGrants} active grant${c.activeGrants === 1 ? '' : 's'}`
                : 'no active grants'
            const sw = c.softwareId
              ? `${c.softwareId}${c.softwareVersion ? ` ${c.softwareVersion}` : ''}`
              : null
            return (
              <SettingsListRow
                key={c.clientId}
                icon={<Plug size={14} className="text-subtle" />}
                title={c.clientName}
                meta={
                  <>
                    <span>{idShort}</span>
                    <MetaDot />
                    <span style={c.activeGrants > 0 ? { color: 'var(--accent)' } : undefined}>
                      {grants}
                    </span>
                    <MetaDot />
                    <span>registered {timeAgo(c.createdAt)}</span>
                    <MetaDot />
                    <span>{c.hasSecret ? 'confidential' : 'public (PKCE)'}</span>
                    {sw && (
                      <>
                        <MetaDot />
                        <span>{sw}</span>
                      </>
                    )}
                    {c.lastUsedAt && (
                      <>
                        <MetaDot />
                        <span>last used {timeAgo(c.lastUsedAt)}</span>
                      </>
                    )}
                  </>
                }
                actions={
                  <button
                    className="btn-ghost-danger"
                    onClick={() => remove(c)}
                    disabled={deletingId === c.clientId}
                    title="Delete client + cascade-revoke every grant"
                    aria-label="Delete OAuth client"
                  >
                    {deletingId === c.clientId ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    Delete
                  </button>
                }
              />
            )
          })}
        </SettingsListCard>
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
