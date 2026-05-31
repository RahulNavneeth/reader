import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Plus,
  Loader2,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Pencil,
  Send,
  RefreshCw,
  ChevronDown,
  Info,
  X,
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

/** Grouped event taxonomy used by the chip picker. Keeps the long
 *  flat list of 16 chips from reading as a wall of pills — users
 *  can scan to "Folders" or "Sharing" instead. */
const EVENT_GROUPS: Array<{
  label: string
  hint: string
  events: WebhookEvent[]
}> = [
  {
    label: 'File',
    hint: 'Per-file create / modify / remove / archive',
    events: ['upload', 'edit', 'delete', 'trash', 'move', 'archive'],
  },
  {
    label: 'Metadata',
    hint: 'Tags, visibility, search-index status',
    events: ['tags', 'visibility', 'ingest'],
  },
  {
    label: 'Folder',
    hint: 'Folder-level actions and cascades',
    events: ['mkdir', 'folder-tags', 'folder-visibility'],
  },
  {
    label: 'Sharing & pins',
    hint: 'Cross-user grants and sidebar pins',
    events: ['share', 'pin'],
  },
  {
    label: 'Inbound',
    hint: 'Files arriving via email-in or templates',
    events: ['intake', 'template'],
  },
  {
    label: 'Account',
    hint: 'Workspace-level actions',
    events: ['export'],
  },
]

/** Friendlier human label per event for the chip text. The raw
 *  event names (`folder-tags`, `mkdir`) read as dev jargon; this
 *  table makes the picker scan as English. */
