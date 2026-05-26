/**
 * Resolvers for the template engine's async hooks.
 *   loadInclude  — read a markdown file from the user's vault, optionally
 *                  narrowed to one section.
 *   loadFetch    — HTTP GET, gated by an admin allowlist + SSRF blocks
 *                  + timeout + max bytes.
 *
 * Kept separate from the engine so the engine stays IO-free and the
 * security policy lives in one auditable file.
 */
import { readFile, stat } from 'node:fs/promises'
import { resolveUserVault } from '../lib/userVault.js'
import { loadSettings } from '../stores/settings.js'

const MAX_INCLUDE_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 10_000
const MAX_FETCH_BYTES = 100 * 1024

const PRIVATE_HOST_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:|fc00:|fd00:|0\.0\.0\.0$|localhost$)/i

function isPrivateHost(host: string): boolean {
  if (PRIVATE_HOST_RE.test(host)) return true
  // 172.16.0.0/12
  const m172 = host.match(/^172\.(\d+)\./)
  if (m172) {
    const second = Number(m172[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

function matchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase()
  for (const raw of allowlist) {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) continue
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      if (h === pattern.slice(2) || h.endsWith(suffix)) return true
    } else if (pattern === h) {
      return true
    }
  }
  return false
}

/** Pull the body of one named markdown section from `content`.
 *  Match is case-insensitive on the heading text (with leading `#`s
 *  stripped). Returns from the first matching heading to the next
 *  same-or-higher heading. */
export function extractSection(content: string, sectionName: string): string {
  const want = sectionName.trim().toLowerCase()
  const lines = content.split('\n')
  let inSection = false
  let sectionLevel = 0
  const out: string[] = []
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].trim().toLowerCase()
      if (inSection && level <= sectionLevel) break
      if (!inSection && title === want) {
        inSection = true
        sectionLevel = level
        continue
      }
    }
    if (inSection) out.push(line)
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '')
}

/** Build a `loadInclude` bound to one user's vault. Path is
 *  resolved through `resolveUserVault` so a template author can't
 *  escape with `../`. */
export function makeVaultIncludeResolver(username: string) {
  return async (path: string, section: string | undefined): Promise<string> => {
    const cleaned = path.replace(/^\/+|\/+$/g, '')
    if (!cleaned) throw new Error('include: empty path')
    if (!/\.(md|markdown|mdx|txt)$/i.test(cleaned)) {
      throw new Error(`include: only markdown/text files allowed (got ${cleaned})`)
    }
    const abs = resolveUserVault(username, cleaned)
    const s = await stat(abs).catch(() => null)
    if (!s) throw new Error(`include: not found (${cleaned})`)
    if (s.size > MAX_INCLUDE_BYTES) {
      throw new Error(
        `include: ${cleaned} exceeds ${MAX_INCLUDE_BYTES} bytes`,
      )
    }
    const body = (await readFile(abs)).toString('utf8')
    if (section) {
      const sliced = extractSection(body, section)
      if (!sliced) throw new Error(`include: section "${section}" not found in ${cleaned}`)
      return sliced
    }
    return body
  }
}

/** Build a `loadFetch` that respects the admin settings:
 *   - templates.allowFetch must be true
 *   - templates.fetchAllowlist must list the URL's host (exact or *.suffix)
 *   - private / link-local / loopback addresses always blocked
 *   - 10s timeout, 100KB cap, GET only, follows redirects but each
 *     hop is re-validated against the same checks.
 */
export function makeUrlFetchResolver() {
  return async (raw: string): Promise<string> => {
    const settings = await loadSettings()
    const cfg = settings.templates ?? {}
    if (!cfg.allowFetch) {
      throw new Error('fetch: disabled in admin settings')
    }
    const allowlist = Array.isArray(cfg.fetchAllowlist) ? cfg.fetchAllowlist : []
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`fetch: invalid URL (${raw})`)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`fetch: only http/https schemes allowed (got ${url.protocol})`)
    }
    if (isPrivateHost(url.hostname)) {
      throw new Error(`fetch: blocked private / loopback host ${url.hostname}`)
    }
    if (!matchesAllowlist(url.hostname, allowlist)) {
      throw new Error(`fetch: host ${url.hostname} not in allowlist`)
    }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'user-agent': 'Reader/template-fetch',
          // Nudge content-negotiating endpoints toward a text
          // response so e.g. icanhazdadjoke returns the joke
          // instead of an HTML page. Servers ignoring the header
          // still get a chance via the content-type allowlist
          // below.
          accept: 'text/plain, application/json;q=0.9, text/markdown;q=0.8, */*;q=0.5',
        },
      })
      if (!res.ok) throw new Error(`fetch: ${url.hostname} returned ${res.status}`)
      const ct = (res.headers.get('content-type') ?? '').toLowerCase()
      if (
        ct &&
        !ct.startsWith('text/') &&
        !ct.includes('json') &&
        !ct.includes('xml') &&
        !ct.includes('markdown')
      ) {
        throw new Error(`fetch: refusing non-text content-type ${ct}`)
      }
      // Buffer with byte cap — abort the stream as soon as we
      // cross the limit so a hostile server can't bleed us out.
      const reader = res.body?.getReader()
      if (!reader) return ''
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_FETCH_BYTES) {
          reader.cancel().catch(() => null)
          throw new Error(`fetch: response exceeds ${MAX_FETCH_BYTES} bytes`)
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      clearTimeout(t)
    }
  }
}
