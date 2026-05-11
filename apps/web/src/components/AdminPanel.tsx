import { useEffect, useState } from 'react'
import { Copy, Plus, Shield, Trash2, X, KeyRound, Users as UsersIcon } from 'lucide-react'
import clsx from 'clsx'
import { ApiError, api, type ApiTokenInfo, type PublicUser, type Role } from '../lib/api'

type Tab = 'users' | 'tokens'

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center pt-[6vh] px-4" style={{ background: 'rgba(9,30,66,0.45)' }} onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-lg shadow-raised overflow-hidden flex flex-col"
        style={{ background: 'var(--bg)', border: '1px solid var(--border)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 px-4 flex items-center gap-3 border-b border-soft shrink-0" style={{ borderColor: 'var(--border-soft)' }}>
          <Shield size={14} className="text-accent" />
          <div className="text-[13.5px] font-semibold text-fg">Admin</div>
          <div className="flex items-center gap-1 ml-2">
            <TabButton active={tab === 'users'} onClick={() => setTab('users')}>
              <UsersIcon size={13} /> Users
            </TabButton>
            <TabButton active={tab === 'tokens'} onClick={() => setTab('tokens')}>
              <KeyRound size={13} /> API tokens
            </TabButton>
          </div>
          <div className="flex-1" />
          <button className="btn-ghost" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tab === 'users' ? <UsersTab /> : <TokensTab />}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className={clsx('flex items-center gap-1 px-2.5 h-7 rounded text-[12.5px] font-medium transition-colors', active && 'text-accent')}
      style={{ background: active ? 'var(--accent-bg)' : 'transparent', color: active ? 'var(--accent)' : 'var(--fg-muted)' }}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function UsersTab() {
  const [users, setUsers] = useState<PublicUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.adminUsers().then((r) => setUsers(r.users)).catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
  }, [])

  if (error) return <div className="p-6 text-[13px]" style={{ color: '#BF2600' }}>{error}</div>
  if (!users) return <div className="p-6 text-[13px] text-muted">Loading…</div>

  return (
    <div className="p-4">
      <div className="text-[11.5px] uppercase tracking-wider font-semibold text-subtle mb-2 px-1">{users.length} user{users.length === 1 ? '' : 's'}</div>
      <div className="rounded border border-app overflow-hidden">
        <table className="w-full text-[13px]">
          <thead style={{ background: 'var(--panel)' }}>
            <tr className="text-left text-[11.5px] uppercase tracking-wider text-subtle">
              <th className="px-3 py-2 font-semibold">Username</th>
              <th className="px-3 py-2 font-semibold">Role</th>
              <th className="px-3 py-2 font-semibold">Created</th>
              <th className="px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username} className="border-t border-soft" style={{ borderColor: 'var(--border-soft)' }}>
                <td className="px-3 py-2 font-medium text-fg">{u.username}</td>
                <td className="px-3 py-2 capitalize text-muted">{u.role}</td>
                <td className="px-3 py-2 text-muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="px-3 py-2">
                  {u.disabled ? (
                    <span className="text-[11.5px]" style={{ color: '#BF2600' }}>disabled</span>
                  ) : (
                    <span className="text-[11.5px]" style={{ color: '#00875A' }}>active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TokensTab() {
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('viewer')
  const [justCreated, setJustCreated] = useState<{ secret: string; name: string } | null>(null)

  const refresh = () =>
    api.adminTokens().then((r) => setTokens(r.tokens)).catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const r = await api.adminCreateToken(newName.trim(), newRole)
      setJustCreated({ secret: r.secret, name: r.token.name })
      setNewName('')
      setNewRole('viewer')
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this token? Agents using it will be disconnected immediately.')) return
    try {
      await api.adminDeleteToken(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  if (error) return <div className="p-6 text-[13px]" style={{ color: '#BF2600' }}>{error}</div>

  return (
    <div className="p-4 space-y-4">
      <div className="rounded border border-app p-3" style={{ background: 'var(--panel)' }}>
        <div className="text-[12px] uppercase tracking-wider font-semibold text-subtle mb-2">New API token</div>
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            placeholder="Name (e.g., laptop-claude)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <select
            className="input"
            style={{ width: 120 }}
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as Role)}
          >
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
          <button className="btn-primary" onClick={create} disabled={creating || !newName.trim()}>
            <Plus size={14} />
            Create
          </button>
        </div>
        <div className="text-[11.5px] text-subtle mt-2">
          Tokens authenticate <code className="px-1 py-0.5 rounded" style={{ background: 'var(--code-bg)' }}>POST /mcp</code> for AI agents (Claude, etc.). The secret is shown ONCE — copy it now.
        </div>
      </div>

      {justCreated && (
        <div className="rounded border p-3" style={{ background: '#E3FCEF', borderColor: '#ABF5D1' }}>
          <div className="text-[12px] font-semibold mb-1" style={{ color: '#006644' }}>Secret for "{justCreated.name}" — copy now</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1.5 rounded text-[12px] truncate" style={{ background: '#FFFFFF', border: '1px solid #ABF5D1' }}>{justCreated.secret}</code>
            <button
              className="btn"
              onClick={() => navigator.clipboard.writeText(justCreated.secret)}
            >
              <Copy size={13} />
              Copy
            </button>
            <button className="btn-ghost" onClick={() => setJustCreated(null)}>
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {!tokens && <div className="text-[13px] text-muted px-1">Loading…</div>}
      {tokens && tokens.length === 0 && (
        <div className="text-[13px] text-muted px-1">No tokens yet.</div>
      )}
      {tokens && tokens.length > 0 && (
        <div className="rounded border border-app overflow-hidden">
          <table className="w-full text-[13px]">
            <thead style={{ background: 'var(--panel)' }}>
              <tr className="text-left text-[11.5px] uppercase tracking-wider text-subtle">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">ID</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Created</th>
                <th className="px-3 py-2 font-semibold">Last used</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-t border-soft" style={{ borderColor: 'var(--border-soft)' }}>
                  <td className="px-3 py-2 font-medium text-fg">{t.name}</td>
                  <td className="px-3 py-2 text-muted font-mono text-[11.5px]">{t.id}…</td>
                  <td className="px-3 py-2 capitalize text-muted">{t.role}</td>
                  <td className="px-3 py-2 text-muted">{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-muted">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn-ghost" onClick={() => revoke(t.id)} title="Revoke">
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
