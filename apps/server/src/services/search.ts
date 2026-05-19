/**
 * Hybrid search: lexical (substring scoring over text.txt) + vector cosine
 * over chunk embeddings, fused with Reciprocal Rank Fusion.
 *
 * Both indices live in-memory and are invalidated on ingest.
 */
import { listAllDocuments, readText, readClipEmbedding } from '../stores/documents.js'
import { embedBatch, EmbedError } from './embed.js'
import { userCanRead } from '../stores/documents.js'
import { embedQuery as clipEmbedQuery, isClipEnabled } from './clipEmbed.js'
import { streamEmbeddedChunks } from '../db/chunksRepo.js'
import type { DocumentMeta } from '../types.js'

/**
 * Per-doc-meta + full-text cache.
 *
 * Previously this also held every chunk's embedding in a flat
 * Float32Array — at 100K chunks × 768-dim × 4 bytes that's ~3 GB
 * resident. Chunks now stream from SQLite per-query via
 * `streamEmbeddedChunks`, so the cache stays small and only holds
 * the per-doc text + the optional CLIP image vectors.
 */
type Cache = {
  builtAt: number
  docs: DocumentMeta[]
  fullTexts: Map<string, string>
  /** Per-doc CLIP image embedding (L2-normalized 512-dim). Only
   *  populated when CLIP is enabled and the doc had a clip.json
   *  sidecar from ingest. Empty map when CLIP is off — keeps the
   *  caller branch-free. */
  clipByDoc: Map<string, number[]>
}

let cache: Cache | null = null
let building: Promise<Cache> | null = null

export function invalidateSearchCache(): void {
  cache = null
}

