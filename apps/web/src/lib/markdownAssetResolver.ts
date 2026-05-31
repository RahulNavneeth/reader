/**
 * Resolve markdown asset/link URLs against the current doc's folder.
 *
 * Two responsibilities:
 *
 * 1. **Relative → absolute (vault-root)** — `./photos/sunset.jpg`
 *    inside a doc at `notes/trip.md` becomes `notes/photos/sunset.jpg`.
 *    Handles `./`, plain relative, `../` walks, and `/`-prefixed
 *    vault-root absolute paths uniformly.
 *
 * 2. **Encoding normalization** — markdown URLs may arrive raw
 *    (`project abstract.png`), already percent-encoded
 *    (`project%20abstract.png`), or somewhere in between. We
 *    decode-then-encode so the final URL contains exactly one
 *    canonical encoding per character — without this, `%20` was
 *    being re-encoded to `%2520` and the browser fetched a
 *    nonexistent path.
 *
 * Pass-throughs (no rewriting at all):
 *   - explicit scheme (http://, https://, mailto:, data:, …)
 *   - server-absolute API paths (/api/…)
 *   - in-page fragments (#section)
 */

/** Absolute URLs we should pass through unchanged. */
function isPassThrough(url: string): boolean {
  if (!url) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return true
  if (url.startsWith('/api/')) return true
  if (url.startsWith('#')) return true
  return false
}

/**
 * Decode-then-encode a single path segment.
 *
 * The caller's URL might already contain percent-encoded bytes
 * (`project%20abstract.png`). A naive `encodeURIComponent` would
 * re-encode the `%` and produce `project%2520abstract.png`. We
 * decode first to normalize to raw chars, then encode once.
 *
 * `decodeURIComponent` throws on malformed sequences (e.g. `%ZZ`).
 * In that rare case we treat the input as already-raw and only
 * encode — which is the same behavior the user would expect.
 */
function encodeSegment(seg: string): string {
  let raw = seg
  try {
    raw = decodeURIComponent(seg)
  } catch {
    /* not a valid encoded sequence — treat as literal */
  }
  return encodeURIComponent(raw)
}

/** Vault-root-relative form of a path. Handles `./`, plain
 *  relative, `../` walks, and `/`-prefixed absolutes. The output
 *  is suitable for storage / lookup (NOT yet URL-encoded). */
export function resolveRelative(parentDir: string, href: string): string {
  if (!href) return href
  // `/foo.jpg` is already vault-root absolute — strip the slash and
  // return as-is. The intent of the user was "absolute path inside
  // the vault, ignore parentDir".
  if (href.startsWith('/')) {
    return href.replace(/^\/+/, '')
  }
  const base = parentDir.split('/').filter(Boolean)
  // Strip query + fragment so they're re-appended verbatim at the end.
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

/** Append `?owner=…&p=…&via=…&viaOwner=…` to an API URL, mirroring
 *  callerOpts. `via` / `viaOwner` carry the parent doc identity so
 *  the server can grant a transitive embed read on inline assets
 *  even when the requester has no direct share on the asset. */
function appendCaller(
  base: string,
  callerOpts:
    | { owner?: string; password?: string; via?: string; viaOwner?: string }
    | undefined,
): string {
  if (!callerOpts) return base
  const params = new URLSearchParams()
  if (callerOpts.owner) params.set('owner', callerOpts.owner)
  if (callerOpts.password) params.set('p', callerOpts.password)
  if (callerOpts.via) params.set('via', callerOpts.via)
  if (callerOpts.viaOwner) params.set('viaOwner', callerOpts.viaOwner)
  const q = params.toString()
  if (!q) return base
  return base.includes('?') ? `${base}&${q}` : `${base}?${q}`
}

/** Build the query-param-safe encoding of a vault path (folders
 *  preserved as `/` separators, each segment normalized). */
function encodeVaultPath(rel: string): string {
  return rel.split('/').map(encodeSegment).join('/')
}

/** Resolve `<img src>` — always points at the raw byte stream. */
export function resolveImageSrc(
  parentDir: string,
  src: string,
  callerOpts?: {
    owner?: string
    password?: string
    via?: string
    viaOwner?: string
  },
): string {
  if (isPassThrough(src)) return src
  const rel = resolveRelative(parentDir, src)
  // Strip a fragment if any — meaningless for an image.
  const cleanRel = rel.split('#')[0]
  // Bare path — see api.rawUrl for the rationale. The backend's
  // setNotFoundHandler routes non-text/html GETs through the same
  // file-bytes pipeline as /api/file/raw.
  const url = '/' + encodeVaultPath(cleanRel)
  return appendCaller(url, callerOpts)
}

/**
 * Pull an Obsidian-style size hint out of an image's alt text.
 *
 *   `![photo|400](photo.jpg)`     → width 400 px
 *   `![photo|400x300](photo.jpg)` → 400×300 px
 *   `![photo|50%](photo.jpg)`     → width 50%
 *
 * Returns the size as plain CSS values (`px` appended when a bare
 * number is given) and the cleaned alt text. If alt has no pipe,
 * the original alt is returned and size fields are undefined.
 */
export function parseImageSize(
  altRaw: string | undefined | null,
): { alt: string; width?: string; height?: string } {
  const alt = (altRaw ?? '').trim()
  const pipe = alt.lastIndexOf('|')
  if (pipe < 0) return { alt }
  const sizeRaw = alt.slice(pipe + 1).trim()
  const cleanAlt = alt.slice(0, pipe).trim()
  // Matches "400", "400px", "50%", "400x300", "400px x 300px", etc.
  const match = sizeRaw.match(
    /^(\d+(?:\.\d+)?)(px|%|em|rem|vh|vw)?(?:\s*[x×]\s*(\d+(?:\.\d+)?)(px|%|em|rem|vh|vw)?)?$/i,
  )
  if (!match) return { alt }
  const toCss = (n: string | undefined, unit: string | undefined): string | undefined => {
    if (!n) return undefined
    return `${n}${unit ?? 'px'}`
  }
  return {
    alt: cleanAlt,
    width: toCss(match[1], match[2]),
    height: toCss(match[3], match[4]),
  }
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
  // Split off fragment so the path can route through React Router
  // while the anchor still navigates to the heading.
  const [pathPart, hashPart = ''] = rel.split('#', 2)
  const encoded = encodeVaultPath(pathPart)
  const qs = callerOpts?.owner
    ? `?owner=${encodeURIComponent(callerOpts.owner)}`
    : ''
  const hash = hashPart ? `#${hashPart}` : ''
  return `/${encoded}${qs}${hash}`
}
