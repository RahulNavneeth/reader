import { useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  Send,
  RefreshCw,
  ChevronDown,
  AlertCircle,
  KeyRound,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { SettingsListCard, SettingsListEmpty } from './SettingsList'

type WebhookEvent =
  | 'upload'
  | 'edit'
  | 'delete'
  | 'trash'
  | 'move'
  | 'mkdir'
  | 'share'
  | 'tags'
  | 'visibility'
  | 'folder-tags'
  | 'folder-visibility'
  | 'pin'
  | 'intake'
  | 'template'
  | 'export'
  | 'ingest'
  | 'archive'

type DeadLetter = {
  id: string
  ts: number
  event: unknown
  lastStatus: number | null
  lastError?: string
}

type DeliveryAttempt = {
  ts: number
  status: number | null
  error?: string
  eventType: string
  kind: 'dispatch' | 'retry' | 'test'
}

type Webhook = {
  id: string
  url: string
  events: WebhookEvent[]
  hasSecret?: boolean
  enabled?: boolean
  createdAt: number
  owner?: string
  lastDelivery?: { ts: number; status: number | null; error?: string }
  deadLetter?: DeadLetter[]
  consecutiveFailures?: number
  circuitOpenedAt?: number
  recentDeliveries?: DeliveryAttempt[]
}

const ALL_EVENTS: WebhookEvent[] = [
  'upload',
  'edit',
  'delete',
  'trash',
  'move',
  'mkdir',
  'share',
  'tags',
  'visibility',
  'folder-tags',
  'folder-visibility',
  'pin',
  'intake',
  'template',
  'export',
  'ingest',
  'archive',
]

export function AdminWebhooksPanel(): JSX.Element {
  const [hooks, setHooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [rotateResult, setRotateResult] = useState<
    { total: number; rotated: number; failed: number } | null
  >(null)
  const confirm = useConfirm()

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await api.adminWebhooks()
      setHooks(r.webhooks as Webhook[])
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const remove = async (h: Webhook) => {
    const ok = await confirm({
      title: 'Delete webhook?',
      message: h.url,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await api.adminDeleteWebhook(h.id)
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const rotateSecrets = async () => {
    const ok = await confirm({
      title: 'Rotate webhook secrets?',
      message:
        'Re-encrypt every stored webhook secret under the current SESSION_SECRET. ' +
        'Run this after changing SESSION_SECRET (with SESSION_SECRET_PREVIOUS holding the old key).',
      confirmLabel: 'Rotate',
    })
    if (!ok) return
    setRotating(true)
    setRotateResult(null)
    try {
      const r = await api.adminRotateWebhookSecrets()
      setRotateResult({ total: r.total, rotated: r.rotated, failed: r.failed })
      if (r.failed > 0) {
        setError(
          `Rotated ${r.rotated} of ${r.total} — ${r.failed} failed: ` +
            r.errors.map((e) => `${e.id}: ${e.error}`).join('; '),
        )
      }
      await refresh()
      // Auto-dismiss the success toast after a few seconds.
      setTimeout(() => setRotateResult(null), 6_000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRotating(false)
    }
  }

  return (
    <section className="space-y-4">
      <div
        className="flex items-center justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div>
          <div className="text-[14px] font-semibold text-fg">Webhooks (global)</div>
          <div className="text-[11.5px] text-subtle mt-0.5">
            Workspace-wide outbound hooks. Fire on every user's events.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost h-7 px-2 text-[12px] inline-flex items-center gap-1.5"
            onClick={rotateSecrets}
            disabled={rotating || hooks.length === 0}
            title="Re-encrypt every stored secret under the current SESSION_SECRET"
          >
            {rotating ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <KeyRound size={12} />
            )}
            Rotate secrets
          </button>
          <button
            className="btn-primary h-7 px-2 text-[12px] inline-flex items-center gap-1.5"
            onClick={() => setAdding(true)}
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {rotateResult && rotateResult.failed === 0 && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded text-[12px]"
          style={{
            background: 'color-mix(in srgb, #00875A 12%, transparent)',
            color: '#00875A',
          }}
        >
          <CheckCircle2 size={12} />
          Rotated {rotateResult.rotated} of {rotateResult.total} secrets.
        </div>
      )}

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

      {adding && (
        <AddForm
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false)
            await refresh()
          }}
          onError={(m) => setError(m)}
        />
      )}

      {loading ? (
        <div className="text-subtle text-[12.5px] py-4">Loading…</div>
      ) : hooks.length === 0 && !adding ? (
        <SettingsListEmpty
          title="No global webhooks yet"
          hint="Per-user hooks live under each user's account settings."
        />
      ) : hooks.length === 0 ? null : (
        <SettingsListCard>
          {hooks.map((h) => (
            <Row
              key={h.id}
              hook={h}
              onChanged={refresh}
              onDelete={() => remove(h)}
              onError={(m) => setError(m)}
            />
          ))}
        </SettingsListCard>
      )}
    </section>
  )
}

function AddForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void
  onCreated: () => Promise<void> | void
  onError: (msg: string) => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(ALL_EVENTS))
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (!url.trim() || secret.trim().length < 16 || events.size === 0) return
    setSaving(true)
    try {
      await api.adminCreateWebhook({
        url: url.trim(),
        secret: secret.trim(),
        events: Array.from(events),
        enabled: true,
      })
      await onCreated()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      className="rounded-lg p-3 space-y-3"
      style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
    >
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://hooks.example.com/reader"
        className="w-full px-2 h-7 rounded text-[12px]"
        style={{ background: 'var(--viewer)', border: '1px solid var(--border)', color: 'var(--fg)' }}
      />
      <input
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="Signing secret (min 16 chars, required)"
        className="w-full px-2 h-7 rounded text-[12px]"
        style={{ background: 'var(--viewer)', border: '1px solid var(--border)', color: 'var(--fg)' }}
      />
      <div className="flex flex-wrap gap-1.5">
        {ALL_EVENTS.map((ev) => {
          const on = events.has(ev)
          return (
            <button
              key={ev}
              type="button"
              onClick={() =>
                setEvents((cur) => {
                  const next = new Set(cur)
                  if (next.has(ev)) next.delete(ev)
                  else next.add(ev)
                  return next
                })
              }
              className="inline-flex items-center px-2 h-6 rounded text-[11.5px]"
              style={
                on
                  ? { background: 'var(--accent)', color: '#fff' }
                  : { background: 'var(--hover)', color: 'var(--fg-subtle)' }
              }
            >
              {ev}
            </button>
          )
        })}
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="btn-ghost h-7 px-2 text-[12px]">
          Cancel
        </button>
        <button
          onClick={submit}
          className="btn-primary h-7 px-2 text-[12px] inline-flex items-center gap-1.5"
          disabled={saving || !url.trim() || secret.trim().length < 16 || events.size === 0}
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          Save
        </button>
      </div>
    </div>
  )
}

