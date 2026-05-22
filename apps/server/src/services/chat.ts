/**
 * Per-document AI chat against a locally-hosted Ollama instance.
 *
 * Pipeline:
 *   1. Caller hands us a docId + user query + recent thread history.
 *   2. We pull the doc's text (truncated to a budget) and run a
 *      semantic search across the user's vault for related chunks.
 *   3. Compose a system prompt that pins the model to the supplied
 *      context and exposes the citations.
 *   4. Stream `/api/chat` from Ollama, yielding {token} events as
 *      they arrive plus a final {done, citations} event so the route
 *      can persist the full reply.
 *
 * No Anthropic / OpenAI path here — chosen during design. Swapping
 * providers is one function: implement another `streamFromOllama`
 * twin and pick by config.
 */
import path from 'node:path'
import { config } from '../config.js'
import { embedBatch, EmbedError } from './embed.js'
import { streamEmbeddedChunks } from '../db/chunksRepo.js'
import { loadMeta, readText, userCanRead, listAllDocuments } from '../stores/documents.js'
import { outline, getSection, type SectionRef } from '../lib/mdx.js'
import {
  listAllUserMemoriesForRetrieval,
  listUserMemoriesByPopularity,
  listDocMemories,
  listRecentErrorNotes,
  incrementUserMemoryUsage,
  type UserMemory,
  type DocMemory,
  type ChatErrorNote,
} from '../db/memoriesRepo.js'
import type { ChatCitation, ChatMessage, ProposedEditOp } from '../db/chatRepo.js'
import type { DocumentMeta } from '../types.js'

export class ChatError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
  }
}

/** Budget per turn — keeps the prompt comfortably under the
 *  context window of mid-sized local models (8K-16K). */
const ANCHOR_DOC_CHAR_BUDGET = 12_000
// Cross-doc RAG cap. Was 6 + 0.55 — too generous; the panel always
// showed "6 sources" because the threshold caught marginal chunks.
// 4 tight, high-confidence hits give the model better grounding
// without padding the prompt with weak matches.
const CROSS_DOC_CHUNK_COUNT = 4
const CROSS_DOC_MIN_SCORE = 0.65
// Anchor-doc focused retrieval. When the user asks about a specific
// section/topic of the open doc, we score the doc's own chunks
// against the question and surface the top matches as a "look here
// first" block — small models otherwise summarise the whole doc.
const ANCHOR_FOCUS_CHUNK_COUNT = 4
// Tight cap — at 10 we observed the model's own (occasionally
// hallucinated) prior answers contaminating subsequent turns. At 4
// short-range follow-ups still work ("why?", "explain more") but
// old answers age out before they can leak into questions on a
// new topic. Selection-based questions ("Explain this: …") strip
// history entirely; see buildOllamaMessages.
const HISTORY_MESSAGE_LIMIT = 4
// Memory injection caps — keep the prompt bounded as a user
// accumulates memories. Top-20 by popularity for user facts,
// up to 10 doc facts (since they're scoped narrowly already),
// 3 most-recent error notes (v2 will use similarity).
const USER_MEMORY_INJECT_LIMIT = 20
const DOC_MEMORY_INJECT_LIMIT = 10
const ERROR_NOTE_INJECT_LIMIT = 3

type RagChunk = Required<Pick<ChatCitation, 'docId' | 'chunkIdx' | 'score' | 'docTitle' | 'docPath'>> & {
  text: string
}

type AssembledContext = {
  anchor: DocumentMeta
  /** Doc text to embed in the prompt's <document> block. Empty when
   *  a section match fired (primary_sections carry the relevant
   *  material instead). */
  anchorText: string
  /** Full, un-budgeted doc text — always populated regardless of
   *  whether section match fired. Used by tooling that needs to
   *  look things up in the actual document (heading lookup for
   *  the Reply-flow proposed-edit synthesiser, etc.). NOT included
   *  in the prompt — keep ANCHOR_DOC_CHAR_BUDGET as the cap there. */
  anchorTextFull: string
  /** Top-K chunks from the ANCHOR doc itself, scored against the
   *  query. Surfaced to the model as a "focus here first" block so
   *  a small model doesn't drown in 12K chars of doc text and end
   *  up paraphrasing the whole thing. Empty when embeddings are
   *  unavailable or the doc only has one chunk. */
  focusChunks: RagChunk[]
  /** Cross-doc retrieval results. Empty when Ollama is offline or
   *  the user has no other indexed docs — the anchor doc alone is
   *  still enough for the model to answer about itself. */
  ragChunks: RagChunk[]
  /** True when the focus came from explicit section-name matching
   *  (vs embedding fallback). Triggers a tighter prompt — the
   *  anchorText is suppressed, supporting chunks are capped at 2,
   *  and a starter-phrase rule forces the model to anchor on the
   *  named section. */
  hasSectionMatch: boolean
  /** Top user memories surfaced for this turn (popularity-sorted).
   *  The route bumps used_count on these once the stream succeeds. */
  permanentFacts: UserMemory[]
  /** Per-(doc, user) facts. Newer first. */
  docFacts: DocMemory[]
  /** Recent error-correction notes for the user, surfaced as
   *  <known_mistakes> so the model doesn't repeat past mistakes. */
  knownMistakes: ChatErrorNote[]
}

/**
 * Pull the docs the caller can read, score chunks against the
 * query, and assemble the prompt context. Returns the anchor doc
 * meta + its text + the top cross-doc chunks.
 */
