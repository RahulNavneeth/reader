/**
 * Outbound webhook dispatcher. Configured hooks live in workspace
 * settings (`webhooks: [{ url, events, secret }]`). Each in-app event
 * hits `dispatch()` which POSTs to every eligible hook with a short
 * timeout and (optional) HMAC signature in `X-Reader-Signature`.
 *
 * Reliability:
 *   - 3 attempts per delivery with exponential backoff (1s, 2s, 4s).
 *   - On final failure the event lands in a per-hook dead-letter
 *     buffer the admin can inspect + retry.
 *   - Last delivery status persists into the settings file so the UI
 *     can show a red/green dot per hook.
 *
 * Confidentiality:
 *   - Stored secrets are AES-256-GCM encrypted at rest using a key
 *     derived from the session secret. We never write a plaintext
 *     secret to settings.json.
 *
 * Race dedup:
 *   - In-app file writes (chat, MCP) register the expected next sha
 *     via `markExpectedWrite()`. The watcher checks that map before
 *     re-firing an `edit` webhook so the user doesn't see two events
 *     for one user-initiated write.
 */
import crypto from 'node:crypto'
import { config } from '../config.js'
import { loadSettings, saveSettings, type WebhookConfig } from '../stores/settings.js'

const TIMEOUT_MS = 5_000
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000]
const DEAD_LETTER_CAP = 50
/** Circuit-breaker threshold. After this many consecutive failed
 *  deliveries (each already exhausted its retry budget), the hook
 *  is auto-disabled to stop blocking the dispatcher on a known-
 *  broken receiver. Re-enabling via the UI (manual edit) resets
 *  the counter. */
const CIRCUIT_BREAKER_THRESHOLD = 10
/** Ring-buffer size for the per-hook recent-delivery log. Keeps
 *  the settings file bounded even for high-traffic hooks. */
const RECENT_DELIVERIES_CAP = 20

export type WebhookEvent =
  | { type: 'upload'; path: string; actor: string; bytes: number }
  | {
      type: 'edit'
      path: string
      actor: string
      bytes: number
      source: 'watcher' | 'chat' | 'mcp'
    }
  | { type: 'delete'; path: string; actor: string }
  // Soft-delete: file went to Trash, can be restored within the
  // retention window. `delete` is reserved for permanent removal so
  // receivers can mirror the recoverable state separately.
  | { type: 'trash'; path: string; actor: string }
  // File or folder moved/renamed. `from` and `to` are vault-relative
  // paths; `isFolder` lets receivers update their tree mirror.
  | {
      type: 'move'
      path: string // current location (alias for `to`)
      actor: string
      from: string
      to: string
      isFolder: boolean
    }
  // New folder created. `path` is the folder's vault-relative path.
  | { type: 'mkdir'; path: string; actor: string }
  | {
      type: 'share'
      path: string
      actor: string
      shareId: string
      recipient: string
      canEdit: boolean
      isFolder: boolean
      /** True for share-revoke events (DELETE /api/file/share-with/:id).
       *  Receivers filtering on `share` get both grant + revoke so they
       *  can keep their mirrored ACL in sync. */
      revoked: boolean
    }
  | { type: 'tags'; path: string; actor: string; tags: string[] }
  | { type: 'visibility'; path: string; actor: string; public: boolean }
  // Folder-level metadata changes. Distinct from the file-level
  // `tags` / `visibility` events because the cascade audit hits every
  // descendant but the dispatcher only fires one folder-* event.
  | { type: 'folder-tags'; path: string; actor: string; tags: string[] }
  | { type: 'folder-visibility'; path: string; actor: string; public: boolean }
  // Pin / unpin to the sidebar. `pinned: false` means an unpin.
  | { type: 'pin'; path: string; actor: string; pinned: boolean; isFolder: boolean }
  // File created via the HTTP email-intake endpoint.
  | { type: 'intake'; path: string; actor: string; subject?: string; from?: string }
  // File created by instantiating a `_templates/*.md` template.
  | { type: 'template'; path: string; actor: string; template: string; title: string }
  // Full-vault export streamed to the requester.
  | { type: 'export'; path: string; actor: string }
  | {
      type: 'ingest'
      path: string
      actor: string
      docId: string
      status: 'ready' | 'no-text' | 'failed'
      chunkCount: number
      embedded: boolean
    }

