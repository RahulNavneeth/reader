// Service worker for the capture flow. Lives long enough to
// complete the fetch even when the popup closes (popups in MV3
// can be torn down the moment focus is lost — running the fetch
// here keeps it alive for the round-trip).

type Payload = {
  subject: string
  from: string
  body: string
  received: number
}

type Msg = {
  type: 'capture'
  payload: Payload
  server: string
  token: string
}

async function postCapture(msg: Msg): Promise<
  { ok: true; storageKey: string } | { ok: false; error: string }
> {
  const url = msg.server.replace(/\/+$/, '') + '/api/intake/email'
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The intake endpoint accepts the same Bearer-token auth
        // as /mcp. The popup ships an API token the user minted
        // via Reader → Account → API tokens.
        authorization: `Bearer ${msg.token}`,
      },
      body: JSON.stringify(msg.payload),
    })
    if (!r.ok) {
      // Try to surface the server's error message — most of our
      // intake errors are JSON `{ error: "..." }`.
      let detail = `HTTP ${r.status}`
      try {
        const body = (await r.json()) as { error?: string }
        if (body?.error) detail = body.error
      } catch {
        /* not json — keep the status code */
      }
      return { ok: false, error: detail }
    }
    const body = (await r.json()) as {
      document?: { storageKey?: string }
    }
    return {
      ok: true,
      storageKey: body.document?.storageKey ?? '(saved)',
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'network error' }
  }
}

chrome.runtime.onMessage.addListener(
  (msg: Msg, _sender, sendResponse) => {
    if (msg?.type !== 'capture') return false
    // Return true to keep the message channel open for the async
    // sendResponse — MV3's listener protocol.
    void postCapture(msg).then(sendResponse)
    return true
  },
)