export async function assembleContext(
  docId: string,
  user: { username: string; role: string },
  query: string,
): Promise<AssembledContext> {
  const anchor = await loadMeta(docId)
  if (!anchor) throw new ChatError(`document not found: ${docId}`)
  if (!userCanRead(anchor, user.username, user.role)) {
    throw new ChatError('not allowed to read this document')
  }

  const anchorTextFull = (await readText(docId)) ?? ''

  const sectionMatches = retrieveAnchorSections(query, anchor, anchorTextFull)
  const hasSectionMatch = sectionMatches.length > 0

  // Skip cross-doc vault RAG when the query is a Reply-popover
  // edit (`> "…"` quote + an edit verb). The user clearly wants
  // the rephrase/rewrite to apply to THIS doc; surfacing
  // unrelated vault docs in Sources is noise and the agent
  // doesn't need them to do the edit. The model's @-mention
  // path is still the way to bring in cross-doc context
  // deliberately.
  const skipVaultRag =
    !!extractQuotedExcerpt(query) && detectEditIntent(query)

  let focusChunks: RagChunk[] = []
  let ragChunks: RagChunk[] = []
  try {
    ;[focusChunks, ragChunks] = await Promise.all([
      hasSectionMatch
        ? Promise.resolve(sectionMatches)
        : retrieveAnchorFocus(query, anchor, user),
      skipVaultRag
        ? Promise.resolve([])
        : retrieveRagChunks(query, anchor, user),
    ])
  } catch (e) {
    if (e instanceof EmbedError) {
      // Ollama embed offline → fall back to anchor-only. Logged but
      // not fatal; chat is still useful with just the doc text.
      focusChunks = sectionMatches
      ragChunks = []
    } else {
      throw e
    }
  }

  // When we have a confident section match, drastically shrink the
  // prompt: the matched sections become the entire doc context (no
  // duplicate full-doc body) and supporting chunks are capped at 2.
  // This prevents a small model from drifting into the larger
  // surrounding content. When no section match, fall back to full
  // truncated doc + up to 4 supporting chunks.
  let anchorText: string
  if (hasSectionMatch) {
    anchorText = ''
    // Keep up to 3 supporting chunks — enough for one explicitly
    // named doc (boosted via matchDocsByName) PLUS one or two top
    // cosine hits to sit alongside it. With cap at 2, a named-doc
    // hit would displace the next-best cosine hit; the user
    // expects both ("you named portfolio-target, fine, but I'd
    // also like to see what else came up").
    if (ragChunks.length > 3) ragChunks = ragChunks.slice(0, 3)
  } else {
    anchorText = truncateForBudget(anchorTextFull, ANCHOR_DOC_CHAR_BUDGET)
  }

  // Memory retrieval — cosine-rank against the query so we only
  // inject memories that are actually relevant to what the user
  // just asked. Implicit-preference memories (alwaysInject=true)
  // bypass the threshold so things like "answer in INR" always
  // apply. Falls back to popularity-sort on the rare path where
  // we couldn't embed the query (Ollama down).
  const knownMistakes = listRecentErrorNotes(user.username, ERROR_NOTE_INJECT_LIMIT)
  const allUserMemories = listAllUserMemoriesForRetrieval(user.username)
  const allDocMemories = listDocMemories(anchor.id, user.username)

  // We need a query vector to score memories. Reuse what we
  // already computed via retrieveAnchorFocus when possible — but
  // that ran inside a Promise.all above, so we re-embed here. The
  // memory list is small; one embed call is fine. If the embed
  // backend is offline we fall back to popularity for permanents
  // and recency for doc-scoped memories.
  let queryVec: Float32Array | null = null
  try {
    const [v] = await embedBatch([query], 'query')
    if (v && v.length > 0) queryVec = new Float32Array(v)
  } catch {
    queryVec = null
  }

  const MEMORY_RELEVANCE_THRESHOLD = 0.55
  const permanentFacts = rankMemoriesByRelevance(
    allUserMemories,
    queryVec,
    USER_MEMORY_INJECT_LIMIT,
    MEMORY_RELEVANCE_THRESHOLD,
  )
  const docFacts = rankMemoriesByRelevance(
    allDocMemories,
    queryVec,
    DOC_MEMORY_INJECT_LIMIT,
    MEMORY_RELEVANCE_THRESHOLD,
  )

  // Fallback when the embed backend is offline: keep the legacy
  // popularity-sort for user memories so the prompt isn't
  // memory-blind. Doc memories fall back to most-recent.
  if (queryVec === null && allUserMemories.length > 0 && permanentFacts.length === 0) {
    const fallback = listUserMemoriesByPopularity(user.username, USER_MEMORY_INJECT_LIMIT)
    permanentFacts.push(...fallback)
  }

  if (permanentFacts.length > 0) {
    incrementUserMemoryUsage(permanentFacts.map((m) => m.id))
  }

  return {
    anchor,
    anchorText,
    anchorTextFull,
    focusChunks,
    ragChunks,
    hasSectionMatch,
    permanentFacts,
    docFacts,
    knownMistakes,
  }
}

/** Match query tokens against the anchor doc's heading text. Returns
 *  the matched sections verbatim (entire body until the next sibling
 *  heading) as RagChunk-shaped objects so the prompt builder can
 *  treat them uniformly. Heuristic: tokenize the query, then find
 *  headings whose text shares >=2 non-trivial tokens, or whose text
 *  contains a 2+-word substring from the query.
 *
 *  For non-markdown docs (no ATX headings) this returns []; the
 *  caller falls back to embedding-based chunk focus. */
export function retrieveAnchorSections(
  query: string,
  anchor: DocumentMeta,
  anchorTextFull: string,
): RagChunk[] {
  if (!anchorTextFull) return []
  const sections = outline(anchorTextFull)
  if (sections.length === 0) return []

  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been',
    'about', 'to', 'of', 'in', 'on', 'for', 'how', 'what', 'why', 'when',
    'where', 'which', 'me', 'my', 'i', 'you', 'we', 'it', 'this', 'that',
    'explain', 'tell', 'show', 'tied', 'related', 'connect', 'connection',
  ])
  const tokenize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !stop.has(t))

  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []

  // Phrase normalisation — drop punctuation, collapse whitespace,
  // lowercase. Used for the substring check below.
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const queryLower = norm(query)
  const queryWords = queryLower.split(' ').filter((w) => w.length > 0)

  // Score each heading by (a) tokenized overlap and (b) phrase
  // substring match. Phrase matching catches single-letter section
  // identifiers — "scenario b" appears verbatim in heading
  // "scenario b — 15% step-up sips" even though "b" is too short
  // to survive the token filter.
  type Hit = { section: SectionRef; score: number }
  const hits: Hit[] = []
  for (const s of sections) {
    const hTokens = tokenize(s.heading)
    let overlap = 0
    for (const ht of hTokens) {
      if (qTokens.includes(ht)) overlap++
    }

    const headingLower = norm(s.heading)
    let phraseScore = 0
    // Walk 3- then 2-word slices of the query; longest match wins.
    // Each phrase must be at least 3 chars overall to avoid noise
    // like "of a" matching trivially.
    for (let len = 3; len >= 2; len--) {
      let matched = false
      for (let i = 0; i <= queryWords.length - len; i++) {
        const phrase = queryWords.slice(i, i + len).join(' ')
        if (phrase.length >= 3 && headingLower.includes(phrase)) {
          phraseScore = Math.max(phraseScore, len * 2)
          matched = true
          break
        }
      }
      if (matched) break
    }

    const score = overlap + phraseScore
    if (score >= 2) hits.push({ section: s, score })
  }
  if (hits.length === 0) return []

  hits.sort((a, b) => b.score - a.score)
  // Cap at 3 sections so we don't flood the prompt with the whole
  // doc when the user asks a broad question.
  const chosen = hits.slice(0, 3)
  return chosen.map(({ section, score }) => {
    const body = getSection(anchorTextFull, section.heading) ?? ''
    const headingLine = '#'.repeat(section.level) + ' ' + section.heading
    // Tables inside the section body — small models ignore
    // pipe-delimited markdown but read prose lists reliably. We
    // append a flattened version of each table right after the
    // original.
    const bodyWithFlatTables = flattenMarkdownTables(body)
    return {
      docId: anchor.id,
      chunkIdx: section.startLine,
      score: Math.round((score / Math.max(1, qTokens.length)) * 10000) / 10000,
      text: `${headingLine}\n${bodyWithFlatTables}`,
      docTitle: anchor.title,
      docPath: anchor.storageKey,
    }
  })
}

/**
/**
 * Cosine-rank memories against the user's query and return the
 * top N that exceed the threshold, plus any memory flagged
 * alwaysInject (those bypass the threshold).
 *
 *   • If queryVec is null (embed backend offline), the function
 *     returns ONLY the alwaysInject set — callers should fall
 *     back to popularity for user memories so the prompt isn't
 *     memory-blind.
 *   • A memory without its own embedding cannot be scored against
 *     the query, so it only survives via alwaysInject.
 *
 * The returned array preserves the order: alwaysInject first,
 * then by cosine descending.
 */
export function rankMemoriesByRelevance<
  T extends { id: string; embedding: Float32Array | null; alwaysInject: boolean },