/**
 * Schema documentation for every supported event type. Surfaced via
 * `GET /api/account/webhooks/event-shapes` so the picker UI can show
 * receivers EXACTLY what their endpoint will receive. The
 * `ts | appUrl | itemUrl` envelope fields apply to all events (see
 * `dispatch`) and are not repeated per entry.
 */
export const EVENT_SHAPES: Array<{
  type: WebhookEvent['type'] | 'test'
  description: string
  /** Sample payload — keep keys in the same order as the dispatched JSON. */
  sample: Record<string, unknown>
}> = [
  {
    type: 'upload',
    description: 'A new file landed in the vault (manual upload, drag-and-drop, or external drop into the watched folder).',
    sample: { type: 'upload', path: 'Inbox/report.pdf', actor: 'alice', bytes: 184320 },
  },
  {
    type: 'edit',
    description: 'An existing file was rewritten. `source` distinguishes who/what made the change.',
    sample: { type: 'edit', path: 'Notes/2026/standup.md', actor: 'alice', bytes: 2048, source: 'watcher' },
  },
  {
    type: 'delete',
    description: 'Permanent removal (Trash purge or hard delete). For soft-delete see the `trash` event.',
    sample: { type: 'delete', path: 'Old/draft.md', actor: 'alice' },
  },
  {
    type: 'trash',
    description: 'File moved to Trash. Recoverable within the retention window — listen for both `trash` and `delete` if you mirror state.',
    sample: { type: 'trash', path: 'Notes/scratch.md', actor: 'alice' },
  },
  {
    type: 'move',
    description: 'File or folder moved/renamed. `path` mirrors `to` for convenience.',
    sample: { type: 'move', path: 'Archive/2025/q4.md', actor: 'alice', from: 'Inbox/q4.md', to: 'Archive/2025/q4.md', isFolder: false },
  },
  {
    type: 'mkdir',
    description: 'A new folder was created.',
    sample: { type: 'mkdir', path: 'Projects/reader', actor: 'alice' },
  },
  {
    type: 'share',
    description: 'A file/folder was shared with another user. `revoked: true` fires on un-share — filter on it to distinguish grant from revoke.',
    sample: { type: 'share', path: 'Reports/Q1.pdf', actor: 'alice', shareId: 'shr_8Hk2', recipient: 'bob', canEdit: false, isFolder: false, revoked: false },
  },
  {
    type: 'tags',
    description: 'File tags changed. `tags` is the full new tag set, not a diff.',
    sample: { type: 'tags', path: 'Reports/Q1.pdf', actor: 'alice', tags: ['finance', 'q1'] },
  },
  {
    type: 'visibility',
    description: 'File visibility toggled. `public: true` means anyone with the link can read.',
    sample: { type: 'visibility', path: 'Reports/Q1.pdf', actor: 'alice', public: true },
  },
  {
    type: 'folder-tags',
    description: 'Folder-level tag change. Fires once for the folder; per-file `tags` events are NOT emitted for the cascade.',
    sample: { type: 'folder-tags', path: 'Reports', actor: 'alice', tags: ['archive'] },
  },
  {
    type: 'folder-visibility',
    description: 'Folder-level visibility change. Fires once for the folder; per-file events are NOT emitted for the cascade.',
    sample: { type: 'folder-visibility', path: 'Reports', actor: 'alice', public: false },
  },
  {
    type: 'pin',
    description: 'Pin or unpin to the sidebar. `pinned: false` means an unpin.',
    sample: { type: 'pin', path: 'Inbox/today.md', actor: 'alice', pinned: true, isFolder: false },
  },
  {
    type: 'intake',
    description: 'File created via the HTTP email-intake endpoint.',
    sample: { type: 'intake', path: 'Intake/2026-05/receipt.eml', actor: 'alice', subject: 'Your receipt', from: 'store@example.com' },
  },
  {
    type: 'template',
    description: 'File created by instantiating a `_templates/*.md` template.',
    sample: { type: 'template', path: 'Standups/2026-05-24.md', actor: 'alice', template: 'standup', title: '2026-05-24 Standup' },
  },
  {
    type: 'export',
    description: 'A full-vault export was streamed to the requester. `path` is the export archive name.',
    sample: { type: 'export', path: 'reader-export-2026-05-24.zip', actor: 'alice' },
  },
  {
    type: 'ingest',
    description: 'A file finished server-side ingest. `status: "ready"` means text was extracted and (if Ollama is on) chunks were embedded.',
    sample: { type: 'ingest', path: 'Reports/Q1.pdf', actor: 'alice', docId: 'doc_AbC123', status: 'ready', chunkCount: 42, embedded: true },
  },
  {
    type: 'test',
    description: 'Synthetic ping fired by the "Send test" button. Receivers can use the `X-Reader-Event: test` header to short-circuit normal processing.',
    sample: { type: 'test', actor: 'alice', message: 'Reader webhook test ping' },
  },
]

