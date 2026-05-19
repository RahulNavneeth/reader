/**
 * Cross-context clipboard write with a legacy fallback.
 *
 * `navigator.clipboard.writeText` can fail in ways that look like a
 * no-op because the promise rejects asynchronously:
 *   - The page is on `http://` (clipboard API is restricted to
 *     secure contexts; only https + localhost work).
 *   - A reverse proxy injected `Permissions-Policy: clipboard-write=()`.
 *   - The browser dropped the user-gesture token because we awaited
 *     something else before the write call.
 *   - The user agent simply doesn't expose `navigator.clipboard`
 *     (older Safari in some iframe sandboxes, certain WebViews).
 *
 * The fallback is the deprecated-but-universal `document.execCommand
 * ('copy')` over a temporary `<textarea>`. It's synchronous, doesn't
 * require a secure context, and works inside any user-gesture
 * handler — at the cost of having to briefly mount + focus an
 * invisible element. We try the modern API first and only fall back
 * if it throws or isn't there.
 *
 * Returns true on success. Returns false (instead of throwing) so
 * callers can surface a meaningful UI error without managing two
 * separate failure paths.
 */
export async function copyText(text: string): Promise<boolean> {
  // Modern path. Guard with both feature-detect AND a secure-context
  // check so we don't even attempt it on http:// pages — saves the
  // user a console warning about the missing permission.
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function' &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path.
    }
  }

  // Legacy fallback. Position off-screen rather than display:none
  // because some browsers refuse to select() an unrendered element.
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  try {
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}
