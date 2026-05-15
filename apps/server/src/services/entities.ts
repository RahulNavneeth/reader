/**
 * Lightweight entity extraction. Pure regex — no ML deps — over the
 * extracted text of a document. Pulls dates, currency amounts, emails, URLs,
 * and a heuristic set of ORG / PROPER NOUN candidates.
 *
 * Stored on the meta as `entities: { dates: [], amounts: [], emails: [],
 * urls: [], orgs: [] }`. Each list is deduped and capped at N to keep meta
 * small.
 */

const CAP = 30

const DATE_PATTERNS: RegExp[] = [
  // 2026-05-15, 2026/05/15, 2026.05.15
  /\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/g,
  // 15/05/2026, 15-05-2026
  /\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d{2}|19\d{2})\b/g,
  // 15 May 2026 / May 15, 2026
  /\b(0?[1-9]|[12]\d|3[01])\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2}|19\d{2})\b/gi,
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(0?[1-9]|[12]\d|3[01]),\s+(20\d{2}|19\d{2})\b/gi,
]

// Symbol-prefixed: ₹, $, €, £, ¥ + grouped or simple amount. Also "Rs."
const AMOUNT_RE =
  /\b(?:Rs\.?|INR|USD|EUR|GBP|JPY|CAD|AUD)?\s*[₹$€£¥]?\s*\d{1,3}(?:[,\s]\d{2,3})*(?:\.\d{1,2})?\b/g

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g

// http/https + domain.tld, plus bare domain.tld with at least one slash or path
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+|(?:www\.)[a-z0-9-]+(?:\.[a-z]{2,}){1,}(?:\/[^\s<>"')]*)?/gi

// Crude org / proper-noun heuristic: 2+ words where each starts uppercase,
// e.g. "Goldman Sachs", "Federal Reserve Bank". Greedy across spaces.
const PROPER_RE = /\b(?:[A-Z][a-z]+(?:\.|,)?\s+){1,3}[A-Z][a-zA-Z]+(?:\s+(?:Ltd|Inc|LLC|Corp|Limited|Bank|Trust|Fund|Capital|Holdings)\.?)?\b/g

// Lowercase stop-phrases that shouldn't be considered orgs even if they
// pattern-match.
const ORG_STOPS = new Set([
  'I Am', 'I Have', 'I Will', 'You Are', 'We Are', 'They Are', 'Thank You',
  'Best Regards', 'Kind Regards', 'Dear Sir', 'Dear Madam',
])

export type Entities = {
  dates?: string[]
  amounts?: string[]
  emails?: string[]
  urls?: string[]
  orgs?: string[]
}

export function extractEntities(text: string): Entities {
  if (!text) return {}
  const slice = text.slice(0, 200_000) // cap; long docs lose later sections
  const out: Required<Entities> = {
    dates: [],
    amounts: [],
    emails: [],
    urls: [],
    orgs: [],
  }
  for (const re of DATE_PATTERNS) {
    for (const m of slice.matchAll(re)) out.dates.push(m[0])
  }
  for (const m of slice.matchAll(AMOUNT_RE)) {
    const s = m[0].trim()
    // Throw out lone numbers like "1.2" or "123" without symbol/word — they're noise.
    if (!/[₹$€£¥]|\b(Rs\.?|INR|USD|EUR|GBP|JPY|CAD|AUD)\b/i.test(s)) continue
    out.amounts.push(s)
  }
  for (const m of slice.matchAll(EMAIL_RE)) out.emails.push(m[0])
  for (const m of slice.matchAll(URL_RE)) out.urls.push(m[0])
  for (const m of slice.matchAll(PROPER_RE)) {
    const s = m[0].trim()
    if (s.length > 60) continue
    if (ORG_STOPS.has(s)) continue
    // Drop "Dear Foo" / "Hello Foo" leads.
    if (/^(Dear|Hi|Hello|Thanks|Thank|Regards|Best|Sincerely)\b/i.test(s)) continue
    out.orgs.push(s)
  }
  return {
    dates: dedupCap(out.dates),
    amounts: dedupCap(out.amounts),
    emails: dedupCap(out.emails.map((e) => e.toLowerCase())),
    urls: dedupCap(out.urls),
    orgs: dedupCap(out.orgs),
  }
}

function dedupCap(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of xs) {
    const k = s.replace(/\s+/g, ' ').trim()
    if (!k || seen.has(k.toLowerCase())) continue
    seen.add(k.toLowerCase())
    out.push(k)
    if (out.length >= CAP) break
  }
  return out
}