// ── Secret encryption ──────────────────────────────────────────────
// Keep the on-disk secret form sealed even if the settings file is
// inspected. The session secret is the natural KDF input — it's
// already required + stable for the workspace lifetime.

const ENC_PREFIX = 'enc:v1:'

/** Derive a stable 32-byte key from a session secret. HKDF-SHA256
 *  with a fixed salt + info string scopes the key to this purpose so
 *  it can't collide with any other derivation we add later. */
function deriveKey(secret: string): Buffer {
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from('reader-webhook-secret-v1', 'utf8'),
    Buffer.from('webhook-secret-encryption', 'utf8'),
    32,
  )
  return Buffer.from(ab as ArrayBuffer)
}

function encryptionKey(): Buffer {
  return deriveKey(config.session.secret)
}

/** Returns the previous-key derivation if `SESSION_SECRET_PREVIOUS`
 *  was set, otherwise null. Only used by the decrypt fallback path. */
function previousKey(): Buffer | null {
  const prev = config.session.secretPrevious
  if (!prev) return null
  return deriveKey(prev)
}

/** Returns the on-disk form of a webhook secret. Plaintext input ⇒
 *  AES-256-GCM ciphertext tagged with the version prefix so future
 *  rotations can identify ciphertext at read time. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
}

/** Returns the plaintext secret for signing. Accepts either the
 *  encrypted form (new writes) or plaintext (legacy hooks created
 *  before encryption shipped). Legacy plaintext stays readable so
 *  existing webhooks keep working; the next save through admin/account
 *  re-encrypts them. */
export function decryptSecret(stored: string | undefined): string {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored
  const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  // Try the current key first; on auth-tag mismatch fall back to the
  // previous key (if SESSION_SECRET_PREVIOUS is set) so existing hooks
  // keep working through a rotation. `rotateAllSecrets` sweeps the
  // store afterwards to re-encrypt under the current key.
  const keys: Buffer[] = [encryptionKey()]
  const prev = previousKey()
  if (prev) keys.push(prev)
  let lastErr: unknown
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('decryptSecret: no candidate key worked')
}

/**
 * Sweep every persisted hook, decrypt its secret (trying both keys),
 * and re-encrypt under the current key. Returns counts so the admin
 * UI can confirm the rotation landed. Called by the admin endpoint
 * after `SESSION_SECRET_PREVIOUS` has been set + the server restarted
 * with the new primary.
 */
