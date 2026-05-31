/**
 * Build SPA URLs for vault items.
 *
 * One URL form per ownership case so callers don't have to remember
 * which query string disambiguates a shared doc:
 *
 *   - Own vault          → `/<path>`
 *   - Shared from owner  → `/u/<owner>/<path>`
 *
 * Centralising this avoids the path-clash bug we hit before — same
 * bare path under two owners would resolve ambiguously, and the
 * embedded-asset URLs the markdown renderer built downstream would
 * fall through to the requester's own vault instead of the share
 * owner's.
 */

function encodePath(rel: string): string {
  return rel
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/** Build a vault path URL.
 *
 *   - `/u/<owner>/<path>` only when `owner` is set AND differs from
 *     the requester (true cross-user share view).
 *   - `/<path>` in every other case: own vault, anonymous viewer,
 *     or any time we can't prove the owner is someone else.
 *
 *  We deliberately fall back to the bare form when `requester` is
 *  missing rather than guessing — a transient render where the
 *  signed-in user hasn't loaded yet shouldn't rewrite an own-vault
 *  URL into the shared `/u/...` namespace. */
export function vaultUrl(
  rel: string,
  opts?: { owner?: string; requester?: string },
): string {
  const owner = opts?.owner
  const requester = opts?.requester
  const isShared = !!owner && !!requester && owner !== requester
  const encoded = encodePath(rel)
  if (isShared) {
    return `/u/${encodeURIComponent(owner!)}/${encoded}`
  }
  return encoded ? `/${encoded}` : '/'
}
