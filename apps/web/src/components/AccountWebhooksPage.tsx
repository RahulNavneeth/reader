import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Send,
  Plus,
  Loader2,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

type WebhookEvent = 'upload' | 'edit' | 'delete' | 'share' | 'tags' | 'visibility'
type Webhook = {
  id: string
  url: string
  events: WebhookEvent[]
  secret?: string
  enabled?: boolean
  createdAt: number
  owner?: string
  lastDelivery?: { ts: number; status: number | null; error?: string }
}

const ALL_EVENTS: WebhookEvent[] = ['upload', 'edit', 'delete', 'share', 'tags', 'visibility']

/**
 * User-scoped webhook management at /account/webhooks. Hooks fire only
 * for events on this user's files (event.actor === owner). Admins still
 * see global hooks; users only see hooks they own.
 */
export function AccountWebhooksPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(ALL_EVENTS))
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    api
      .accountWebhooks()
      .then((r) => setHooks(r.webhooks))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const toggleEvent = (ev: WebhookEvent) => {
    setEvents((cur) => {
      const next = new Set(cur)
      if (next.has(ev)) next.delete(ev)
      else next.add(ev)
      return next
    })
  }

  const create = async () => {
    if (!url.trim() || events.size === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.accountCreateWebhook({
        url: url.trim(),
        events: Array.from(events),
        secret: secret.trim() || undefined,
      })
      setUrl('')
      setSecret('')
      setEvents(new Set(ALL_EVENTS))
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (h: Webhook) => {
    const ok = await confirm({
      title: 'Delete webhook',
      message: `Events will stop being delivered to ${h.url}. Existing deliveries already sent aren't affected.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await api.accountDeleteWebhook(h.id)
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
            <Send size={20} className="text-accent" />
            Webhooks
          </div>
          <div className="text-[13px] text-muted mt-1.5">
            POST a JSON payload to your URL whenever something happens to
            your files. Add a secret and Reader signs each delivery with
            an HMAC-SHA256 in <code>X-Reader-Signature</code>.
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

        <section
          className="rounded-xl p-4 mb-6"
          style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
        >
          <div className="text-[13px] font-semibold text-fg mb-2.5">Add a webhook</div>
          <div className="space-y-2.5">
            <input
              className="input w-full h-8 text-[12.5px]"
              placeholder="Webhook URL (https://…)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
            <input
              className="input w-full h-8 text-[12.5px]"
              placeholder="Signing secret (optional)"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={busy}
            />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider font-semibold text-subtle mr-1">
                Events
              </span>
              {ALL_EVENTS.map((ev) => {
                const on = events.has(ev)
                return (
                  <button
                    key={ev}
                    onClick={() => toggleEvent(ev)}
                    className="inline-flex items-center px-2 h-6 rounded text-[11.5px]"
                    style={{
                      background: on ? 'var(--selected)' : 'var(--bg)',
                      color: on ? 'var(--accent)' : 'var(--fg)',
                      border: '1px solid var(--border-soft)',
                    }}
                    disabled={busy}
                  >
                    {ev}
                  </button>
                )
              })}
            </div>
            <div className="flex justify-end pt-1">
              <button
                className="btn-ghost"
                onClick={create}
                disabled={busy || !url.trim() || events.size === 0}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Add webhook
              </button>
            </div>
          </div>
        </section>

        <section>
          <div className="text-[13px] font-semibold text-fg mb-2">Your webhooks</div>
          {!hooks ? (
            <div className="text-[12.5px] text-muted inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : hooks.length === 0 ? (
            <div
              className="rounded-xl p-6 text-center"
              style={{ background: 'var(--panel)', border: '1px dashed var(--border)' }}
            >
              <div className="text-[13px] text-fg font-medium">No webhooks yet</div>
              <div className="text-[12px] text-muted mt-1">
                Add one above to start receiving event POSTs.
              </div>
            </div>
          ) : (
            <div
              className="rounded-xl overflow-hidden"
              style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
            >
              {hooks.map((h, i) => (
                <div
                  key={h.id}
                  className="flex items-start gap-3 px-4 py-3"
                  style={{ borderTop: i === 0 ? undefined : '1px solid var(--border-soft)' }}
                >
                  <div className="mt-0.5 shrink-0">
                    {h.lastDelivery ? (
                      h.lastDelivery.status && h.lastDelivery.status < 400 ? (
                        <CheckCircle2 size={13} style={{ color: '#00875A' }} />
                      ) : (
                        <XCircle size={13} style={{ color: '#BF2600' }} />
                      )
                    ) : (
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: 'var(--border)' }}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] text-fg break-all">{h.url}</div>
                    <div className="text-[11.5px] text-subtle mt-1 flex flex-wrap gap-1">
                      {h.events.map((ev) => (
                        <span
                          key={ev}
                          className="inline-flex items-center px-1.5 h-[18px] rounded text-[10.5px]"
                          style={{
                            background: 'var(--bg)',
                            border: '1px solid var(--border-soft)',
                          }}
                        >
                          {ev}
                        </span>
                      ))}
                    </div>
                    {h.lastDelivery && (
                      <div className="text-[11px] text-subtle mt-1">
                        last delivery {timeAgo(h.lastDelivery.ts)} · status{' '}
                        {h.lastDelivery.status ?? '—'}
                        {h.lastDelivery.error && (
                          <span style={{ color: '#BF2600' }}>
                            {' '}
                            · {h.lastDelivery.error}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    className="btn-ghost shrink-0"
                    onClick={() => remove(h)}
                    style={{ color: '#BF2600' }}
                    title="Delete webhook"
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
