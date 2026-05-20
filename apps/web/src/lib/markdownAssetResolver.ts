/**
 * Resolve markdown asset/link URLs against the current doc's folder.
 *
 * Without this, `![photo](./photos/sunset.jpg)` inside a doc at
 * `notes/trip.md` renders broken — the browser resolves the URL
 * relative to the current page (`/notes/trip.md` → `/notes/photos/
 * sunset.jpg`) and gets a 404 because that path isn't an API route.
 *
 * We rewrite relative URLs into the vault's serving API (or into
 * SPA routes for navigable docs), preserving the cross-owner
 * `?owner=` hint so a recipient browsing a shared subtree stays in
 * their shared context.
 */

/** Absolute URLs we should pass through unchanged. */
function isPassThrough(url: string): boolean {
  if (!url) return true
  // Any explicit scheme (http://, https://, mailto:, data:, etc.).
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return true
  // Server-absolute API paths.
  if (url.startsWith('/api/')) return true
  // Pure in-page anchors (rehype-slug handles these).
  if (url.startsWith('#')) return true
  return false
}

/** Compute the vault-relative path for an asset referenced from a
 *  markdown document at `parentDir`. Handles `./`, plain relative,
 *  `../` walks, and `/` as a vault-root absolute. */
export function resolveRelative(parentDir: string, href: string): string {
  if (!href) return href
  // Vault-root absolute — `/foo.jpg` resolves to `foo.jpg`.
  if (href.startsWith('/')) {
    return href.replace(/^\/+/, '').split(/[#?]/)[0]
  }
  const base = parentDir.split('/').filter(Boolean)
  // Strip query + fragment for path resolution; we re-append below.
  const [pathPart, ...rest] = href.split(/([#?].*)/)
  const trailing = rest.join('')
  const segments = pathPart.split('/').filter(Boolean)
  const out = [...base]
  for (const seg of segments) {
    if (seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/') + trailing
}

/** Append `?owner=…&p=…` to an API URL, mirroring callerOpts. */
function appendCaller(
  base: string,
  callerOpts: { owner?: string; password?: string } | undefined,
): string {
  if (!callerOpts) return base
  const params = new URLSearchParams()
  if (callerOpts.owner) params.set('owner', callerOpts.owner)
  if (callerOpts.password) params.set('p', callerOpts.password)
  const q = params.toString()
  if (!q) return base
  return base.includes('?') ? `${base}&${q}` : `${base}?${q}`
}

/** Resolve `<img src>` — always points at the raw byte stream. */
export function resolveImageSrc(
  parentDir: string,
  src: string,
  callerOpts?: { owner?: string; password?: string },
): string {
  if (isPassThrough(src)) return src
  const rel = resolveRelative(parentDir, src)
  // Strip a fragment if any — meaningless for an image.
  const cleanRel = rel.split('#')[0]
  const url = `/api/file/raw?path=${encodeURIComponent(cleanRel)}`
  return appendCaller(url, callerOpts)
}

/** Resolve `<a href>` — routes back through the SPA so internal
 *  navigation feels native (the file viewer takes over). External
 *  schemes pass through. */
export function resolveLinkHref(
  parentDir: string,
  href: string,
  callerOpts?: { owner?: string },
): string {
  if (isPassThrough(href)) return href
  const rel = resolveRelative(parentDir, href)
  // Split off fragment so we can route the path through React Router
  // and reattach the anchor for in-doc jumps.
  const [pathPart, hashPart = ''] = rel.split('#', 2)
  const encoded = pathPart.split('/').map(encodeURIComponent).join('/')
  const qs = callerOpts?.owner
    ? `?owner=${encodeURIComponent(callerOpts.owner)}`
    : ''
  const hash = hashPart ? `#${hashPart}` : ''
  return `/${encoded}${qs}${hash}`
}