>(
  memories: T[],
  queryVec: Float32Array | null,
  limit: number,
  threshold: number,
): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  // alwaysInject memories first — they're implicit-preference rules
  // that should always apply, regardless of how the query reads.
  for (const m of memories) {
    if (!m.alwaysInject) continue
    out.push(m)
    seen.add(m.id)
    if (out.length >= limit) return out
  }
  if (!queryVec) return out

  // Pre-compute the query's norm so each cosine is one dot product.
  let qNormSq = 0
  for (let i = 0; i < queryVec.length; i++) qNormSq += queryVec[i] * queryVec[i]
  const qNorm = Math.sqrt(qNormSq)
  if (qNorm === 0) return out

  type Scored = { m: T; score: number }
  const scored: Scored[] = []
  for (const m of memories) {
    if (seen.has(m.id)) continue
    if (!m.embedding || m.embedding.length !== queryVec.length) continue
    let dot = 0
    let mNormSq = 0
    for (let i = 0; i < queryVec.length; i++) {
      dot += queryVec[i] * m.embedding[i]
      mNormSq += m.embedding[i] * m.embedding[i]
    }
    const mNorm = Math.sqrt(mNormSq)
    if (mNorm === 0) continue
    const cos = dot / (qNorm * mNorm)
    if (cos < threshold) continue
    scored.push({ m, score: cos })
  }
  scored.sort((a, b) => b.score - a.score)
  for (const { m } of scored) {
    out.push(m)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Score the ANCHOR doc's own chunks against the user's question and
 * return the top N. Lets the prompt highlight "look here first" for
 * section-specific questions like "explain Scenario B".
 */
export async function retrieveAnchorFocus(
  query: string,
  anchor: DocumentMeta,
  user: { username: string; role: string },
): Promise<RagChunk[]> {
  if (!userCanRead(anchor, user.username, user.role)) return []
  const [queryVec] = await embedBatch([query], 'query')
  if (!queryVec || queryVec.length === 0) return []
  const q = new Float32Array(queryVec)
  let qNorm = 0
  for (let i = 0; i < q.length; i++) qNorm += q[i] * q[i]
  qNorm = Math.sqrt(qNorm)
  if (qNorm === 0) return []

  type Hit = { idx: number; text: string; score: number }
  const hits: Hit[] = []
  const allowed = new Set([anchor.id])
  for (const row of streamEmbeddedChunks(allowed)) {
    if (row.embedding.length !== q.length) continue
    let dot = 0
    for (let i = 0; i < q.length; i++) dot += q[i] * row.embedding[i]
    const cos = dot / (qNorm * row.norm)
    hits.push({ idx: row.idx, text: row.text, score: cos })
  }
  hits.sort((a, b) => b.score - a.score)
  // No minimum threshold here — the anchor doc IS the topic by
  // definition. We just want the most relevant slices to bubble up.
  return hits.slice(0, ANCHOR_FOCUS_CHUNK_COUNT).map((h) => ({
    docId: anchor.id,
    chunkIdx: h.idx,
    score: Math.round(h.score * 10000) / 10000,
    text: h.text,
    docTitle: anchor.title,
    docPath: anchor.storageKey,
  }))
}

export async function retrieveRagChunks(
  query: string,
  anchor: DocumentMeta,
  user: { username: string; role: string },
): Promise<RagChunk[]> {
  const allDocs = await listAllDocuments()
  const readable = allDocs.filter((d) => userCanRead(d, user.username, user.role))
  if (readable.length === 0) return []
  const allowed = new Set(readable.map((d) => d.id))

  // Doc-name match: when the user's query literally names a doc
  // (e.g. "tied to the portfolio target" → portfolio-target.md),
  // that doc's chunks get a big retrieval boost. Without this,
  // another doc that merely *mentions* the named doc by filename
  // can win on cosine and the actually-relevant doc falls below
  // the threshold.
  const namedDocIds = matchDocsByName(query, readable, anchor.id)

  const [queryVec] = await embedBatch([query], 'query')
  if (!queryVec || queryVec.length === 0) return []
  const q = new Float32Array(queryVec)
  let qNorm = 0
  for (let i = 0; i < q.length; i++) qNorm += q[i] * q[i]
  qNorm = Math.sqrt(qNorm)
  if (qNorm === 0) return []

  type Hit = { docId: string; idx: number; text: string; score: number }
  const hits: Hit[] = []
  for (const row of streamEmbeddedChunks(allowed)) {
    if (row.embedding.length !== q.length) continue
    let dot = 0
    for (let i = 0; i < q.length; i++) dot += q[i] * row.embedding[i]
    const cos = dot / (qNorm * row.norm)
    // Named-doc chunks bypass the min-score threshold entirely
    // and get a +1 boost so they sort above purely-cosine hits.
    // The user explicitly asked about this doc; don't drop it
    // because some other doc happens to mention its filename.
    const isNamed = namedDocIds.has(row.docId)
    if (!isNamed && cos < CROSS_DOC_MIN_SCORE) continue
    hits.push({
      docId: row.docId,
      idx: row.idx,
      text: row.text,
      score: isNamed ? cos + 1 : cos,
    })
  }
  hits.sort((a, b) => b.score - a.score)

  // Bias away from the anchor doc — the anchor text is already in
  // the prompt verbatim, so handing back chunks from it is just
  // wasted tokens. Keep one or two anchor chunks if they massively
  // outscore everything else (rare), otherwise prefer cross-doc.
  const seen = new Set<string>()
  const byId = new Map(readable.map((d) => [d.id, d]))
  // Per-doc chunk cap. With this on, every doc gets at most one
  // chunk in the supporting set — so a doc with many high-scoring
  // chunks (like portfolio-target.md after its name-boost) can't
  // crowd out other docs (like index.md) that scored a single
  // strong chunk. Diversity beats depth here.
  const perDoc = new Map<string, number>()
  const PER_DOC_CHUNK_LIMIT = 1
  const out: RagChunk[] = []
  for (const h of hits) {
    if (out.length >= CROSS_DOC_CHUNK_COUNT) break
    const key = `${h.docId}:${h.idx}`
    if (seen.has(key)) continue
    seen.add(key)
    if (h.docId === anchor.id && out.length > 0) continue
    const used = perDoc.get(h.docId) ?? 0
    if (used >= PER_DOC_CHUNK_LIMIT) continue
    perDoc.set(h.docId, used + 1)
    const d = byId.get(h.docId)
    // Unboost the score before exposing it — the +1 was just a
    // ranking trick to push named docs to the top; the displayed
    // score should still be the raw cosine.
    const displayScore = namedDocIds.has(h.docId) ? h.score - 1 : h.score
    out.push({
      docId: h.docId,
      chunkIdx: h.idx,
      score: Math.round(displayScore * 10000) / 10000,
      text: h.text,
      docTitle: d?.title ?? '(untitled)',
      docPath: d?.storageKey ?? '',
    })
  }
  return out
}

/** Flatten markdown tables inside a section body into prose
 *  bullets, appended right after the original table. Small models
 *  read prose lists reliably; pipe-delimited tables they often
 *  ignore entirely. The original table is preserved so anything
 *  the model CAN parse remains visible.
 *
 *  Detects the standard GFM shape:
 *      | Header1 | Header2 |
 *      | ---     | ---     |
 *      | cell    | cell    |
 *  Anything else falls through untouched. */
/** Parse `<proposed_edit op="..." heading="...">…</proposed_edit>`
 *  blocks out of the assistant's streamed content. Returns the
 *  list of parsed ops; malformed or unknown-op blocks are silently
 *  skipped so the assistant turn falls through to a normal text
 *  message rather than half-applying.
 *
 *  The block format mirrors our other XML-tagged prompt sections
 *  (<primary_sections>, <rules>) so the model can follow a single
 *  convention. Tagged blocks parse cleanly without bracket-
 *  balancing inside markdown code fences.
 *
 *  Attribute values may be in single or double quotes (qwen
 *  models sometimes alternate). Body content can span multiple
 *  lines and contain markdown including tables. */
export function parseProposedEdits(text: string): ProposedEditOp[] {
  if (!text || !text.includes('<proposed_edit')) return []
  const out: ProposedEditOp[] = []
  // Non-greedy body match across newlines via [\s\S]. We accept
  // either order of attributes, and either quote style.
  const blockRe = /<proposed_edit\s+([^>]*?)>([\s\S]*?)<\/proposed_edit>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(text)) !== null) {
    const attrs = parseAttrs(m[1])
    const body = m[2]
    // Trim a single leading/trailing newline so the body reads
    // cleanly without absorbing the indentation between tags.
    const content = body.replace(/^\n/, '').replace(/\n$/, '')
    const op = (attrs.op ?? '').toLowerCase()
    const heading = attrs.heading

    switch (op) {
      case 'replace_section':
        if (!heading) continue
        out.push({ op: 'replace_section', heading, content })
        break
      case 'insert_after':
        if (!heading) continue
        out.push({ op: 'insert_after', heading, content })
        break
      case 'delete_section':
        if (!heading) continue
        // delete_section ignores body content — the heading
        // alone determines what's dropped.
        out.push({ op: 'delete_section', heading })
        break
      case 'append_text':
        out.push({ op: 'append_text', content })
        break
      case 'prepend_text':
        out.push({ op: 'prepend_text', content })
        break
      default:
        // Unknown op (typo, model confabulation) — skip silently.
        continue
    }
  }
  return out
}