const EVENT_LABEL: Record<WebhookEvent, string> = {
  upload: 'upload',
  edit: 'edit',
  delete: 'delete',
  trash: 'trash',
  move: 'move/rename',
  mkdir: 'new folder',
  share: 'share',
  tags: 'tags',
  visibility: 'visibility',
  'folder-tags': 'folder tags',
  'folder-visibility': 'folder visibility',
  pin: 'pin/unpin',
  intake: 'email arrived',
  template: 'from template',
  export: 'vault export',
  ingest: 'index ready',
  archive: 'archive/unarchive',
}

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
        <Send size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Webhooks</div>
        {hooks && hooks.length > 0 && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {hooks.length} {hooks.length === 1 ? 'webhook' : 'webhooks'}
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
            <span>{prettyWebhookError(error)}</span>
          </div>
        )}

        <Section title="Add a webhook">
          <div className="space-y-3">
            <input
              className="input w-full h-8 text-[13px]"
              placeholder="Webhook URL (https://…)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
            <input
              className="input w-full h-8 text-[13px]"
              placeholder="Signing secret (optional)"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={busy}
            />
            <EventPicker
              selected={events}
              onToggle={toggleEvent}
              onSelectAll={() => setEvents(new Set(ALL_EVENTS))}
              onClearAll={() => setEvents(new Set())}
              disabled={busy}
            />
            <div className="flex justify-end">
              <button
                className="btn-primary h-8"
                onClick={create}
                disabled={busy || !url.trim() || events.size === 0}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Add webhook
              </button>
            </div>
          </div>
        </Section>

        <Section title={`Your webhooks${hooks && hooks.length > 0 ? ` · ${hooks.length}` : ''}`}>
          {!hooks ? null : hooks.length === 0 ? (
            <SettingsListEmpty
              title="No webhooks yet"
              hint="Add one above to start receiving event POSTs."
            />
          ) : (
            <SettingsListCard>
              {hooks.map((h) => (
                <WebhookRow
                  key={h.id}
                  hook={h}
                  onChanged={refresh}
                  onDelete={() => remove(h)}
                  onError={(msg) => setError(msg)}
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

function EventPicker({
  selected,
  onToggle,
  onSelectAll,
  onClearAll,
  disabled,
}: {
  selected: Set<WebhookEvent>
  onToggle: (ev: WebhookEvent) => void
  onSelectAll: () => void
  onClearAll: () => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle">
            Events
          </div>
          <EventShapesLink />
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-subtle">
            {selected.size} of {ALL_EVENTS.length}
          </span>
          <button
            type="button"
            onClick={onSelectAll}
            className="text-accent hover:underline"
            disabled={disabled}
          >
            All
          </button>
          <span className="text-subtle opacity-60">·</span>
          <button
            type="button"
            onClick={onClearAll}
            className="text-subtle hover:text-fg"
            disabled={disabled}
          >
            None
          </button>
        </div>
      </div>
      <div className="space-y-2.5">
        {EVENT_GROUPS.map((g) => {
          const groupOn = g.events.filter((e) => selected.has(e)).length
          return (
            <div key={g.label}>
              <div className="flex items-baseline justify-between mb-1">
                <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                  {g.label}
                </div>
                <div className="text-[10.5px] text-subtle">
                  {groupOn}/{g.events.length}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {g.events.map((ev) => {
                  const on = selected.has(ev)
                  return (
                    <button
                      key={ev}
                      type="button"
                      onClick={() => onToggle(ev)}
                      title={g.hint}
                      className={
                        on
                          ? 'inline-flex items-center px-2 h-6 rounded text-[11.5px]'
                          : 'inline-flex items-center px-2 h-6 rounded text-[11.5px] transition-colors hover:bg-hover'
                      }
                      style={{
                        background: on ? 'var(--selected)' : 'transparent',
                        color: on ? 'var(--accent)' : 'var(--fg-muted)',
                      }}
                      disabled={disabled}
                    >
                      {EVENT_LABEL[ev]}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
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

function WebhookRow({
  hook,
  onChanged,
  onDelete,
  onError,
}: {
  hook: Webhook
  onChanged: () => void
  onDelete: () => void
  onError: (msg: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [showDlq, setShowDlq] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { ok: boolean; status: number | null; error?: string } | null
  >(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  const [editUrl, setEditUrl] = useState(hook.url)
  const [editSecret, setEditSecret] = useState('')
  const [editEvents, setEditEvents] = useState<Set<WebhookEvent>>(
    new Set(hook.events),
  )
  const [saving, setSaving] = useState(false)

  const enabled = hook.enabled !== false
  const dlq = hook.deadLetter ?? []
  // Reverse chronologically — most recent first is the natural read
  // order for an activity log.
  const history = [...(hook.recentDeliveries ?? [])].reverse()

  const toggleEnabled = async () => {
    setTogglingEnabled(true)
    try {
      await api.accountUpdateWebhook(hook.id, { enabled: !enabled })
      onChanged()
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
      const r = await api.accountTestWebhook(hook.id)
      setTestResult(r)
      // Refresh so the new lastDelivery surfaces.
      onChanged()
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
      const r = await api.accountRetryWebhook(hook.id, entryId)
      if (!r.ok) {
        onError(`Retry failed: ${r.error ?? `HTTP ${r.status}`}`)
      }
      onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRetryingId(null)
    }
  }

  const toggleEditEvent = (ev: WebhookEvent) => {
    setEditEvents((cur) => {
      const next = new Set(cur)
      if (next.has(ev)) next.delete(ev)
      else next.add(ev)
      return next
    })
  }

  const saveEdit = async () => {
    if (!editUrl.trim() || editEvents.size === 0) return
    setSaving(true)
    try {
      await api.accountUpdateWebhook(hook.id, {
        url: editUrl.trim(),
        events: Array.from(editEvents),
        // Only send the secret if the user actually typed one — empty
        // string is reserved server-side to clear, which we don't
        // expose here.
        ...(editSecret.trim() ? { secret: editSecret.trim() } : {}),
      })
      setEditing(false)
      setEditSecret('')
      onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
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
                title={`Auto-disabled after ${
                  hook.consecutiveFailures ?? '?'
                } consecutive failed deliveries. Click On to retry.`}
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
              : hook.events.length <= 4
                ? hook.events.map((e) => EVENT_LABEL[e]).join(' · ')
                : `${hook.events
                    .slice(0, 3)
                    .map((e) => EVENT_LABEL[e])
                    .join(' · ')} · +${hook.events.length - 3} more`}
            {hook.hasSecret ? ' · signed' : ' · unsigned'}
            {hook.lastDelivery
              ? ` · last ${timeAgo(hook.lastDelivery.ts)}`
              : ' · never delivered'}
          </div>
          {testResult && (
            <div
              className="text-[11px] mt-1"
              style={{ color: testResult.ok ? '#00875A' : '#BF2600' }}
            >
              {testResult.ok
                ? `Test delivered · status ${testResult.status}`
                : `Test failed · ${testResult.error ?? `HTTP ${testResult.status}`}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            className="btn-ghost h-7 px-2 text-[11.5px]"
            onClick={toggleEnabled}
            disabled={togglingEnabled}
            title={enabled ? 'Pause this webhook' : 'Resume this webhook'}
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
            className="btn-ghost h-7 w-7 px-0 grid place-items-center"
            onClick={runTest}
            disabled={testing}
            title="Send test ping"
            aria-label="Send test ping"
          >
            {testing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Send size={11} />
            )}
          </button>
          <button
            className="btn-ghost h-7 w-7 px-0 grid place-items-center"
            onClick={() => {
              setEditUrl(hook.url)
              setEditEvents(new Set(hook.events))
              setEditSecret('')
              setEditing((v) => !v)
            }}
            title={editing ? 'Cancel edit' : 'Edit webhook'}
            aria-label="Edit"
            style={editing ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
          >
            <Pencil size={11} />
          </button>
          <button
            className="btn-ghost-danger h-7 w-7 px-0 grid place-items-center"
            onClick={onDelete}
            title="Delete webhook"
            aria-label="Delete webhook"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      {editing && (
        <div
          className="mt-3 ml-6 space-y-2 rounded-md p-3"
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
          }}
        >
          <input
            className="input w-full h-8 text-[13px]"
            placeholder="Webhook URL (https://…)"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            disabled={saving}
          />
          <input
            className="input w-full h-8 text-[13px]"
            placeholder={
              hook.hasSecret
                ? 'New signing secret (leave blank to keep current)'
                : 'Signing secret (optional, min 16 chars)'
            }
            value={editSecret}
            onChange={(e) => setEditSecret(e.target.value)}
            disabled={saving}
          />
          <EventPicker
            selected={editEvents}
            onToggle={toggleEditEvent}
            onSelectAll={() => setEditEvents(new Set(ALL_EVENTS))}
            onClearAll={() => setEditEvents(new Set())}
            disabled={saving}
          />
          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost h-7"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn-primary h-7"
              onClick={saveEdit}
              disabled={saving || !editUrl.trim() || editEvents.size === 0}
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>
      )}
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
                        style={{ background: 'var(--hover)', color: 'var(--fg-subtle)' }}
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
            <ul
              className="mt-2 space-y-1.5"
            >
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
                        {ev.path && (
                          <span className="text-subtle"> · {ev.path}</span>
                        )}
                      </div>
                      <div className="text-subtle mt-0.5">
                        {timeAgo(entry.ts)} · {entry.lastError ?? `HTTP ${entry.lastStatus ?? '—'}`}
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

/** The server returns a terse "validation failed" for malformed
 *  bodies. Translate the common cases so the user knows what to
 *  fix instead of staring at a generic message. */
function prettyWebhookError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('validation')) {
    return 'Webhook URL is required and must be a valid https:// address. Pick at least one event.'
  }
  if (m === 'unauthorized' || m === 'forbidden') {
    return 'You need to be signed in to manage webhooks.'
  }
  if (m.includes('rate')) {
    return 'Too many webhook changes — try again in a moment.'
  }
  return msg
}

/** Inline link + modal that fetches the static event-shape catalog
 *  and shows receivers exactly what JSON will hit their endpoint. The
 *  fetch is lazy — nothing happens until the user clicks. */
function EventShapesLink(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [doc, setDoc] = useState<{
    envelope: { description: string; fields: Record<string, string>; headers: Record<string, string> }
    events: Array<{ type: string; description: string; sample: Record<string, unknown> }>
  } | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open || doc) return
    setLoading(true)
    api.accountWebhookEventShapes()
      .then(setDoc)
      .catch(() => setDoc(null))
      .finally(() => setLoading(false))
  }, [open, doc])
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-fg"
        title="Show the payload shape for each event"
      >
        <Info size={11} />
        Payload reference
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'color-mix(in srgb, var(--rail) 75%, transparent)' }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] rounded-lg overflow-hidden flex flex-col"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div className="text-[13px] font-semibold text-fg">
                Webhook payload reference
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-subtle hover:text-fg"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="overflow-y-auto px-4 py-3 space-y-4 text-[12px]">
              {loading && (
                <div className="flex items-center gap-2 text-subtle">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </div>
              )}
              {doc && (
                <>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1">
                      Envelope
                    </div>
                    <div className="text-fg mb-2">{doc.envelope.description}</div>
                    <div className="space-y-1">
                      {Object.entries(doc.envelope.fields).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <code
                            className="shrink-0 px-1.5 py-0.5 rounded text-[11px]"
                            style={{ background: 'var(--panel-2)' }}
                          >
                            {k}
                          </code>
                          <span className="text-subtle">{v}</span>
                        </div>
                      ))}
                    </div>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mt-3 mb-1">
                      Headers
                    </div>
                    <div className="space-y-1">
                      {Object.entries(doc.envelope.headers).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <code
                            className="shrink-0 px-1.5 py-0.5 rounded text-[11px]"
                            style={{ background: 'var(--panel-2)' }}
                          >
                            {k}
                          </code>
                          <span className="text-subtle">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-2">
                      Events
                    </div>
                    <div className="space-y-3">
                      {doc.events.map((ev) => (
                        <div key={ev.type}>
                          <div className="flex items-baseline gap-2">
                            <code
                              className="px-1.5 py-0.5 rounded text-[11.5px] font-semibold"
                              style={{ background: 'var(--panel-2)', color: 'var(--fg)' }}
                            >
                              {ev.type}
                            </code>
                          </div>
                          <div className="text-subtle mt-1">{ev.description}</div>
                          <pre
                            className="mt-1 px-2 py-2 rounded text-[11px] overflow-x-auto"
                            style={{ background: 'var(--panel-2)', color: 'var(--fg)' }}
                          >
{JSON.stringify(ev.sample, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
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
