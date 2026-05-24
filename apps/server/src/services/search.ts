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

export function cosine(a: Float32Array, b: Float32Array, normA: number): number {
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

/** Optional filters narrowing the search universe BEFORE scoring.
 *  Layered after the auth/share filter so they never expand access
 *  beyond what the user can already see. */
export type SearchFilters = {
  /** Restrict to docs whose mime starts with any of these (e.g.
   *  ['image/'] for all images, ['application/pdf'] for PDFs only).
   *  Empty array = no mime filter. */
  mime?: string[]
  /** Restrict to docs carrying ALL of these tags (intersection).
   *  Empty array = no tag filter. */
  tags?: string[]
  /** Lower bound on `createdAt` (epoch ms, inclusive). */
  after?: number
  /** Upper bound on `createdAt` (epoch ms, inclusive). */
  before?: number
  /** Restrict to docs whose storageKey is at or under this folder.
   *  Empty string / unset = no folder scope. */
  folder?: string
}

export async function searchKnowledge(opts: {
  q: string
  user: { username: string; role: string }
  limit?: number
  /** Optional filters applied AFTER the ACL filter — never widens
   *  access, only narrows. */
  filters?: SearchFilters
}): Promise<SearchHit[]> {
  const q = opts.q.trim()
  if (!q) return []
  const limit = opts.limit ?? 20
  const f = opts.filters
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
  let allowed = c.docs.filter(
    (d) =>
      userCanRead(d, opts.user.username, opts.user.role) ||
      shareAllows(d) ||
      collectionAllows(d),
  )
  if (f) {
    // Mime prefix match: any of the supplied prefixes match.
    if (f.mime && f.mime.length > 0) {
      allowed = allowed.filter((d) =>
        f.mime!.some((p) => (d.mime || '').toLowerCase().startsWith(p.toLowerCase())),
      )
    }
    // Tag AND (must contain every requested tag).
    if (f.tags && f.tags.length > 0) {
      const want = f.tags.map((t) => t.toLowerCase())
      allowed = allowed.filter((d) => {
        const have = new Set((d.tags ?? []).map((t) => t.toLowerCase()))
        return want.every((t) => have.has(t))
      })
    }
    if (typeof f.after === 'number') {
      allowed = allowed.filter((d) => (d.createdAt ?? 0) >= f.after!)
    }
    if (typeof f.before === 'number') {
      allowed = allowed.filter((d) => (d.createdAt ?? 0) <= f.before!)
    }
    if (f.folder && f.folder.length > 0) {
      const fold = f.folder.replace(/^\/+|\/+$/g, '')
      if (fold) {
        const prefix = fold + '/'
        allowed = allowed.filter(
          (d) => d.storageKey === fold || d.storageKey.startsWith(prefix),
        )
      }
    }
  }
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

/**
 * Find documents similar to `docId` by averaging the source doc's
 * chunk embeddings into a single centroid and cosine-scoring it
 * against every other (allowed) doc's chunks. The result is a
 * ranked list of distinct docs — the source doc itself is always
 * excluded. Returns [] if the source has no embeddings yet, or
 * if the user has no read access to it.
 */
export async function findSimilarDocs(opts: {
  docId: string
  /** Optional storage-key fallback. When the supplied docId doesn't
   *  resolve (e.g. the viewer is holding an id that was reaped by
   *  a re-ingest and the file now lives under a new id), we look up
   *  by `owner=caller + storageKey=pathHint` so the popover still
   *  works without the user having to refresh. */
  pathHint?: string
  user: { username: string; role: string }
  limit?: number
}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10
  const c = await getCache()
  let source = c.docs.find((d) => d.id === opts.docId)
  if (!source && opts.pathHint) {
    const key = opts.pathHint.replace(/^\/+|\/+$/g, '')
    source = c.docs.find((d) => d.storageKey === key && d.owner === opts.user.username)
  }
  if (!source) {
    throw Object.assign(new Error('source document not found'), { status: 404 })
  }
  // ACL: caller must have read access to the source, otherwise we
  // leak similar-doc relationships to a user who can't see the
  // anchor. Mirrors the access gate the regular search applies.
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
  const canRead = (d: typeof source): boolean =>
    userCanRead(d, opts.user.username, opts.user.role) ||
    shareAllows(d) ||
    collectionAllows(d)
  if (!canRead(source)) {
    throw Object.assign(new Error('forbidden'), { status: 403 })
  }

  // Pull source doc's chunk embeddings and average them into a
  // centroid. Skipping a doc with no embeddings yet returns an
  // empty list rather than failing — the caller can show a "still
  // indexing" message instead of an error.
  const sourceChunks: Float32Array[] = []
  for (const ch of streamEmbeddedChunks(new Set([opts.docId]))) {
    sourceChunks.push(ch.embedding)
  }
  if (sourceChunks.length === 0) return []
  const dim = sourceChunks[0].length
  const centroid = new Float32Array(dim)
  for (const v of sourceChunks) {
    for (let i = 0; i < dim; i++) centroid[i] += v[i]
  }
  for (let i = 0; i < dim; i++) centroid[i] /= sourceChunks.length
  let cnorm = 0
  for (let i = 0; i < dim; i++) cnorm += centroid[i] * centroid[i]
  cnorm = Math.sqrt(cnorm)
  if (cnorm === 0) return []

  // Score every other allowed doc by best-chunk cosine against the
  // source centroid. Best-chunk (rather than avg) avoids penalizing
  // a long doc that has one perfectly-matching section.
  const allowed = c.docs.filter((d) => d.id !== opts.docId && canRead(d))
  const allowedIds = new Set(allowed.map((d) => d.id))
  const titleById = new Map(allowed.map((d) => [d.id, d.title]))
  const pathById = new Map(allowed.map((d) => [d.id, d.storageKey]))
  const ownerById = new Map(allowed.map((d) => [d.id, d.owner]))
  const bestByDoc = new Map<string, { score: number; sample: string; chunkIdx: number }>()
  for (const ch of streamEmbeddedChunks(allowedIds)) {
    const cs = cosine(ch.embedding, centroid, ch.norm)
    if (cs < 0.5) continue // floor noise out
    const cur = bestByDoc.get(ch.docId)
    if (!cur || cs > cur.score) {
      bestByDoc.set(ch.docId, { score: cs, sample: ch.text.slice(0, 280), chunkIdx: ch.idx })
    }
  }
  const out: SearchHit[] = []
  for (const [docId, best] of bestByDoc) {
    out.push({
      docId,
      title: titleById.get(docId) ?? '',
      path: pathById.get(docId) ?? '',
      owner: ownerById.get(docId) ?? '',
      score: best.score,
      scores: { lexical: 0, semantic: best.score, metadata: 0, image: 0 },
      snippet: best.sample,
      chunkIdx: best.chunkIdx,
      source: 'semantic',
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}
