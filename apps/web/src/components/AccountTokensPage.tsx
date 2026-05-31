import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Plus,
  Loader2,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  KeyRound,
} from 'lucide-react'
import { ApiError, api, type ApiTokenInfo } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { copyText } from '../lib/clipboard'
import {
  MetaDot,
  SettingsListCard,
  SettingsListEmpty,
  SettingsListRow,
} from './SettingsList'

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
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ background: 'var(--surface-3)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/')}
          title="Back to vault"
          aria-label="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <KeyRound size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">API tokens</div>
        {tokens && tokens.length > 0 && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {tokens.length} {tokens.length === 1 ? 'token' : 'tokens'}
          </span>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1080px] mx-auto px-8 py-6 space-y-10">

        {error && (
          <div
            className="px-3 py-2 rounded text-[12.5px] inline-flex items-start gap-2"
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-fg)',
              border: '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
            }}
          >
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {newSecret && (
          <section
            className="rounded-md overflow-hidden"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
            }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <KeyRound size={12} className="text-accent shrink-0" />
              <div className="text-[12.5px] font-medium text-fg">
                Copy your new token
              </div>
              <span className="text-subtle">·</span>
              <div className="text-[11.5px] text-subtle">
                you won't see it again
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <div
                className="flex-1 px-2.5 h-8 rounded text-[12.5px] flex items-center break-all"
                style={{
                  background: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  color: 'var(--fg)',
                }}
              >
                {newSecret}
              </div>
              <button
                className="btn-ghost h-8 shrink-0"
                onClick={async () => {
                  const ok = await copyText(newSecret)
                  if (!ok) {
                    setError(
                      'Could not copy to clipboard automatically. Select the token above and copy it manually.',
                    )
                    return
                  }
                  setError(null)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                title={copied ? 'Copied' : 'Copy'}
              >
                {copied ? (
                  <>
                    <Check size={12} className="text-accent" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    Copy
                  </>
                )}
              </button>
              <button
                className="btn-ghost h-8 shrink-0"
                onClick={() => setNewSecret(null)}
              >
                Done
              </button>
            </div>
          </section>
        )}

        <Section title="Create a token">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              className="input flex-1 h-8 text-[13px]"
              placeholder="Token name (e.g., claude-mcp, ci-job)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
              disabled={busy}
            />
            <button className="btn-primary h-8" onClick={create} disabled={busy || !name.trim()}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create
            </button>
          </div>
        </Section>

        <Section title={`Your tokens${tokens && tokens.length > 0 ? ` · ${tokens.length}` : ''}`}>
          {!tokens ? null : tokens.length === 0 ? (
            <SettingsListEmpty
              title="No tokens yet"
              hint="Create one above to call the MCP / REST API as yourself."
            />
          ) : (
            <SettingsListCard>
              {tokens.map((t) => (
                <SettingsListRow
                  key={t.id}
                  icon={<KeyRound size={14} className="text-subtle" />}
                  title={t.name}
                  meta={
                    <>
                      <span>{t.id}…</span>
                      <MetaDot />
                      <span>{t.role}</span>
                      <MetaDot />
                      <span>{t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
                      <MetaDot />
                      <span>
                        {t.expiresAt
                          ? `expires ${new Date(t.expiresAt).toLocaleDateString()}`
                          : 'no expiry'}
                      </span>
                    </>
                  }
                  actions={
                    <button
                      className="btn-ghost-danger"
                      onClick={() => remove(t)}
                      title="Revoke token"
                      aria-label="Revoke token"
                    >
                      <Trash2 size={12} />
                    </button>
                  }
                />
              ))}
            </SettingsListCard>
          )}
        </Section>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div
        className="text-[14px] font-semibold text-fg pb-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {title}
      </div>
      <div className="pl-0.5">{children}</div>
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
