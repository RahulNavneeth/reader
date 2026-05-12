/**
 * Hybrid search: lexical (substring scoring over text.txt) + vector cosine
 * over chunk embeddings, fused with Reciprocal Rank Fusion.
 *
 * Both indices live in-memory and are invalidated on ingest.
 */
import { listAllDocuments, streamChunks, readText } from '../stores/documents.js'
import { embedBatch, EmbedError } from './embed.js'
import { userCanRead } from '../stores/documents.js'
import type { DocumentMeta } from '../types.js'

type IndexedChunk = {
  docId: string
  idx: number
  text: string
  embedding: Float32Array | null
  norm: number
}

type Cache = {
  builtAt: number
  docs: DocumentMeta[]
  chunks: IndexedChunk[]
  fullTexts: Map<string, string>
}

let cache: Cache | null = null
let building: Promise<Cache> | null = null

export function invalidateSearchCache(): void {
  cache = null
}

async function build(): Promise<Cache> {
  const docs = await listAllDocuments()
  const chunks: IndexedChunk[] = []
  const fullTexts = new Map<string, string>()
  for (const d of docs) {
    const txt = await readText(d.id)
    if (txt) fullTexts.set(d.id, txt)
    if (!d.ingest.embedded) continue
    for await (const c of streamChunks(d.id)) {
      const emb = c.embedding && c.embedding.length > 0 ? Float32Array.from(c.embedding) : null
      const norm = emb ? Math.hypot(...Array.from(emb)) : 0
      chunks.push({ docId: d.id, idx: c.idx, text: c.text, embedding: emb, norm })
    }
  }
  return { builtAt: Date.now(), docs, chunks, fullTexts }
}

async function getCache(): Promise<Cache> {
  if (cache) return cache
  if (!building) building = build().then((c) => (cache = c))
  return building.then((c) => (building = null, c))
}

function cosine(a: Float32Array, b: Float32Array, normA: number): number {
  if (a.length !== b.length || normA === 0) return 0
  let dot = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    nb += b[i] * b[i]
  }
  const denom = normA * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

function countHits(haystackLower: string, term: string): number {
  if (!term) return 0
  let count = 0
  let from = 0
  while (true) {
    const i = haystackLower.indexOf(term, from)
    if (i < 0) break
    count++
    from = i + term.length
    if (count > 200) break
  }
  return count
}

/**
 * Multi-term lexical score:
 *  - Drops results with low term coverage (a 4-token query needs ≥2 hits
 *    unless the full phrase appears verbatim).
 *  - Scores by coverage² × normalized frequency, so a doc that hits 1/4 tokens
 *    can't outrank one that hits 3/4 just by repeating that single word.
 *  - Big phrase bonus when the exact query appears.
 */
const MIN_COVERAGE = 0.5

function lexicalScore(text: string, q: string): { score: number; firstHitAt: number } {
  if (!q) return { score: 0, firstHitAt: -1 }
  const lower = text.toLowerCase()
  const tokens = tokenize(q)
  if (tokens.length === 0) return { score: 0, firstHitAt: -1 }

  let total = 0
  let distinctHit = 0
  let firstHit = -1
  for (const t of tokens) {
    const c = countHits(lower, t)
    if (c > 0) {
      total += c
      distinctHit++
      const at = lower.indexOf(t)
      if (firstHit < 0 || at < firstHit) firstHit = at
    }
  }
  if (total === 0) return { score: 0, firstHitAt: -1 }

  const phrase = q.trim().toLowerCase()
  const phraseHit = phrase.length > 0 && lower.includes(phrase)
  const coverage = distinctHit / tokens.length // 0..1

  // Multi-token queries need real coverage to count — otherwise a doc with
  // one frequent token (e.g. "india") matches any query containing it.
  if (tokens.length > 1 && coverage < MIN_COVERAGE && !phraseHit) {
    return { score: 0, firstHitAt: -1 }
  }

  const phraseBonus = phraseHit ? 5 : 0
  const lenNorm = total / Math.max(1, text.length / 1000)
  return { score: lenNorm * coverage * coverage + phraseBonus, firstHitAt: firstHit }
}

export type SearchHit = {
  docId: string
  /** vault-relative path — clients navigate here */
  path: string
  title: string
  score: number
  snippet: string
  page?: number
  chunkIdx?: number
  source: 'lexical' | 'semantic' | 'hybrid'
}

