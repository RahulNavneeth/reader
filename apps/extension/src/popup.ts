// Popup controller. Reads the active tab, lets the user trigger
// a capture, and exposes a Settings form (server URL + token).
//
// The actual capture lives in background.ts — the popup only knows
// how to ask politely. Background does the fetch + auth header
// because the popup closes the moment it loses focus, which would
// abort an in-flight fetch.

type CapturePayload = {
  subject: string
  from: string
  body: string
  received: number
}

type CaptureResponse =
  | { ok: true; storageKey: string }
  | { ok: false; error: string }

async function readSettings(): Promise<{ server: string; token: string }> {
  const r = (await chrome.storage.local.get(['serverUrl', 'apiToken'])) as {
    serverUrl?: string
    apiToken?: string
  }
  return {
    server: (r.serverUrl ?? '').trim(),
    token: (r.apiToken ?? '').trim(),
  }
}

async function writeSettings(server: string, token: string): Promise<void> {
  await chrome.storage.local.set({ serverUrl: server, apiToken: token })
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing from popup.html`)
  return el
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function extractFromTab(
  tabId: number,
): Promise<{ title: string; url: string; selection: string; bodyText: string }> {
  // Inject the content script on demand (manifest's `scripting`
  // permission + `activeTab` covers this). The script returns its
  // payload via the executeScript result instead of long-living
  // message passing.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  })
  const payload = results[0]?.result as
    | { title: string; url: string; selection: string; bodyText: string }
    | undefined
  if (!payload) throw new Error('content script returned no payload')
  return payload
}

async function captureCurrentTab(): Promise<CaptureResponse> {
  const tab = await getActiveTab()
  if (!tab || tab.id == null) return { ok: false, error: 'no active tab' }
  const settings = await readSettings()
  if (!settings.server || !settings.token) {
    return { ok: false, error: 'server URL + token required (⚙ Settings)' }
  }
  const extracted = await extractFromTab(tab.id)
  const payload: CapturePayload = {
    subject: extracted.title || tab.title || 'Untitled',
    from: extracted.url || tab.url || '',
    // Prefer the user's selection if any; otherwise the cleaned
    // article body. Both are plain text — server-side ingest does
    // the markdown rendering.
    body: extracted.selection || extracted.bodyText || extracted.url || '',
    received: Date.now(),
  }
  const resp = await chrome.runtime.sendMessage({
    type: 'capture',
    payload,
    server: settings.server,
    token: settings.token,
  })
  return resp as CaptureResponse
}

// ── Wire up ────────────────────────────────────────────────────────

;(async () => {
  const titleEl = $('page-title')
  const urlEl = $('page-url')
  const statusEl = $('status')
  const captureBtn = $('capture') as HTMLButtonElement
  const settingsBtn = $('toggle-settings')
  const settingsForm = $('settings')
  const serverInput = $('server') as HTMLInputElement
  const tokenInput = $('token') as HTMLInputElement
  const saveBtn = $('save') as HTMLButtonElement

  const tab = await getActiveTab()
  titleEl.textContent = tab?.title ?? '—'
  urlEl.textContent = tab?.url ?? '—'

  const initial = await readSettings()
  serverInput.value = initial.server
  tokenInput.value = initial.token
  if (!initial.server || !initial.token) {
    settingsForm.classList.remove('hidden')
    statusEl.textContent = 'Set the server URL + token to start capturing.'
    statusEl.className = 'status err'
  }

  settingsBtn.addEventListener('click', () => {
    settingsForm.classList.toggle('hidden')
  })

  saveBtn.addEventListener('click', async () => {
    const server = serverInput.value.trim().replace(/\/+$/, '')
    const token = tokenInput.value.trim()
    if (!server || !token) {
      statusEl.textContent = 'Both fields are required.'
      statusEl.className = 'status err'
      return
    }
    await writeSettings(server, token)
    statusEl.textContent = 'Saved.'
    statusEl.className = 'status ok'
    settingsForm.classList.add('hidden')
  })

  captureBtn.addEventListener('click', async () => {
    captureBtn.disabled = true
    statusEl.textContent = 'Capturing…'
    statusEl.className = 'status'
    try {
      const r = await captureCurrentTab()
      if (r.ok) {
        statusEl.textContent = `Saved to ${r.storageKey}`
        statusEl.className = 'status ok'
      } else {
        statusEl.textContent = r.error
        statusEl.className = 'status err'
      }
    } catch (e) {
      statusEl.textContent = (e as Error).message || 'capture failed'
      statusEl.className = 'status err'
    } finally {
      captureBtn.disabled = false
    }
  })
})()