/** Lightweight attribute parser for the proposed_edit opening tag.
 *  Handles single + double quotes; doesn't try to fully parse XML
 *  (no entity decoding, no namespace handling — not needed). */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? ''
  }
  return attrs
}

/** Strip `<proposed_edit>` blocks from the assistant's content
 *  before persistence. The structured edits are stored in the
 *  pending_edit column; the user-visible text shouldn't contain
 *  the raw XML markers (rendered as visible XML in the bubble).
 *  Whitespace around the removed blocks is collapsed so we don't
 *  leave double-blank-line scars. */
/**
 * Strip a trailing echo of the user's instruction from the assistant
 * response. Small models occasionally append the user's directive
 * verbatim (or near-verbatim) as a closing line — e.g. ending with
 * "explain it with simple words." after answering a question.
 *
 * Strategy:
 *   • Tokenise the user's query (lowercased, alphanumerics + stop-
 *     word-stripped).
 *   • Look at the last sentence/line of the assistant response. If
 *     >=70% of its content tokens appear in the query token set
 *     (and it's <= 18 words), treat it as an echo and drop it.
 *   • Repeat once on the resulting tail in case the model echoed
 *     across two lines.
 *
 * Conservative on purpose — we only strip very short, very-similar
 * trailing fragments. Legitimate paraphrases that share fewer tokens
 * survive; long restatements that are actually informative survive.
 */
export function stripInstructionEcho(response: string, query: string): string {
  if (!response || !query) return response
  const queryTokens = tokenizeForEchoMatch(query)
  if (queryTokens.size === 0) return response
  let cur = response
  for (let pass = 0; pass < 2; pass++) {
    const trimmed = cur.replace(/\s+$/, '')
    if (!trimmed) break
    // Find the start of the last "sentence/line" segment. We treat
    // a hard newline OR a sentence terminator (. ! ?) followed by
    // whitespace as a segment boundary.
    let cutAt = -1
    for (let i = trimmed.length - 2; i >= 0; i--) {
      const c = trimmed[i]
      if (c === '\n') {
        cutAt = i + 1
        break
      }
      if ((c === '.' || c === '!' || c === '?') && /\s/.test(trimmed[i + 1] ?? '')) {
        cutAt = i + 1
        // Skip leading whitespace of the next segment.
        while (cutAt < trimmed.length && /\s/.test(trimmed[cutAt])) cutAt++
        break
      }
    }
    if (cutAt < 0) cutAt = 0
    const tail = trimmed.slice(cutAt).trim().replace(/[."!?]+$/g, '').trim()
    if (!tail) break
    const tailTokens = tokenizeForEchoMatch(tail)
    if (tailTokens.size === 0 || tailTokens.size > 18) break
    let overlap = 0
    for (const t of tailTokens) if (queryTokens.has(t)) overlap++
    if (overlap / tailTokens.size < 0.7) break
    cur = trimmed.slice(0, cutAt).replace(/\s+$/, '')
  }
  return cur
}

const ECHO_STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'it', 'its', 'is', 'are', 'was', 'were', 'be',
  'i', 'me', 'my', 'you', 'your', 'we', 'us',
  'and', 'or', 'but', 'if', 'so',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'as', 'from', 'into',
  'do', 'does', 'did',
])