export async function searchKnowledge(opts: {
  q: string
  user: { username: string; role: string }
  limit?: number
}): Promise<SearchHit[]> {
  const q = opts.q.trim()
  if (!q) return []
  const limit = opts.limit ?? 20
  const c = await getCache()
  const allowed = c.docs.filter((d) => userCanRead(d, opts.user.username, opts.user.role))
  const allowedIds = new Set(allowed.map((d) => d.id))
  const titleById = new Map(allowed.map((d) => [d.id, d.title]))
  const pathById = new Map(allowed.map((d) => [d.id, d.storageKey]))

  // Lexical: per-doc token-level scoring with snippet around first hit.
  const lex: Array<{ docId: string; score: number; sample: string }> = []
  for (const d of allowed) {
    const text = c.fullTexts.get(d.id)
    if (!text) continue
    const { score, firstHitAt } = lexicalScore(text, q)
    if (score <= 0) continue
    const start = Math.max(0, firstHitAt - 100)
    const end = Math.min(text.length, firstHitAt + 280)
    lex.push({ docId: d.id, score, sample: text.slice(start, end) })
  }
  lex.sort((a, b) => b.score - a.score)

  // Semantic: embed query, score each chunk, take top-k.
  //
  // Two thresholds: a hard floor (anything below is noise on nomic-embed-text)
  // and a higher "trust me without lexical backup" bar. Pure-semantic results
  // that share no token with the query are required to clear the higher bar.
  // With proper nomic prefixes ("search_query:"/"search_document:") true
  // matches typically land at 0.65–0.85; loose noise stays under ~0.55.
  const SEM_MIN_COSINE = 0.55
  const SEM_HIGH_COSINE = 0.7
  const queryTokens = tokenize(q)
  let sem: Array<{ docId: string; chunkIdx: number; score: number; sample: string }> = []
  try {
    const [qvec] = await embedBatch([q], 'query')
    if (qvec && qvec.length) {
      const qf = Float32Array.from(qvec)
      const qnorm = Math.hypot(...Array.from(qf))
      for (const ch of c.chunks) {
        if (!ch.embedding || !allowedIds.has(ch.docId)) continue
        const cs = cosine(ch.embedding, qf, ch.norm)
        if (cs < SEM_MIN_COSINE) continue
        // If the chunk shares no token with the query, demand a much higher
        // cosine before we believe it.
        if (queryTokens.length > 0 && cs < SEM_HIGH_COSINE) {
          const chunkLower = ch.text.toLowerCase()
          const overlaps = queryTokens.some((t) => chunkLower.includes(t))
          if (!overlaps) continue
        }
        sem.push({ docId: ch.docId, chunkIdx: ch.idx, score: cs * (qnorm || 1), sample: ch.text.slice(0, 280) })
      }
      sem.sort((a, b) => b.score - a.score)
      sem = sem.slice(0, limit * 4)
    }
  } catch (e) {
    if (!(e instanceof EmbedError)) throw e
    // Embedding service down — fall back to lexical only.
  }

  // RRF fuse (k=60). Group by docId; within a doc, prefer the best chunk snippet.
  const k = 60
  const fused = new Map<string, { score: number; sample: string; chunkIdx?: number }>()
  lex.forEach((h, i) => {
    fused.set(h.docId, { score: 1 / (k + i + 1), sample: h.sample })
  })
  sem.forEach((h, i) => {
    const cur = fused.get(h.docId)
    const add = 1 / (k + i + 1)
    if (cur) fused.set(h.docId, { score: cur.score + add, sample: h.sample, chunkIdx: h.chunkIdx })
    else fused.set(h.docId, { score: add, sample: h.sample, chunkIdx: h.chunkIdx })
  })

  const lexIds = new Set(lex.map((h) => h.docId))
  const semIds = new Set(sem.map((h) => h.docId))
  const out: SearchHit[] = []
  for (const [docId, hit] of fused) {
    out.push({
      docId,
      path: pathById.get(docId) ?? '',
      title: titleById.get(docId) ?? docId,
      score: hit.score,
      snippet: hit.sample,
      chunkIdx: hit.chunkIdx,
      source: lexIds.has(docId) && semIds.has(docId) ? 'hybrid' : semIds.has(docId) ? 'semantic' : 'lexical',
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

export async function preheat(): Promise<void> {
  await getCache().catch(() => null)
}
