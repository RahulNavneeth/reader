// Content script. Lazy-injected by the popup via
// chrome.scripting.executeScript when the user clicks Capture.
// Returns a small payload (title + URL + selection + cleaned body)
// back to the popup via the executeScript result channel.
//
// We don't ship Readability.js because every kilobyte counts for
// an MV3 extension — instead we do a "Readability-lite" pass:
// drop scripts/styles/nav/footer/header, then walk the remaining
// text nodes and join with sensible newlines. For most blog posts
// + news articles + docs sites this produces clean enough text
// for Reader's downstream markdown + AI pipeline.

;(() => {
  function getSelectionText(): string {
    const sel = window.getSelection?.()
    return sel ? sel.toString().trim() : ''
  }

  function extractBodyText(): string {
    // Clone the body so our pruning never affects the live page.
    const root = document.body?.cloneNode(true) as HTMLElement | null
    if (!root) return ''
    const DROP = [
      'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
      'nav', 'footer', 'header', 'aside',
      '[hidden]', '[aria-hidden="true"]',
    ]
    for (const sel of DROP) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        el.parentNode?.removeChild(el)
      }
    }
    // Prefer an <article> / [role=main] if present — that's
    // typically the readable body on a content site.
    const candidate =
      root.querySelector('article') ??
      root.querySelector('[role="main"]') ??
      root.querySelector('main') ??
      root
    // Use innerText so the browser handles block-level whitespace
    // for us; we just normalize multiple blank lines.
    const text = (candidate as HTMLElement).innerText || ''
    return text
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 200_000) // 200k char ceiling per capture
  }

  const payload = {
    title: document.title || '',
    url: location.href || '',
    selection: getSelectionText(),
    bodyText: extractBodyText(),
  }
  // Return value of the LAST expression is what executeScript
  // surfaces as result[0].result.
  return payload
})()