async function build(): Promise<Cache> {
  const docs = await listAllDocuments()
  const fullTexts = new Map<string, string>()
  const clipByDoc = new Map<string, number[]>()
  const clipOn = isClipEnabled()
  for (const d of docs) {
    const txt = await readText(d.id)
    if (txt) fullTexts.set(d.id, txt)
    if (clipOn) {
      const vec = await readClipEmbedding(d.id)
      if (vec && vec.length) clipByDoc.set(d.id, vec)
    }
  }
  return { builtAt: Date.now(), docs, fullTexts, clipByDoc }
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
  /** Owner of the file. Lets the client thread `?owner=` through
   *  navigation when a hit comes from a shared subtree. */
  owner: string
  score: number
  /** Per-source contributions to the fused score. Helps clients (and
   *  agents reasoning over results) understand *why* something ranked
   *  where it did — e.g. "ranked high because both the chunk text
   *  AND the title matched". All components are RRF terms
   *  (1/(k+rank)); they sum to `score`. `image` is the CLIP image-
   *  text match score (always 0 when CLIP is disabled). */
  scores?: { lexical: number; semantic: number; metadata: number; image: number }
  snippet: string
  page?: number
  chunkIdx?: number
  source: 'lexical' | 'semantic' | 'hybrid' | 'image'
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
  // Pull share-grants so chunks/files inside a shared subtree also
  // surface in semantic search results.
  const { listSharesTo } = await import('../stores/userShares.js')
  const { grantsForUser } = await import('../db/collectionsRepo.js')
  const sharesIn = await listSharesTo(opts.user.username)
  const collectionGrants = grantsForUser(opts.user.username)
  const shareAllows = (d: { owner: string; storageKey: string }): boolean => {
    if (d.owner === opts.user.username) return false
    const target = d.storageKey.replace(/^\/+|\/+$/g, '')
    for (const s of sharesIn) {
      if (s.owner !== d.owner) continue
      const sk = s.storageKey.replace(/^\/+|\/+$/g, '')
      if (s.isFolder) {
        if (sk === '' || target === sk || target.startsWith(sk + '/')) return true
      } else if (target === sk) return true
    }
    return false
  }
  const collectionAllows = (d: { id: string }): boolean =>
    collectionGrants.readableDocs.has(d.id)
  const allowed = c.docs.filter(
    (d) =>
      userCanRead(d, opts.user.username, opts.user.role) ||
      shareAllows(d) ||
      collectionAllows(d),
  )
  const allowedIds = new Set(allowed.map((d) => d.id))
  const titleById = new Map(allowed.map((d) => [d.id, d.title]))
  const pathById = new Map(allowed.map((d) => [d.id, d.storageKey]))
  const ownerById = new Map(allowed.map((d) => [d.id, d.owner]))

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

  // Metadata-only matches: hits against filename/title and tags. These never
  // produce body snippets, but they're strong signals (a user typing "receipt"
  // wants files tagged or titled that way even if the chunks don't mention
  // the word). The scoring is intentionally simple — exact tag hit > prefix
  // tag hit > title substring — and the resulting docId set joins the RRF
  // fuse below.
  const qLower = q.toLowerCase()
  const meta: Array<{ docId: string; score: number; sample: string }> = []
  for (const d of allowed) {
    let s = 0
    let sample = ''
    const title = (d.title || '').toLowerCase()
    if (title === qLower) s += 4
    else if (title.includes(qLower)) s += 2
    const tags = d.tags ?? []
    for (const t of tags) {
      if (t === qLower) s += 5
      else if (t.startsWith(qLower)) s += 3
      else if (qLower.length >= 3 && t.includes(qLower)) s += 1.5
    }
    if (s > 0) {
      if (tags.length) sample = `Tags: ${tags.map((t) => `#${t}`).join(' ')}`
      else sample = d.title || ''
      meta.push({ docId: d.id, score: s, sample })
    }
  }
  meta.sort((a, b) => b.score - a.score)

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
      // Stream embedded chunks straight from SQLite for the allowed
      // doc set. No more in-memory cache of every chunk's embedding —
      // the row scan is bounded by allowedIds and the partial index
      // skips chunks that never embedded.
      for (const ch of streamEmbeddedChunks(allowedIds)) {
        const cs = cosine(ch.embedding, qf, ch.norm)
        if (cs < SEM_MIN_COSINE) continue
        // If the chunk shares no token with the query, demand a much higher
        // cosine before we believe it.
        if (queryTokens.length > 0 && cs < SEM_HIGH_COSINE) {
          const chunkLower = ch.text.toLowerCase()
          const overlaps = queryTokens.some((t) => chunkLower.includes(t))
          if (!overlaps) continue
        }
        sem.push({
          docId: ch.docId,
          chunkIdx: ch.idx,
          score: cs * (qnorm || 1),
          sample: ch.text.slice(0, 280),
        })
      }
      sem.sort((a, b) => b.score - a.score)
      sem = sem.slice(0, limit * 4)
    }
  } catch (e) {
    if (!(e instanceof EmbedError)) throw e
    // Embedding service down — fall back to lexical only.
  }

  // CLIP image search: cosine-match the query (embedded into CLIP's
  // shared text/image space) against every per-doc image embedding.
  // Same SEM_MIN floor idea as the chunk semantic search — CLIP
  // cosines for true matches sit ~0.25–0.40 on Xenova/clip-vit-base
  // with normalized vectors; anything under 0.20 is noise.
  const IMG_MIN_COSINE = 0.2
  let img: Array<{ docId: string; score: number; sample: string }> = []
  if (isClipEnabled() && c.clipByDoc.size > 0) {
    try {
      const qvec = await clipEmbedQuery(q)
      if (qvec && qvec.length) {
        for (const d of allowed) {
          const vec = c.clipByDoc.get(d.id)
          if (!vec || vec.length !== qvec.length) continue
          let dot = 0
          for (let i = 0; i < qvec.length; i++) dot += qvec[i] * vec[i]
          // Both inputs are L2-normalized at write time, so dot ===
          // cosine. No re-normalization here.
          if (dot < IMG_MIN_COSINE) continue
          img.push({ docId: d.id, score: dot, sample: d.title || d.originalFilename || '' })
        }
        img.sort((a, b) => b.score - a.score)
        img = img.slice(0, limit * 4)
      }
    } catch {
      // CLIP failure shouldn't sink the whole query — silently drop
      // the image source and let lexical+semantic continue.
    }
  }

  // RRF fuse (k=60). Group by docId; within a doc, prefer the best
  // chunk snippet. We track per-source contributions separately so the
  // hit can expose a `scores` breakdown — useful for clients debugging
  // "why did this rank where it did".
  const k = 60
  type Fused = {
    sample: string
    chunkIdx?: number
    lexical: number
    semantic: number
    metadata: number
    image: number
  }
  const fused = new Map<string, Fused>()
  const init = (sample: string, chunkIdx?: number): Fused => ({
    sample, chunkIdx, lexical: 0, semantic: 0, metadata: 0, image: 0,
  })
  lex.forEach((h, i) => {
    const cur = fused.get(h.docId) ?? init(h.sample)
    cur.lexical += 1 / (k + i + 1)
    fused.set(h.docId, cur)
  })
  sem.forEach((h, i) => {
    const cur = fused.get(h.docId) ?? init(h.sample, h.chunkIdx)
    cur.semantic += 1 / (k + i + 1)
    if (!cur.chunkIdx) cur.chunkIdx = h.chunkIdx
    fused.set(h.docId, cur)
  })
  meta.forEach((h, i) => {
    const cur = fused.get(h.docId) ?? init(h.sample)
    cur.metadata += 1 / (k + i + 1)
    fused.set(h.docId, cur)
  })
  img.forEach((h, i) => {
    const cur = fused.get(h.docId) ?? init(h.sample)
    cur.image += 1 / (k + i + 1)
    fused.set(h.docId, cur)
  })

  const lexIds = new Set(lex.map((h) => h.docId))
  const semIds = new Set(sem.map((h) => h.docId))
  const imgIds = new Set(img.map((h) => h.docId))
  const out: SearchHit[] = []
  for (const [docId, hit] of fused) {
    const total = hit.lexical + hit.semantic + hit.metadata + hit.image
    // Source label: 'hybrid' when both text-based sources fire;
    // 'image' when the doc is purely a CLIP hit (no text match); else
    // whichever single text source matched. We don't add an 'all'
    // bucket — UX-wise 'hybrid' already signals "strong evidence".
    const inText = lexIds.has(docId) || semIds.has(docId)
    const inImg = imgIds.has(docId)
    let source: SearchHit['source']
    if (inText && lexIds.has(docId) && semIds.has(docId)) source = 'hybrid'
    else if (semIds.has(docId)) source = 'semantic'
    else if (lexIds.has(docId)) source = 'lexical'
    else if (inImg) source = 'image'
    else source = 'lexical'
    out.push({
      docId,
      path: pathById.get(docId) ?? '',
      title: titleById.get(docId) ?? docId,
      owner: ownerById.get(docId) ?? opts.user.username,
      score: total,
      scores: {
        lexical: Number(hit.lexical.toFixed(6)),
        semantic: Number(hit.semantic.toFixed(6)),
        metadata: Number(hit.metadata.toFixed(6)),
        image: Number(hit.image.toFixed(6)),
      },
      snippet: hit.sample,
      chunkIdx: hit.chunkIdx,
      source,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

export async function preheat(): Promise<void> {
  await getCache().catch(() => null)
}