export async function rotateAllSecrets(): Promise<{
  total: number
  rotated: number
  failed: number
  errors: Array<{ id: string; error: string }>
}> {
  const s = await loadSettings()
  const hooks = s.webhooks ?? []
  let rotated = 0
  let failed = 0
  const errors: Array<{ id: string; error: string }> = []
  const next = hooks.map((h) => {
    if (!h.secret) return h
    try {
      const plain = decryptSecret(h.secret)
      const fresh = encryptSecret(plain)
      // Only count it as rotated if the ciphertext actually changed —
      // re-encrypting under the same key produces a new IV/tag so the
      // string will differ even when "nothing happened" from a
      // security standpoint.
      if (fresh !== h.secret) rotated += 1
      return { ...h, secret: fresh }
    } catch (e) {
      failed += 1
      errors.push({ id: h.id, error: e instanceof Error ? e.message : String(e) })
      return h
    }
  })
  if (rotated > 0 || failed > 0) {
    await saveSettings({ ...s, webhooks: next })
  }
  return { total: hooks.length, rotated, failed, errors }
}

// ── Watcher-race dedup registry ────────────────────────────────────
// In-app writers (chat apply-edit, MCP edit ops) call
// `markExpectedWrite(abs, sha)` before writing the file. The watcher
// calls `consumeExpectedWrite(abs, sha)` when an event arrives; a
// match means "we already fired the edit webhook for this write" and
// the watcher skips re-firing.

const expectedWrites = new Map<string, { sha: string; expiresAt: number }>()
const EXPECTED_WRITE_TTL_MS = 30_000

export function markExpectedWrite(abs: string, sha: string): void {
  expectedWrites.set(abs, { sha, expiresAt: Date.now() + EXPECTED_WRITE_TTL_MS })
  // Opportunistic GC so a stale set of expected writes doesn't grow
  // unbounded if the watcher never fires (e.g. in tests).
  if (expectedWrites.size > 256) {
    const now = Date.now()
    for (const [k, v] of expectedWrites) {
      if (v.expiresAt < now) expectedWrites.delete(k)
    }
  }
}

export function consumeExpectedWrite(abs: string, sha: string): boolean {
  const entry = expectedWrites.get(abs)
  if (!entry) return false
  if (entry.expiresAt < Date.now()) {
    expectedWrites.delete(abs)
    return false
  }
  if (entry.sha !== sha) return false
  expectedWrites.delete(abs)
  return true
}

// ── Dispatch ───────────────────────────────────────────────────────

export async function dispatch(event: WebhookEvent): Promise<void> {
  const settings = await loadSettings().catch(() => null)
  const hooks = settings?.webhooks ?? []
  if (hooks.length === 0) return
  const eligible = hooks.filter(
    (h) =>
      h.enabled !== false &&
      h.events.includes(event.type) &&
      (h.owner == null || h.owner === event.actor),
  )
  if (eligible.length === 0) return

  // Back-pointer URL lets the receiver deep-link into Reader without
  // hard-coding the public host.
  const segs = event.path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  const itemUrl = segs ? `${config.appUrl}/${segs}` : `${config.appUrl}/`
  const payload = JSON.stringify({
    ...event,
    ts: Date.now(),
    appUrl: config.appUrl,
    itemUrl,
  })
  await Promise.all(eligible.map((hook) => deliver(hook, payload, event)))
}

