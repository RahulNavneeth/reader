import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  KeyRound,
  Plus,
  Loader2,
  Trash2,
  Copy,
  Check,
  AlertCircle,
} from 'lucide-react'
import { ApiError, api, type ApiTokenInfo } from '../lib/api'
import { useConfirm } from '../lib/confirm'

/**
 * User-scoped API token management at /account/tokens. Mints + lists
 * tokens whose `createdBy` is the caller. Tokens inherit the caller's
 * role — admins can mint admin tokens, editors can only mint editor.
 * The secret is shown ONCE on create; after that only the prefix.
 */
export function AccountTokensPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = () =>
    api
      .accountTokens()
      .then((r) => setTokens(r.tokens))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    setNewSecret(null)
    try {
      const r = await api.accountCreateToken(name.trim())
      setNewSecret(r.secret)
      setName('')
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (t: ApiTokenInfo) => {
    const ok = await confirm({
      title: 'Revoke token',
      message: `"${t.name}" will be invalidated immediately. Any MCP client or script using it will stop working.`,
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await api.accountDeleteToken(t.id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <div className="flex-1 overflow-y-auto surface">
      <div className="max-w-[1080px] mx-auto px-8 py-10">
        <button className="btn-ghost mb-4" onClick={() => navigate('/account')}>
          <ArrowLeft size={13} /> Back to account
        </button>

        <header className="mb-6">
          <div className="text-[26px] font-semibold text-fg leading-tight inline-flex items-center gap-2.5">
            <KeyRound size={20} className="text-accent" />
            API tokens
          </div>
          <div className="text-[13px] text-muted mt-1.5">
            Bearer tokens for the MCP endpoint at <code>/mcp</code> and the
            REST API. Each token acts as you — same role, same vault.
            Revoke any time.
          </div>
        </header>

        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2"
            style={{ background: '#FFEBE6', color: '#BF2600' }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {newSecret && (
          <section
            className="mb-6 rounded-xl p-4"
            style={{
              background: 'rgba(76, 110, 245, 0.08)',
              border: '1px solid var(--accent)',
            }}
          >
            <div className="text-[13px] font-semibold text-fg mb-2">
              Copy your new token — you won't see it again.
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 px-3 py-2 rounded text-[12.5px] break-all"
                style={{ background: 'var(--bg)', border: '1px solid var(--border-soft)' }}
              >
                {newSecret}
              </code>
              <button
                className="btn-ghost shrink-0"
                onClick={async () => {
                  await navigator.clipboard.writeText(newSecret)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check size={12} className="text-accent" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                className="btn-ghost shrink-0"
                onClick={() => setNewSecret(null)}
                title="Dismiss"
              >
                Done
              </button>
            </div>
          </section>
        )}

        <section
          className="rounded-xl p-4 mb-6"
          style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
        >
          <div className="text-[13px] font-semibold text-fg mb-2.5">Create a token</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              className="input flex-1 h-8 text-[12.5px]"
              placeholder="Token name (e.g., claude-mcp, ci-job)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
              disabled={busy}
            />
            <button className="btn-ghost" onClick={create} disabled={busy || !name.trim()}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create
            </button>
          </div>
        </section>

        <section>
          <div className="text-[13px] font-semibold text-fg mb-2">Your tokens</div>
          {!tokens ? (
            <div className="text-[12.5px] text-muted inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : tokens.length === 0 ? (
            <div
              className="rounded-xl p-6 text-center"
              style={{ background: 'var(--panel)', border: '1px dashed var(--border)' }}
            >
              <div className="text-[13px] text-fg font-medium">No tokens yet</div>
              <div className="text-[12px] text-muted mt-1">
                Create one above to call the MCP / REST API as yourself.
              </div>
            </div>
          ) : (
            <div
              className="rounded-xl overflow-hidden"
              style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
            >
              {tokens.map((t, i) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 px-4 py-3"
                  style={{ borderTop: i === 0 ? undefined : '1px solid var(--border-soft)' }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] font-medium text-fg truncate">{t.name}</div>
                    <div className="text-[11.5px] text-subtle mt-0.5">
                      <code>{t.id}…</code> · {t.role} ·{' '}
                      {t.lastUsedAt
                        ? `last used ${timeAgo(t.lastUsedAt)}`
                        : 'never used'}{' '}
                      ·{' '}
                      {t.expiresAt
                        ? `expires ${new Date(t.expiresAt).toLocaleDateString()}`
                        : 'no expiry'}
                    </div>
                  </div>
                  <button
                    className="btn-ghost shrink-0"
                    onClick={() => remove(t)}
                    style={{ color: '#BF2600' }}
                    title="Revoke token"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
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
