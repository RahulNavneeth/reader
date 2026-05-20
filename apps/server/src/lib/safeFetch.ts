/**
 * Server-side URL fetch with SSRF + size + timeout guards.
 *
 * Used by MCP `upload_from_url` so an agent can hand Reader a URL
 * and have the file land in the vault — without letting it pivot
 * Reader into our internal network or pull a multi-GB blob that
 * fills the disk.
 *
 * Protections:
 *   1. Scheme whitelist (http/https only — no file://, ftp://,
 *      gopher://, dict://, etc.).
 *   2. Host blocklist via DNS resolution + IP range check
 *      (loopback / link-local / RFC1918 / RFC4193 ULA, IPv4-mapped
 *      IPv6 included). This catches the `evil.com` → `192.168.1.1`
 *      trick a URL-string parser alone would miss.
 *   3. **DNS-rebinding resistant** — we pre-resolve the hostname
 *      once, validate the IP set, and then hand undici a dispatcher
 *      whose `connect.lookup` returns one of those validated IPs
 *      verbatim. Without this, an attacker-controlled DNS could
 *      return a public IP on our check and a private one on the
 *      fetch's resolution. The TLS handshake still uses the
 *      original hostname for SNI + certificate validation.
 *   4. Redirects disabled by default. An attacker could otherwise
 *      301 from a public host to an internal one. The agent
 *      should provide the canonical URL.
 *   5. Total response size capped at the configured maxBytes —
 *      reading is bounded so a `Transfer-Encoding: chunked`
 *      response can't blow past the limit.
 *   6. Connect + read timeout via AbortController.
 *
 * Returns the body buffer + the negotiated Content-Type. Throws
 * with an actionable message on any guard failure.
 */
import dns from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import net from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

type SafeFetchOptions = {
  /** Hard cap on response bytes. Reader refuses past this. */
  maxBytes: number
  /** Connection + read timeout in milliseconds. */
  timeoutMs: number
}

/** Throws on disallowed URL. Performs DNS resolution to catch a
 *  domain that points at a private IP. Returns the parsed URL + the
 *  validated IP set so the caller can pin the connection to one of
 *  them (DNS-rebinding defense). */
async function assertSafeUrl(
  rawUrl: string,
): Promise<{ url: URL; ips: LookupAddress[] }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https URLs are allowed (got ${url.protocol})`)
  }
  // IP literal? Then we don't go through DNS at all — just check it
  // directly. `URL` keeps brackets on IPv6 literals; strip them.
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(
        `refusing to fetch from a private/loopback address (${hostname})`,
      )
    }
    return { url, ips: [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }] }
  }
  let resolved: LookupAddress[]
  try {
    resolved = await dns.lookup(hostname, { all: true })
  } catch {
    throw new Error(`unable to resolve host: ${hostname}`)
  }
  for (const addr of resolved) {
    if (isPrivateIp(addr.address)) {
      throw new Error(
        `refusing to fetch from a private/loopback address (${addr.address} for ${hostname})`,
      )
    }
  }
  return { url, ips: resolved }
}

/** Split a data: URI into its declared MIME (if any) and the
 *  base64 (or url-encoded) payload. Returns `null` for anything
 *  that isn't a data URI so the caller falls through to its
 *  normal base64 path. Used by `upload_file` because agents
 *  routinely hand over the full data URI rather than the raw
 *  payload. */
export function parseDataUri(input: string): { mime?: string; data: string } | null {
  const m = input.match(/^data:([^;,]+)?(?:;[^,]*)?,([\s\S]*)$/)
  if (!m) return null
  return {
    mime: m[1] && m[1].trim() ? m[1].trim() : undefined,
    data: m[2],
  }
}

/** Strip embedded credentials from a URL for logging. `https://
 *  user:pass@host/path` → `https://host/path`. Used to keep
 *  passwords out of the audit log. */
export function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return '[invalid URL]'
  }
}

/** True for any IP in a loopback, link-local, private, ULA, or
 *  CGNAT range — the address families an external-fetch tool
 *  should never reach. IPv4-mapped IPv6 (::ffff:10.0.0.1) is
 *  unmapped + re-checked so the same rules apply. */
export function isPrivateIp(addr: string): boolean {
  // IPv4-mapped IPv6 → unwrap.
  const v4Map = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (v4Map) return isPrivateIp(v4Map[1])

  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number)
    if (a === 0) return true                 // 0.0.0.0/8
    if (a === 10) return true                // 10/8 RFC1918
    if (a === 127) return true               // 127/8 loopback
    if (a === 169 && b === 254) return true  // 169.254/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 RFC1918
    if (a === 192 && b === 168) return true  // 192.168/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
    if (a >= 224) return true                // multicast + reserved
    return false
  }
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase()
    if (a === '::1') return true             // loopback
    if (a === '::') return true              // unspecified
    if (a.startsWith('fe80:')) return true   // link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true // ULA fc00::/7
    if (a.startsWith('ff')) return true      // multicast
    return false
  }
  // Not parseable as either — treat as unsafe.
  return true
}

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  const { url, ips } = await assertSafeUrl(rawUrl)

  // Pick the first validated address. The undici Agent's `connect.lookup`
  // hook returns it verbatim, so the actual TCP/TLS connection goes to
  // the IP we already approved. The original hostname is still passed
  // through for SNI + certificate validation.
  const pinnedIp = ips[0].address
  const pinnedFamily: 4 | 6 = ips[0].family === 6 ? 6 : 4
  const dispatcher = new Agent({
    connect: {
      // `node:net`'s lookup contract is mode-dependent: with `all: true`
      // the callback wants `[{ address, family }, ...]`, otherwise it
      // wants `(err, address, family)`. Node's connection path uses
      // `all: true`, but be safe for either caller.
      lookup: (_hostname, options, callback) => {
        const cb = callback as (...args: unknown[]) => void
        if (options && (options as { all?: boolean }).all) {
          cb(null, [{ address: pinnedIp, family: pinnedFamily }])
        } else {
          cb(null, pinnedIp, pinnedFamily)
        }
      },
    },
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    // `redirect: 'error'` makes fetch throw on any 3xx. An attacker
    // who pierced our DNS check via a public host that 301s to a
    // private one is stopped here. Real-world download URLs are
    // almost always direct.
    const res = await undiciFetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      dispatcher,
      headers: {
        // Polite UA + accept-everything so servers don't serve
        // an HTML "you need a real browser" decoy.
        'User-Agent': 'reader/0.6 (+https://github.com/RahulNavneeth/reader)',
        Accept: '*/*',
      },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${url.host}`)
    }
    // Bail early if Content-Length already overruns the cap.
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > opts.maxBytes) {
      throw new Error(
        `response Content-Length ${declared} exceeds the ${opts.maxBytes}-byte cap`,
      )
    }
    // Stream in to enforce maxBytes even when Content-Length lies
    // (e.g. chunked transfer). Each chunk gets size-checked before
    // we accept it.
    const reader = res.body?.getReader()
    if (!reader) throw new Error('empty response body')
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > opts.maxBytes) {
        controller.abort()
        throw new Error(`response exceeded ${opts.maxBytes}-byte cap`)
      }
      chunks.push(value)
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
    return {
      buffer,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      finalUrl: res.url || url.toString(),
    }
  } catch (e) {
    const err = e as Error & { name?: string }
    if (err.name === 'AbortError') {
      throw new Error(`request timed out after ${opts.timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(timer)
    // Close pooled sockets so the dispatcher doesn't leak for
    // single-shot fetches.
    void dispatcher.close().catch(() => {})
  }
}