async function deliver(
  hook: WebhookConfig,
  payload: string,
  event: WebhookEvent,
  kind: 'dispatch' | 'retry' = 'dispatch',
): Promise<void> {
  let lastStatus: number | null = null
  let lastErr: string | undefined
  const plainSecret = hook.secret ? decryptSecret(hook.secret) : ''
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Reader-Event': event.type,
        'X-Reader-Delivery': crypto.randomUUID(),
        'X-Reader-Attempt': String(attempt + 1),
      }
      if (plainSecret) {
        headers['X-Reader-Signature'] = crypto
          .createHmac('sha256', plainSecret)
          .update(payload)
          .digest('hex')
      }
      const res = await fetch(hook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: ctrl.signal,
      })
      lastStatus = res.status
      if (res.ok) {
        lastErr = undefined
        await persistDelivery(hook.id, {
          status: res.status,
          eventType: event.type,
          kind,
        })
        return
      }
      lastErr = `HTTP ${res.status}`
      // 4xx (except 408/429) are client errors — retry won't help.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        break
      }
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : 'fetch failed'
    } finally {
      clearTimeout(t)
    }
    const backoff = RETRY_BACKOFF_MS[attempt]
    if (backoff != null) await new Promise((r) => setTimeout(r, backoff))
  }
  await persistDelivery(hook.id, {
    status: lastStatus,
    error: lastErr,
    eventType: event.type,
    kind,
  })
  await pushDeadLetter(hook.id, event, lastStatus, lastErr)
}

async function persistDelivery(
  hookId: string,
  result: {
    status: number | null
    error?: string
    eventType: string
    kind: 'dispatch' | 'retry' | 'test'
  },
): Promise<void> {
  try {
    const s = await loadSettings()
    const next = {
      ...s,
      webhooks: (s.webhooks ?? []).map((h) => {
        if (h.id !== hookId) return h
        // Successful delivery resets the circuit-breaker counter so
        // a hook that worked once after a streak of failures gets a
        // clean slate. `circuitOpenedAt` clears too — the hook is
        // healthy by definition the moment it returns 2xx.
        const success = result.status != null && result.status >= 200 && result.status < 300
        const ts = Date.now()
        const recent = (h.recentDeliveries ?? []).slice(-(RECENT_DELIVERIES_CAP - 1))
        recent.push({
          ts,
          status: result.status,
          error: result.error,
          eventType: result.eventType,
          kind: result.kind,
        })
        return {
          ...h,
          lastDelivery: { ts, status: result.status, error: result.error },
          recentDeliveries: recent,
          ...(success
            ? { consecutiveFailures: 0, circuitOpenedAt: undefined }
            : {}),
        }
      }),
    }
    await saveSettings(next)
  } catch {
    /* swallow */
  }
}

async function pushDeadLetter(
  hookId: string,
  event: WebhookEvent,
  status: number | null,
  error: string | undefined,
): Promise<void> {
  try {
    const s = await loadSettings()
    const next = {
      ...s,
      webhooks: (s.webhooks ?? []).map((h) => {
        if (h.id !== hookId) return h
        const dead = h.deadLetter ?? []
        const entry = {
          id: crypto.randomUUID(),
          ts: Date.now(),
          event,
          lastStatus: status,
          lastError: error,
        }
        // Circuit breaker: count consecutive failures. When the
        // streak crosses the threshold, flip enabled→false so the
        // dispatcher stops blocking on a broken receiver. Stamp
        // `circuitOpenedAt` so the UI can render
        // "auto-disabled after N failures" instead of letting the
        // user wonder why their hook silently stopped firing.
        const streak = (h.consecutiveFailures ?? 0) + 1
        const trip = streak >= CIRCUIT_BREAKER_THRESHOLD && h.enabled !== false
        return {
          ...h,
          // Drop the oldest when over the cap so a long-broken receiver
          // doesn't bloat the settings file.
          deadLetter: [...dead.slice(-(DEAD_LETTER_CAP - 1)), entry],
          consecutiveFailures: streak,
          ...(trip
            ? { enabled: false, circuitOpenedAt: Date.now() }
            : {}),
        }
      }),
    }
    await saveSettings(next)
  } catch {
    /* swallow */
  }
}

/** Fire a synthetic test event at the given hook. Used by the
 *  "Send test" button — the user gets a sync status code so they
 *  know whether the receiver is reachable + accepts the payload.
 *  No retries: a test ping is meant to be a single-shot probe. */