function tokenizeForEchoMatch(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length <= 1) continue
    if (ECHO_STOPWORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

export function stripProposedEditBlocks(text: string): string {
  return text
    .replace(/<proposed_edit\s+[^>]*?>[\s\S]*?<\/proposed_edit>/g, '')
    .replace(/<proposed_edit\s+[^>]*?\/>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract the blockquoted excerpt from a Reply-popover query.
 * Returns null if the query doesn't start with `> "…"`.
 *
 * Reply-popover messages have the shape:
 *   > "<excerpt copied from the doc>"
 *
 *   <user's freeform question>
 */
export function extractQuotedExcerpt(query: string): string | null {
  const m = query.match(/^\s*>\s*"([^]*?)"\s*(?:\n|$)/)
  if (!m) return null
  const excerpt = m[1].trim()
  return excerpt.length > 0 ? excerpt : null
}

/**
 * Locate the ATX heading whose section CONTAINS the quoted excerpt.
 * Returns null if the excerpt can't be found in the document, or if
 * it appears before any heading (top-of-doc preamble).
 *
 * Why this matters:
 *   The model has no reliable way to pick the right heading attribute
 *   on its own — small models guess, hallucinate, or omit the
 *   heading entirely. Computing it server-side from the actual doc
 *   text and passing it as a hint converts an unreliable "find the
 *   heading" task into a "use this heading" instruction the model
 *   can follow.
 */
export function locateHeadingForExcerpt(docText: string, excerpt: string): string | null {
  if (!docText || !excerpt) return null
  // Strip the surrounding `"…"` and normalise whitespace so we can
  // do a tolerant substring match — the excerpt may have been
  // copied with subtly different whitespace than the canonical
  // text.
  const needle = excerpt.replace(/\s+/g, ' ').trim()
  if (!needle) return null
  // Normalise the doc text the same way, but track original line
  // positions so we can map matches back to headings.
  const lines = docText.split('\n')
  const flatLines = lines.map((l) => l.replace(/\s+/g, ' ').trim())
  const flatJoined = flatLines.join('\n')
  const idx = flatJoined.indexOf(needle)
  if (idx < 0) return null
  // Count how many lines precede the match point.
  const beforeMatch = flatJoined.slice(0, idx)
  const matchLineNo = beforeMatch.split('\n').length - 1
  // Walk backward through the original lines from matchLineNo,
  // looking for the nearest ATX heading. Fence-aware: skip lines
  // inside fenced code blocks (heading-shaped lines in code don't
  // count as section markers).
  let inFence = false
  // Tally fence state from line 0 up to matchLineNo so backward
  // scanning has the right `inFence` baseline.
  const fenceAtLine: boolean[] = new Array(lines.length).fill(false)
  let cur = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) cur = !cur
    fenceAtLine[i] = cur
  }
  for (let i = matchLineNo; i >= 0; i--) {
    inFence = fenceAtLine[i]
    if (inFence) continue
    const m = lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (m) return m[2].trim()
  }
  return null
}

/**
 * Heuristic: does the user's message look like an edit request
 * (vs. an explanation / lookup)?
 *
 * Why an explicit heuristic and not "just trust Rule 10":
 *   Small models (0.5b–7b) do not reliably emit structured XML
 *   blocks just because the system prompt asks them to. Their
 *   compliance shoots up when we ALSO front-load an explicit
 *   "<edit_mode required=true>" directive at the top of the
 *   prompt — but only when there's actually edit intent, otherwise
 *   we'd force proposed_edit blocks for pure-explain questions too.
 *
 * Match rules:
 *   - First we strip any leading `>` blockquote (the Reply popover
 *     prepends a quoted excerpt) so verbs in the quote itself don't
 *     count — only the user's freeform question matters.
 *   - Then we look for an edit verb either at the start of the
 *     message ("rephrase this", "rewrite the…") or as a whole word
 *     anywhere in the user-typed portion.
 *
 * Explicitly NOT triggers: "explain", "summarize", "describe",
 * "what does this mean", "how does X work" — pure-read intents.
 */
export function detectEditIntent(query: string): boolean {
  // Strip the leading blockquote that the Reply popover prepends.
  // We only inspect the user's freeform question, not the quoted
  // excerpt — otherwise an excerpt that happens to contain "add"
  // or "remove" would falsely trigger edit mode.
  const userPart = query.replace(/^\s*>\s*"[^]*?"\s*\n*/m, '').trim()
  if (!userPart) return false
  const editVerbs = [
    'rephrase', 'reword', 'rewrite', 'rewrtie', 'rewite',
    'edit', 'modify', 'change', 'update', 'revise',
    'fix', 'correct', 'improve', 'polish', 'clean up', 'tighten',
    'shorten', 'condense', 'trim', 'cut',
    'expand', 'elaborate on this in the doc', 'flesh out',
    'add', 'append', 'prepend', 'insert',
    'remove', 'delete', 'drop', 'strip', 'get rid of',
    'replace',
    'make this', 'make it',
    'turn this into', 'convert this to',
  ]
  const lower = userPart.toLowerCase()
  return editVerbs.some((verb) => {
    // Match as a whole word (or phrase) — `\b` handles word
    // boundaries for single tokens; multi-word phrases match as-is.
    if (verb.includes(' ')) return lower.includes(verb)
    const re = new RegExp(`\\b${verb}\\b`, 'i')
    return re.test(lower)
  })
}

/** Generate a one-line hint telling the model what kind of source
 *  the document body came from. Small models otherwise treat OCR'd
 *  image text, extracted PDF text, transcripts, and markdown all
 *  the same — leading to "this document describes a list of
 *  sections" type confabulations on a log screenshot.
 *
 *  Returns null for markdown / plain text where no hint is needed
 *  (the model's default assumption is text-like). */
export function formatSourceHint(meta: DocumentMeta): string | null {
  const mime = (meta.mime || '').toLowerCase()
  const ext = (path.extname(meta.originalFilename || '') || '').toLowerCase()

  if (mime.startsWith('image/')) {
    return `This document is an image file (${ext || mime}). The text below was extracted from the image via OCR — it may contain fragmentary text, broken line wraps from the original layout, and stray characters. Treat lines as best-effort transcription. Describe what the image shows, not its file format.`
  }
  if (mime === 'application/pdf' || ext === '.pdf') {
    return `This document is a PDF. The text below is extracted from the PDF — page layout (columns, tables, headers/footers) has been flattened into a single text stream, so content from adjacent regions may interleave.`
  }
  if (mime.startsWith('video/')) {
    return `This document is a video file. The text below is a transcript of the spoken audio.`
  }
  if (mime.startsWith('audio/')) {
    return `This document is an audio file. The text below is a transcript of the audio.`
  }
  if (ext === '.csv' || ext === '.tsv' || mime === 'text/csv' || mime === 'text/tab-separated-values') {
    return `This document is a ${ext === '.tsv' ? 'TSV' : 'CSV'} file. The text below is rows of cells; the first row is typically the header.`
  }
  if (
    ext === '.xlsx' || ext === '.xls' ||
    mime.includes('spreadsheet') || mime.includes('excel')
  ) {
    return `This document is a spreadsheet. The text below is cell values extracted from one or more sheets, flattened into text — content from different sheets may run together without clear boundaries.`
  }
  if (ext === '.json' || mime === 'application/json') {
    return `This document is JSON. The text below is the JSON content; key/value structure matters.`
  }
  if (ext === '.docx' || mime.includes('wordprocessingml') || mime.includes('msword')) {
    return `This document is a Word document. The text below is extracted prose — basic paragraph structure preserved, formatting flattened.`
  }
  if (mime.startsWith('text/html') || ext === '.html' || ext === '.htm') {
    return `This document is HTML. The text below is the rendered text content — tags stripped, structure preserved as best-effort paragraphs.`
  }
  // Markdown, plain text, code files — no hint; the body speaks for itself.
  return null
}

export function flattenMarkdownTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  const isRow = (s: string): boolean => /^\s*\|.*\|\s*$/.test(s)
  const isSeparator = (s: string): boolean => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(s)
  const splitCells = (s: string): string[] =>
    s
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())

  let i = 0
  while (i < lines.length) {
    const headerLine = lines[i]
    const sepLine = lines[i + 1]
    if (isRow(headerLine) && sepLine != null && isSeparator(sepLine)) {
      const headers = splitCells(headerLine)
      // Collect data rows.
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && isRow(lines[j])) {
        rows.push(splitCells(lines[j]))
        j++
      }
      // Emit the original markdown verbatim so any model that DOES
      // grok tables sees them, then append a flattened prose
      // version for the models that don't.
      for (let k = i; k < j; k++) out.push(lines[k])
      if (rows.length > 0) {
        out.push('')
        out.push('Table contents in plain English:')
        for (const row of rows) {
          const parts: string[] = []
          for (let c = 0; c < headers.length; c++) {
            const h = headers[c] || `Col${c + 1}`
            const v = row[c] ?? ''
            if (v) parts.push(`${h}: ${v}`)
          }
          if (parts.length > 0) out.push(`- ${parts.join('. ')}`)
        }
        out.push('')
      }
      i = j
    } else {
      out.push(headerLine)
      i++
    }
  }
  return out.join('\n')
}

/** Find docs in the user's vault whose name appears in the query.
 *  Handles common variants: "portfolio target" → portfolio-target.md,
 *  "portfolio_target" → portfolio-target.md, etc. Excludes the
 *  anchor doc (it has its own focused retrieval path).
 *
 *  Min length 4 chars to avoid trivial matches like a doc named
 *  "ai" matching any query. */
export function matchDocsByName(
  query: string,
  readable: DocumentMeta[],
  anchorId: string,
): Set<string> {
  // Normalize the query: lowercase, replace hyphens / underscores /
  // dots / slashes with spaces, collapse runs of whitespace.
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[-_./]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const qNorm = normalize(query)
  if (!qNorm) return new Set()

  const matches = new Set<string>()
  for (const d of readable) {
    if (d.id === anchorId) continue
    // Candidate names: the title, the filename without extension,
    // and the storageKey leaf without extension. All normalized
    // through the same path as the query.
    const stem = d.storageKey.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
    const candidates = [d.title, stem, d.originalFilename.replace(/\.[^.]+$/, '')]
      .map(normalize)
      .filter((c) => c.length >= 4)
    for (const c of candidates) {
      // Match either as a contiguous substring OR as a sequence of
      // tokens separated by other tokens (so "portfolio target"
      // matches a query like "tied to the portfolio target").
      if (qNorm.includes(c)) {
        matches.add(d.id)
        break
      }
    }
  }
  return matches
}