function Row({
  hook,
  onChanged,
  onDelete,
  onError,
}: {
  hook: Webhook
  onChanged: () => Promise<void> | void
  onDelete: () => void
  onError: (msg: string) => void
}): JSX.Element {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { ok: boolean; status: number | null; error?: string } | null
  >(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showDlq, setShowDlq] = useState(false)

  const enabled = hook.enabled !== false
  const dlq = hook.deadLetter ?? []
  const history = [...(hook.recentDeliveries ?? [])].reverse()

  const toggleEnabled = async () => {
    setTogglingEnabled(true)
    try {
      await api.adminUpdateWebhook(hook.id, { enabled: !enabled })
      await onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setTogglingEnabled(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.adminTestWebhook(hook.id)
      setTestResult(r)
      await onChanged()
      setTimeout(() => setTestResult(null), 4_000)
    } catch (e) {
      setTestResult({
        ok: false,
        status: null,
        error: e instanceof ApiError ? e.message : String(e),
      })
    } finally {
      setTesting(false)
    }
  }

  const retryEntry = async (entryId: string) => {
    setRetryingId(entryId)
    try {
      const r = await api.adminRetryWebhook(hook.id, entryId)
      if (!r.ok) onError(`Retry failed: ${r.error ?? `HTTP ${r.status}`}`)
      await onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {hook.lastDelivery ? (
            hook.lastDelivery.status && hook.lastDelivery.status < 400 ? (
              <CheckCircle2 size={13} style={{ color: '#00875A' }} />
            ) : (
              <XCircle size={13} style={{ color: '#BF2600' }} />
            )
          ) : (
            <span
              className="inline-block w-2 h-2 rounded-full mt-1.5"
              style={{ background: 'var(--border)' }}
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-fg break-all">
            {hook.url}
            {!enabled && hook.circuitOpenedAt ? (
              <span
                className="ml-2 inline-flex items-center px-1.5 h-4 rounded text-[10px] font-semibold uppercase tracking-wider align-middle"
                style={{
                  background: 'color-mix(in srgb, #BF2600 14%, transparent)',
                  color: '#BF2600',
                }}
                title={`Auto-disabled after ${hook.consecutiveFailures ?? '?'} consecutive failed deliveries. Click On to retry.`}
              >
                Auto-disabled
              </span>
            ) : !enabled ? (
              <span
                className="ml-2 inline-flex items-center px-1.5 h-4 rounded text-[10px] font-semibold uppercase tracking-wider align-middle"
                style={{ background: 'var(--hover)', color: 'var(--fg-subtle)' }}
              >
                Disabled
              </span>
            ) : null}
          </div>
          <div className="text-[11.5px] text-subtle mt-0.5">
            {hook.events.length === ALL_EVENTS.length
              ? 'all events'
              : `${hook.events.length} event${hook.events.length === 1 ? '' : 's'}`}
            {hook.hasSecret ? ' · signed' : ' · unsigned'}
            {hook.lastDelivery
              ? ` · last ${timeAgo(hook.lastDelivery.ts)}`
              : ' · never delivered'}
          </div>
          {testResult && (
            <div
              className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px]"
              style={{
                background: testResult.ok
                  ? 'color-mix(in srgb, #00875A 12%, transparent)'
                  : 'color-mix(in srgb, #BF2600 12%, transparent)',
                color: testResult.ok ? '#00875A' : '#BF2600',
              }}
            >
              {testResult.ok ? (
                <CheckCircle2 size={11} />
              ) : (
                <XCircle size={11} />
              )}
              {testResult.ok
                ? `Test OK (HTTP ${testResult.status})`
                : `Test failed: ${testResult.error ?? `HTTP ${testResult.status}`}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={toggleEnabled}
            disabled={togglingEnabled}
            className="btn-ghost h-7 px-2 text-[11.5px]"
            title={enabled ? 'Disable hook' : 'Enable hook'}
          >
            {togglingEnabled ? (
              <Loader2 size={11} className="animate-spin" />
            ) : enabled ? (
              'On'
            ) : (
              'Off'
            )}
          </button>
          <button
            onClick={runTest}
            disabled={testing}
            className="btn-ghost h-7 w-7 px-0 grid place-items-center"
            title="Send a test ping"
            aria-label="Test"
          >
            {testing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Send size={11} />
            )}
          </button>
          <button
            onClick={onDelete}
            className="btn-ghost-danger h-7 w-7 px-0 grid place-items-center"
            title="Delete hook"
            aria-label="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      {history.length > 0 && (
        <div className="mt-2 ml-6">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-1 text-[11.5px] text-subtle hover:text-fg"
          >
            <ChevronDown
              size={11}
              className={`transition-transform ${showHistory ? 'rotate-180' : ''}`}
            />
            Recent activity ({history.length})
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1">
              {history.map((d, i) => {
                const ok = d.status != null && d.status >= 200 && d.status < 300
                return (
                  <li
                    key={`${d.ts}-${i}`}
                    className="flex items-center gap-2 py-1 px-2 rounded text-[11.5px]"
                    style={{ background: 'var(--panel-2)' }}
                  >
                    {ok ? (
                      <CheckCircle2 size={11} style={{ color: '#00875A' }} />
                    ) : (
                      <XCircle size={11} style={{ color: '#BF2600' }} />
                    )}
                    <span className="text-fg shrink-0 font-medium">
                      {d.eventType}
                    </span>
                    {d.kind !== 'dispatch' && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1 rounded shrink-0"
                        style={{
                          background: 'var(--hover)',
                          color: 'var(--fg-subtle)',
                        }}
                      >
                        {d.kind}
                      </span>
                    )}
                    <span className="text-subtle flex-1 min-w-0 truncate">
                      {d.error ?? `HTTP ${d.status ?? '—'}`}
                    </span>
                    <span className="text-subtle shrink-0">{timeAgo(d.ts)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {dlq.length > 0 && (
        <div className="mt-2 ml-6">
          <button
            type="button"
            onClick={() => setShowDlq((v) => !v)}
            className="inline-flex items-center gap-1 text-[11.5px] text-subtle hover:text-fg"
          >
            <ChevronDown
              size={11}
              className={`transition-transform ${showDlq ? 'rotate-180' : ''}`}
            />
            {dlq.length} failed deliver{dlq.length === 1 ? 'y' : 'ies'}
          </button>
          {showDlq && (
            <ul className="mt-2 space-y-1.5">
              {dlq.map((entry) => {
                const ev = entry.event as { type?: string; path?: string }
                return (
                  <li
                    key={entry.id}
                    className="flex items-start gap-2 py-1.5 px-2 rounded text-[11.5px]"
                    style={{ background: 'var(--panel-2)' }}
                  >
                    <XCircle
                      size={12}
                      className="mt-0.5 shrink-0"
                      style={{ color: '#BF2600' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-fg">
                        {ev.type ?? 'event'}
                        {ev.path && <span className="text-subtle"> · {ev.path}</span>}
                      </div>
                      <div className="text-subtle mt-0.5">
                        {timeAgo(entry.ts)} ·{' '}
                        {entry.lastError ?? `HTTP ${entry.lastStatus ?? '—'}`}
                      </div>
                    </div>
                    <button
                      className="btn-ghost shrink-0"
                      onClick={() => retryEntry(entry.id)}
                      disabled={retryingId === entry.id}
                      title="Retry this delivery"
                      aria-label="Retry"
                    >
                      {retryingId === entry.id ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
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