export async function pingHook(hook: WebhookConfig): Promise<{
  ok: boolean
  status: number | null
  error?: string
}> {
  const payload = JSON.stringify({
    type: 'test',
    actor: hook.owner ?? 'system',
    ts: Date.now(),
    appUrl: config.appUrl,
    message: 'Reader webhook test ping',
  })
  const plainSecret = hook.secret ? decryptSecret(hook.secret) : ''
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Reader-Event': 'test',
      'X-Reader-Delivery': crypto.randomUUID(),
      'X-Reader-Attempt': 'test',
    }
    if (plainSecret) {
      headers['X-Reader-Signature'] = crypto
        .createHmac('sha256', plainSecret)
        .update(payload)
        .digest('hex')
    }
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: ctrl.signal,
    })
    await persistDelivery(hook.id, {
      status: res.status,
      error: res.ok ? undefined : `HTTP ${res.status}`,
      eventType: 'test',
      kind: 'test',
    })
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` }
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : 'fetch failed'
    await persistDelivery(hook.id, {
      status: null,
      error: err,
      eventType: 'test',
      kind: 'test',
    })
    return { ok: false, status: null, error: err }
  } finally {
    clearTimeout(t)
  }
}

/** Re-attempt a single dead-letter entry. Used by the admin retry
 *  endpoint. Removes the entry on success; leaves it (with updated
 *  attempt count) on continued failure. */
export async function retryDeadLetter(hookId: string, entryId: string): Promise<{
  ok: boolean
  status: number | null
  error?: string
}> {
  const s = await loadSettings()
  const hook = (s.webhooks ?? []).find((h) => h.id === hookId)
  if (!hook) return { ok: false, status: null, error: 'hook not found' }
  const entry = (hook.deadLetter ?? []).find((e) => e.id === entryId)
  if (!entry) return { ok: false, status: null, error: 'entry not found' }
  // `entry.event` is typed as `unknown` on the settings record to
  // keep the store schema stable across event-shape evolutions; cast
  // back to WebhookEvent here so we can use it.
  const ev = entry.event as WebhookEvent
  const payload = JSON.stringify({
    ...ev,
    ts: Date.now(),
    appUrl: config.appUrl,
    itemUrl: ev.path
      ? `${config.appUrl}/${ev.path
          .split('/')
          .filter(Boolean)
          .map(encodeURIComponent)
          .join('/')}`
      : `${config.appUrl}/`,
  })
  const plainSecret = hook.secret ? decryptSecret(hook.secret) : ''
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let status: number | null = null
  let err: string | undefined
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Reader-Event': ev.type,
      'X-Reader-Delivery': crypto.randomUUID(),
      'X-Reader-Attempt': 'retry',
    }
    if (plainSecret) {
      headers['X-Reader-Signature'] = crypto
        .createHmac('sha256', plainSecret)
        .update(payload)
        .digest('hex')
    }
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: payload,
      signal: ctrl.signal,
    })
    status = res.status
    if (!res.ok) err = `HTTP ${res.status}`
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : 'fetch failed'
  } finally {
    clearTimeout(t)
  }
  if (!err) {
    // Success — drop the entry from the DLQ first, then route the
    // success through persistDelivery so it lands in recentDeliveries
    // and resets the circuit-breaker counter (same as a fresh dispatch
    // that returned 2xx).
    const fresh = await loadSettings()
    await saveSettings({
      ...fresh,
      webhooks: (fresh.webhooks ?? []).map((h) =>
        h.id === hookId
          ? { ...h, deadLetter: (h.deadLetter ?? []).filter((e) => e.id !== entryId) }
          : h,
      ),
    })
    await persistDelivery(hookId, {
      status,
      eventType: ev.type,
      kind: 'retry',
    })
    return { ok: true, status }
  }
  await persistDelivery(hookId, {
    status,
    error: err,
    eventType: ev.type,
    kind: 'retry',
  })
  return { ok: false, status, error: err }
}