function truncateForBudget(text: string, budget: number): string {
  if (text.length <= budget) return text
  // Keep 80% head, 20% tail — head has overview/intro/front matter,
  // tail often has conclusions. Drop the middle with a marker so
  // the model knows it's not seeing everything.
  const headLen = Math.floor(budget * 0.8)
  const tailLen = budget - headLen - 64
  return (
    text.slice(0, headLen) +
    `\n\n[…document truncated, ${text.length - budget} characters elided…]\n\n` +
    text.slice(text.length - tailLen)
  )
}

/**
 * Build the messages array fed to Ollama. The system message pins
 * the model to the supplied document; the user message embeds the
 * RAG snippets so they're inline with the actual question.
 */
export function buildOllamaMessages(
  ctx: AssembledContext,
  history: ChatMessage[],
  query: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  // Grounding prompt. Pattern follows Anthropic's recommended
  // structure for RAG: (1) context first via tagged blocks so the
  // model treats them as authoritative material, (2) explicit
  // refusal protocol with a fixed canned response for off-topic
  // chitchat, (3) low-temperature sampling enforced in the request
  // body so a small model can't drift creatively.
  const refusal = `I can only answer questions about "${ctx.anchor.title}". What would you like to know about it?`
  const notFound = `That isn't in the document.`

  // Lead with just a single-line role declaration. The full
  // rules + few-shot example come AFTER all the context blocks —
  // small models give more weight to the bottom of the prompt
  // (recency bias), so structure-shaping instructions land harder
  // when they sit right before the user's question.
  const systemParts: string[] = [
    `You are Reader AI — a document-grounded assistant inside the user's personal vault. You answer ONLY from the supplied material.`,
  ]

  // Edit-intent detection — when the user is clearly asking to
  // MODIFY the document (verbs like rephrase/rewrite/edit/fix/add/
  // remove/append/…), we inject a strong directive at the TOP of
  // the prompt requiring a <proposed_edit> block. Small models do
  // not follow the rules-at-the-bottom instruction consistently;
  // a duplicated top-level directive raises the success rate.
  const editIntent = detectEditIntent(query)
  // If the query is a Reply-popover message with a `> "…"` quote AND
  // edit intent fired, locate which heading owns the quote so we can
  // tell the model exactly which heading to target. Without this hint
  // the model would have to scan the doc and guess — small models
  // get this wrong most of the time.
  const quotedExcerpt = editIntent ? extractQuotedExcerpt(query) : null
  const quotedHeading = quotedExcerpt && ctx.anchorTextFull
    ? locateHeadingForExcerpt(ctx.anchorTextFull, quotedExcerpt)
    : null
  if (editIntent) {
    systemParts.push(
      ``,
      `<edit_mode required="true">`,
      `The user is asking you to MODIFY this document. Your response MUST include exactly one <proposed_edit> XML block. A prose-only answer is a hard rule violation.`,
      ``,
      `Output shape (in this exact order):`,
      `  1. ONE short sentence describing what you are changing. No "Rephrase:" prefix, no quoted preview — just describe the change.`,
      `  2. Then a single <proposed_edit> block. The block contains the NEW content directly, not a rephrase-of-a-rephrase or a description of the change.`,
      ``,
      `Pick ONE op:`,
      `  <proposed_edit op="replace_section" heading="EXACT HEADING">…new BODY only — DO NOT repeat the "## heading" line; the existing heading stays automatically…</proposed_edit>`,
      `  <proposed_edit op="insert_after" heading="EXACT HEADING">…new content…</proposed_edit>`,
      `  <proposed_edit op="delete_section" heading="EXACT HEADING"></proposed_edit>`,
      `  <proposed_edit op="append_text">…content to add at end…</proposed_edit>`,
      `  <proposed_edit op="prepend_text">…content to add at start…</proposed_edit>`,
      ``,
      `The "heading" attribute must match an existing ATX heading character-for-character (no leading #).`,
      quotedHeading
        ? `HINT: The user's quoted excerpt comes from the section with heading "${quotedHeading}". Use op="replace_section" heading="${quotedHeading}" and put ONLY the new section body inside (NO leading "## ${quotedHeading}" line — the existing heading is preserved automatically).`
        : `If unsure which heading owns the change, use append_text or prepend_text.`,
      `</edit_mode>`,
    )
  }

  // MIME-aware framing — tells the model whether the body is OCR'd
  // image text, extracted PDF text, a transcript, a spreadsheet
  // dump, etc. Without this, small models treat fragmented OCR
  // like prose and produce "this document describes a list of
  // sections…" type confabulations.
  const sourceHint = formatSourceHint(ctx.anchor)
  if (sourceHint) {
    systemParts.push('', `<source_format>`, sourceHint, `</source_format>`)
  }

  // Primary sections — the most important material when section
  // match fires. Render with explicit "## ANSWER FROM THESE
  // SECTIONS" header so even a small model treats them as the
  // answer body.
  if (ctx.focusChunks.length > 0) {
    systemParts.push('', '<primary_sections>')
    systemParts.push('  <!-- The user is asking about these sections. Your answer must describe what is HERE. -->')
    for (const c of ctx.focusChunks) {
      systemParts.push(`  <section idx="${c.chunkIdx}" score="${c.score}">`)
      systemParts.push(c.text)
      systemParts.push(`  </section>`)
    }
    systemParts.push('</primary_sections>')
  }

  // Full document body is only included when there's NO section
  // match — i.e. the user asked a question that didn't name a
  // specific section, so we hand the model the whole doc to work
  // with. When a section match exists, the matched sections ARE
  // the relevant material; including the full doc would only
  // dilute the model's focus.
  if (ctx.anchorText) {
    systemParts.push(
      '',
      `<document title="${ctx.anchor.title}" filename="${ctx.anchor.originalFilename}">`,
      ctx.anchorText,
      `</document>`,
    )
  }

  if (ctx.ragChunks.length > 0) {
    systemParts.push('', '<supporting_vault_context>')
    // Per-chunk budget. When section match fires, primary is the
    // main material — supporting docs get only ~300 chars each
    // (enough to flag what they're about + cite by name) so the
    // model can't pull entire paragraphs out of them for the body.
    // Without section match, more generous since the doc IS the
    // primary material.
    const promptChunkBudget = ctx.hasSectionMatch ? 300 : 1200
    systemParts.push(
      ctx.hasSectionMatch
        ? '  <!-- Other docs in the vault. Use these to draw cross-references — but the BODY of your answer must come from <primary_sections>. Cite supporting chunks like [DocTitle] when you mention them. -->'
        : '  <!-- Other docs in the vault. Use for drawing connections AFTER answering from primary. -->'
    )
    for (const c of ctx.ragChunks) {
      const trimmed = c.text.length > promptChunkBudget
        ? c.text.slice(0, promptChunkBudget) + '…'
        : c.text
      systemParts.push(`  <chunk title="${c.docTitle}" idx="${c.chunkIdx}" score="${c.score}">`)
      systemParts.push(trimmed)
      systemParts.push(`  </chunk>`)
    }
    systemParts.push('</supporting_vault_context>')
  }

  // Memory blocks — placed JUST before the rules at the bottom of
  // the prompt. Memories are "always true for this user" facts the
  // model should respect on every turn; positioning them next to
  // the rules ensures small models give them the same attention
  // weight as the rules themselves.
  if (ctx.permanentFacts.length > 0) {
    systemParts.push('', '<permanent_facts>')
    systemParts.push('  <!-- Facts the user has saved with /remember. Treat as always-true preferences/context. -->')
    for (const m of ctx.permanentFacts) {
      systemParts.push(`  <fact>${m.fact}</fact>`)
    }
    systemParts.push('</permanent_facts>')
  }
  if (ctx.docFacts.length > 0) {
    systemParts.push('', '<doc_facts>')
    systemParts.push('  <!-- Facts the user has saved with /remember-here for THIS doc specifically. -->')
    for (const m of ctx.docFacts) {
      systemParts.push(`  <fact>${m.fact}</fact>`)
    }
    systemParts.push('</doc_facts>')
  }
  if (ctx.knownMistakes.length > 0) {
    systemParts.push('', '<known_mistakes>')
    systemParts.push('  <!-- Past corrections the user has given via the 👎 button. Do NOT repeat these mistakes. -->')
    for (const n of ctx.knownMistakes) {
      systemParts.push(`  <correction>`)
      systemParts.push(`    Q: ${n.question}`)
      systemParts.push(`    Correct: ${n.correction}`)
      systemParts.push(`  </correction>`)
    }
    systemParts.push('</known_mistakes>')
  }

  // Rules + few-shot examples land HERE — at the bottom of the
  // system message, right before the conversation history. Small
  // models attend more strongly to the most recent tokens, so
  // structure-shaping instructions hit hardest when they're the
  // last thing the model sees before generating.
  systemParts.push(
    ``,
    `<rules>`,
    `1. Use ONLY the supplied material. No general knowledge, no training data, no world facts.`,
    ctx.hasSectionMatch
      ? `2. PRIMARY = <primary_sections>. Your answer body MUST describe what is in THESE sections (they are the actual passages the user is asking about). <supporting_vault_context> is for ONE cross-reference at the END of your answer, one sentence max, ONLY if it actually relates. If the supplied material doesn't connect the two, end with: "The document does not directly tie this to <topic>." Do not invent a connection.`
      : `2. PRIMARY = <document>. <supporting_vault_context> is only for drawing connections — never replace primary content with it.`,
    `3. If the answer isn't in the supplied material, reply with exactly: "${notFound}"`,
    `4. REFUSAL TRIGGERS — Reply with exactly "${refusal}" ONLY for: (a) actual greetings or acknowledgements — literal phrases like "hi", "hello", "hey", "thanks", "how are you", "good morning", "ok", "cool" — or (b) questions that explicitly name a subject unrelated to documents (e.g. "what's the weather", "who are you", "tell me about Roman history"). Do NOT refuse on vague but document-adjacent queries like "explain", "explain in detail", "summarize", "elaborate", "tell me more", "what is this", "what does this say" — those refer to the current document, treat them as "do X to this document" and use the supplied material to answer.`,
    `5. Never invent facts, numbers, names, dates, links, or quotes.`,
    `5a. RESPECT MEMORY — If <permanent_facts> or <doc_facts> are present, those user-supplied preferences apply to your answer (e.g. currency, units, term expansions, terseness). If <known_mistakes> are present, do NOT repeat those mistakes — use the "Correct:" guidance.`,
    `5b. FOLLOW-UPS vs TOPIC SHIFTS — Distinguish between two cases:`,
    `    (a) VAGUE FOLLOW-UP — the user's new question has no specific anchor noun and reads like an expansion request: "explain in detail", "why?", "how?", "more", "elaborate", "expand on that", "go deeper", "what do you mean", "really?", "huh". When there's a recent assistant turn in history, these refer to THAT turn — expand on it, add detail, clarify. Do NOT restart from the whole document.`,
    `    (b) TOPIC SHIFT — the user's new question names a different concept / section / entity than the previous turn ("now tell me about X", "compare with Y", "what about the Caveats section"). These are independent — do NOT carry over content from prior turns; pull fresh material from <primary_sections>.`,
    `    Default when uncertain: treat short anchorless queries as (a) follow-ups, treat queries with a clear new noun as (b) topic shifts.`,
    `6. STRUCTURE LONG ANSWERS — For lookup questions ("what is X"), 1–2 sentences is fine. For ANY of: "explain", "describe", "how does X work", "how is X tied to Y", "compare", "what's the reasoning behind X" — you MUST produce a multi-paragraph answer with markdown structure:`,
    `   - a one-line summary at the top (no heading)`,
    `   - then ## section headings for each distinct point`,
    `   - bullet lists under headings where listing applies`,
    `   - **bold** for key numbers, percentages, currency amounts, or named entities`,
    `   - short paragraphs (2–4 sentences max)`,
    `   Do NOT produce a single wall of prose for an "explain" question.`,
    `6a. ANCHOR HEADINGS TO PRIMARY — Your ## section headings MUST reflect the structure that exists inside <primary_sections>. If primary_sections is organised by year (Year 1, Year 5...), use those. If by milestone (Baseline, Step-up, Compounded), use those. If by SIP / Manual / Total, use those. DO NOT import headings (like "Tier 1", "Tier 2", "Indian Equity", "Gold") that appear only in <supporting_vault_context> — those docs are supporting cross-reference, not the structure of your answer.`,
    `7. Quote the source in backticks when you summarise or transform a passage.`,
    `8. Cite supporting vault chunks inline like [DocTitle].`,
    `9. NO META-COMMENTARY — Do NOT mention, quote, or reference the internal labels of this prompt: <primary_sections>, <document>, <supporting_vault_context>, <permanent_facts>, <doc_facts>, <known_mistakes>, <rules>, <example_*>. The user never sees those tag names. Do NOT include sentences like "Primary Sections covers X", "Rule Summary:", "Supporting Vault Context says Y", or any restatement of these rules. Do not restate the question. Do not say "Sure!", "Of course!", "Great question!". Just answer.`,
    `9a. NO INSTRUCTION ECHO — Do NOT include the user's instruction or directive in your output. The user already knows what they asked. Forbidden patterns: ending your answer with phrases like "explain it with simple words", "explain in detail", "tell me more", "show me X", "what is Y", "can you Z" — those are the user's words, not yours. If you finish the explanation, STOP. Do not append the request back as a closing line.`,
    `10. PROPOSED EDITS — When the user asks to MODIFY this document (verbs like rewrite, rephrase, edit, fix, improve, tighten, expand, add, append, prepend, insert, remove, delete, replace), do BOTH of the following in order:`,
    `    (a) Write a brief natural-language explanation of WHAT you are about to change and why (1-3 sentences, no headings).`,
    `    (b) Then emit ONE proposed_edit XML block using exactly one of these five ops:`,
    `        • <proposed_edit op="replace_section" heading="EXACT HEADING TEXT">…new content for that section…</proposed_edit>`,
    `        • <proposed_edit op="insert_after" heading="EXACT HEADING TEXT">…new section to add after that heading's block…</proposed_edit>`,
    `        • <proposed_edit op="delete_section" heading="EXACT HEADING TEXT"></proposed_edit>`,
    `        • <proposed_edit op="append_text">…content to append to end of document…</proposed_edit>`,
    `        • <proposed_edit op="prepend_text">…content to prepend to start of document…</proposed_edit>`,
    `    RULES FOR THE BLOCK:`,
    `    • The "heading" attribute must match an existing ATX heading inside <primary_sections> or <document> CHARACTER-FOR-CHARACTER (no leading #, but include exact wording, casing, punctuation). If the heading you need doesn't exist, use append_text or prepend_text instead.`,
    `    • The content INSIDE the tags is the new markdown body — for replace_section/insert_after, INCLUDE the heading line ("## My Heading") at the top of the content if you want a heading; otherwise omit it.`,
    `    • Emit AT MOST ONE proposed_edit block per turn. Pick the single change that best satisfies the request.`,
    `    • Do NOT emit a proposed_edit block when the user is only asking for an explanation, summary, definition, or comparison — only when they explicitly ask to change the document.`,
    `    • Do NOT mention the proposed_edit block in your natural-language part — the UI renders it as a separate card with Apply / Discard buttons.`,
    `</rules>`,
    ``,
    `<example_explanation_shape>`,
    `User: Explain section X and how it relates to topic Y.`,
    `Reader AI:`,
    `Section X covers <one-line summary from the section>.`,
    ``,
    `## <heading taken from inside primary_sections>`,
    `- **<key term from primary>**: <detail from section>`,
    `- **<another key term>**: <detail from section>`,
    `- **₹X figure**: <how it's used per primary>`,
    ``,
    `## How this connects to <Y>`,
    `<One sentence drawn from supporting_vault_context, cited as [Y].>`,
    `</example_explanation_shape>`,
    ``,
    `<example_compare_shape>`,
    `User: Compare X and Y from the document.`,
    `Reader AI:`,
    `X and Y are two <category from primary_sections> — they differ on <one-line summary>.`,
    ``,
    `## X`,
    `- **<attribute>**: <X's value, verbatim or close paraphrase from primary>`,
    `- **<attribute>**: <X's value>`,
    ``,
    `## Y`,
    `- **<attribute>**: <Y's value>`,
    `- **<attribute>**: <Y's value>`,
    ``,
    `## Key difference`,
    `<One- or two-sentence summary of what changes between X and Y, grounded in primary_sections.>`,
    `</example_compare_shape>`,
    ``,
    `<example_off_topic>`,
    `User: hi`,
    `Reader AI: ${refusal}`,
    `</example_off_topic>`,
    ``,
    `<example_vague_followup>`,
    `User (turn 1): what does this document say`,
    `Reader AI (turn 1): <one-line summary of what the document covers>`,
    `User (turn 2): explain in detail`,
    `Reader AI (turn 2): <EXPAND on turn 1's answer — go deeper on what was just summarised. Do NOT restart from "this document covers …" as if turn 1 didn't happen.>`,
    `</example_vague_followup>`,
    ``,
    `<example_vague_no_prior_turn>`,
    `User (turn 1): explain in detail`,
    `Reader AI (turn 1): <a complete multi-section answer about the supplied document. No prior turn to expand, so synthesise from primary_sections / document.>`,
    `</example_vague_no_prior_turn>`,
    ``,
    `<example_not_in_doc>`,
    `User: who is the prime minister of france?`,
    `Reader AI: ${notFound}`,
    `</example_not_in_doc>`,
    ``,
    `<example_propose_replace_section>`,
    `User: rewrite the Risks section to be tighter.`,
    `Reader AI:`,
    `Tightening the Risks section into a single paragraph.`,
    `<proposed_edit op="replace_section" heading="Risks">Equity exposure carries volatility risk: drawdowns of 30-50% are normal once a decade, and the strategy assumes you do not sell into them. Liquidity is constrained by the 3-year ELSS lock-in.`,
    `</proposed_edit>`,
    `</example_propose_replace_section>`,
    ``,
    `<example_propose_append_text>`,
    `User: add a TODO at the end reminding me to revisit this in Q3.`,
    `Reader AI:`,
    `Adding a TODO line at the end of the document.`,
    `<proposed_edit op="append_text">`,
    ``,
    `> TODO: revisit in Q3.`,
    `</proposed_edit>`,
    `</example_propose_append_text>`,
    ``,
    `<example_reply_with_quote>`,
    `User: > "Top up emergency fund to whatever 6x new monthly expenses looks like."`,
    ``,
    `rephrase this`,
    `Reader AI:`,
    `Rephrasing in a more direct tone while keeping the 6x rule intact.`,
    `<proposed_edit op="replace_section" heading="Emergency Fund">Raise the emergency fund so it covers six months of current expenses. Park it in a liquid fund, not a savings account.`,
    `</proposed_edit>`,
    `</example_reply_with_quote>`,
    ``,
    `<example_no_edit_just_explain>`,
    `User: > "Top up emergency fund to whatever 6x new monthly expenses looks like."`,
    ``,
    `what does this mean?`,
    `Reader AI: It is a rule of thumb: keep liquid savings equal to six months of your current monthly spending. As spending rises with income, the target rises with it. No edit proposed — you only asked for an explanation.`,
    `</example_no_edit_just_explain>`,
  )

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemParts.join('\n') },
  ]
  // Selection-popover questions strip history. Two shapes:
  //   • "Explain this: …" — Explain button, auto-sent.
  //   • A leading blockquote line `> "…"` followed by the user's
  //     freeform question — the Reply button, where the user
  //     quotes a selection and asks anything against it.
  // Both are fresh topics; the prior conversation is irrelevant.
  const isSelectionQuery =
    /^\s*Explain this:\s*"/i.test(query) || /^\s*>\s*"/.test(query)
  if (!isSelectionQuery) {
    const trimmed = history.slice(-HISTORY_MESSAGE_LIMIT)
    for (const m of trimmed) {
      messages.push({ role: m.role, content: m.content })
    }
  }
  messages.push({ role: 'user', content: query })
  return messages
}

