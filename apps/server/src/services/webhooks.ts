/**
 * Outbound webhook dispatcher. Configured hooks live in the workspace
 * settings (`webhooks: [{ url, events, secret }]`). Each in-app event hits
 * `dispatch()` which fires a POST to every subscribed hook in parallel, with
 * a short timeout and an optional HMAC signature header.
 *
 * Failures are recorded back into the settings file as `lastDelivery` so
 * the admin UI can show a red dot. We don't retry — webhooks here are
 * fire-and-forget audit notifications, not a delivery queue.
 */
import crypto from 'node:crypto'
import { config } from '../config.js'
import { loadSettings, saveSettings, type WebhookConfig } from '../stores/settings.js'

const TIMEOUT_MS = 5_000

export type WebhookEvent =
  | { type: 'upload'; path: string; actor: string; bytes: number }
  | { type: 'edit'; path: string; actor: string }
  | { type: 'delete'; path: string; actor: string }
  | { type: 'share'; path: string; actor: string; shareId: string; expiresAt: number | null }
  | { type: 'tags'; path: string; actor: string; tags: string[] }
  | { type: 'visibility'; path: string; actor: string; public: boolean }

export async function dispatch(event: WebhookEvent): Promise<void> {
  const settings = await loadSettings().catch(() => null)
  const hooks = settings?.webhooks ?? []
  if (hooks.length === 0) return
  // User-scoped hooks only fire when the event's actor matches the
  // hook's owner. Legacy global hooks (no owner) fire for every event.
  const eligible = hooks.filter(
    (h) =>
      h.enabled !== false &&
      h.events.includes(event.type) &&
      (h.owner == null || h.owner === event.actor),
  )
  if (eligible.length === 0) return

  // Include a back-pointer URL so the webhook receiver can deep-link
  // straight into Reader without needing to know our public host.
  const segs = event.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const itemUrl = segs ? `${config.appUrl}/${segs}` : `${config.appUrl}/`
  const payload = JSON.stringify({ ...event, ts: Date.now(), appUrl: config.appUrl, itemUrl })
  await Promise.all(eligible.map((hook) => deliver(hook, payload)))
}

async function deliver(hook: WebhookConfig, payload: string): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let status: number | null = null
  let err: string | undefined
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (hook.secret) {
      const sig = crypto.createHmac('sha256', hook.secret).update(payload).digest('hex')
      headers['X-Reader-Signature'] = sig
    }
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: ctrl.signal,
    })
    status = res.status
    if (!res.ok) err = `HTTP ${res.status}`
  } catch (e: any) {
    err = e?.message ?? 'fetch failed'
  } finally {
    clearTimeout(t)
  }
  // Persist delivery status. Best-effort — we read-modify-write the whole
  // settings file, which is fine for the low frequency we expect.
  try {
    const s = await loadSettings()
    const next = {
      ...s,
      webhooks: (s.webhooks ?? []).map((h) =>
        h.id === hook.id
          ? { ...h, lastDelivery: { ts: Date.now(), status, error: err } }
          : h,
      ),
    }
    await saveSettings(next)
  } catch {
    /* swallow */
  }
}
