# Reader — Browser Extension

One-click capture from any webpage into your Reader vault. The
extension submits the page's title + URL + selected text to your
Reader instance's `/api/intake/email` endpoint, authenticated by
an API token you mint in the Reader UI.

## Architecture

- **`manifest.json`** — Manifest V3. Uses `activeTab` so the
  extension only sees a page after the user clicks the icon; no
  background spying.
- **`src/popup.html` + `src/popup.ts`** — small popup UI: shows
  the server URL, token (hidden), a Capture button, and the
  current page's title. Clicking Capture sends to the background
  worker.
- **`src/background.ts`** — service worker. Receives the capture
  message, builds the JSON intake payload, POSTs it to
  `<serverUrl>/api/intake/email` with the Bearer token.
- **`src/content.ts`** — content script lazy-injected on capture.
  Reads `document.title`, the active selection, and a Readability-
  lite cleaned-up body. No DOM mutations.

## Build

```sh
cd apps/extension
npm install
npm run build
```

Output lands in `dist/`. Load it via `chrome://extensions` →
**Load unpacked** → select `apps/extension/dist`.

## Configure

In the popup, click ⚙ → enter:

- **Server URL** — e.g. `https://docs.example.com`
- **API token** — minted via Reader → Account → API tokens.

Settings persist in `chrome.storage.local`.

## What it captures

Per click:

- `subject` = the page's `<title>`
- `from` = the page URL
- `body` = the selection if there is one, otherwise the cleaned
  article body. Both are markdownified server-side by the
  ingest pipeline (the extension ships plain text).
- `received` = capture time.

The resulting document lands in your Reader vault at
`Inbox/<YYYY-MM-DD>-<page-slug>.md` and shows up in search +
chat immediately.