/**
 * Yield tokens from Ollama's `/api/chat` stream. The stream uses
 * NDJSON — one JSON object per line; we parse them as they arrive
 * and emit just the assistant-content delta.
 *
 * The caller is responsible for serializing token events to SSE.
 */
export async function* streamOllamaChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
): AsyncGenerator<
  { kind: 'token'; token: string } | { kind: 'done'; reason?: string },
  void,
  void
> {
  if (!config.ollama.enabled) {
    throw new ChatError('Ollama is disabled — set OLLAMA_ENABLED=true and pull a chat model')
  }
  const url = `${config.ollama.baseUrl.replace(/\/+$/, '')}/api/chat`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.chatModel,
        messages,
        stream: true,
        options: {
          // Ceiling on generation tokens. 1536 is enough headroom
          // for "explain in detail" style long-form answers without
          // letting a runaway model spin forever. When the cap
          // fires Ollama sends `done_reason: 'length'` and we
          // append a truncation marker before persisting.
          num_predict: 1536,
          // Mid-range sampling. We need enough variance for the
          // model to break out of its "explain aggressive
          // portfolio in 4 prose paragraphs" attractor and pick
          // the structured-markdown path the rules ask for.
          // 0.5 is the lowest temp at which small qwen models
          // reliably switch shape on long-form requests. We
          // accept the trade — slightly looser refusals on
          // off-topic chitchat in exchange for actual hierarchy.
          temperature: 0.5,
          top_p: 0.7,
          top_k: 40,
          // Light repetition penalty so a stuck model doesn't get
          // worse — and stays inside the grounded answer space.
          repeat_penalty: 1.15,
        },
      }),
    })
  } catch (e) {
    throw new ChatError(`cannot reach Ollama at ${url}`, e)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ChatError(`Ollama returned ${res.status}: ${body.slice(0, 200)}`)
  }
  if (!res.body) throw new ChatError('Ollama returned an empty body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // Ollama writes one JSON object per line.
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        let obj: {
          message?: { content?: string }
          done?: boolean
          // Ollama reports why the stream ended. We care about
          // 'length' specifically — the token cap (`num_predict`)
          // fired and the answer is truncated mid-sentence. UI
          // shows a clear marker so the user knows.
          done_reason?: string
          error?: string
        }
        try {
          obj = JSON.parse(line)
        } catch {
          obj = {}
        }
        if (obj.error) throw new ChatError(`Ollama error: ${obj.error}`)
        const tok = obj.message?.content
        if (tok) yield { kind: 'token', token: tok }
        if (obj.done) {
          yield { kind: 'done', reason: obj.done_reason }
          return
        }
      }
      nl = buf.indexOf('\n')
    }
  }
  yield { kind: 'done' }
}
