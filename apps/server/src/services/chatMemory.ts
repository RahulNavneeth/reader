/**
 * Semantic retrieval over chat-message history.
 *
 * Once a thread exceeds the recent-window token budget, older turns
 * fall back to a one-line-per-turn extractive summary. That keeps
 * narrative continuity but loses pinpoint recall — the model can't
 * remember the specific question someone asked 30 turns ago.
 *
 * This module fills that gap: every persisted chat message carries
 * a nomic-embed-text embedding (768-dim float32). On a new turn the
 * dispatcher embeds the query (with the `search_query:` prefix
 * nomic requires), cosine-scans the thread's embedded history, and
 * returns the top-K turns above a similarity floor. Those get
 * injected into the prompt as a separate system note so the agent
 * sees "back at message #4 you asked about X" alongside the verbose
 * recent window.
 *
 * Stateless + cheap: a 200-message thread × 768 floats ≈ 600KB of
 * vectors; the cosine loop runs entirely in memory after a single
 * SQLite scan.
 */
import { listEmbeddedMessages, type EmbeddedChatMessage } from '../db/chatRepo.js'
import { embedBatch } from './embed.js'
import { cosine } from './search.js'

/** Below this cosine the match isn't meaningfully related — we'd
 *  rather skip than mislead the model with off-topic context. */
const MIN_COSINE = 0.55

/** Default number of past turns to pull. Small by design: the
 *  prompt already carries the extractive summary + the recent
 *  window; retrieved hits are the pinpoint extra. */
const DEFAULT_TOP_K = 3

export type RelevantMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  score: number
}

/** Embed `query` and return the top-K embedded messages in the
 *  given thread that are NOT in `excludeIds` (typically the IDs of
 *  the messages already going into the prompt's recent window).
 *  Returns oldest-first so the model reads them in conversation
 *  order when we inject them. */
export async function findRelevantPastMessages(opts: {
  docId: string
  userId: string
  threadId: string
  query: string
  excludeIds?: Set<string>
  topK?: number
}): Promise<RelevantMessage[]> {
  const excludeIds = opts.excludeIds ?? new Set<string>()
  const topK = opts.topK ?? DEFAULT_TOP_K
  const candidates: EmbeddedChatMessage[] = listEmbeddedMessages(
    opts.docId,
    opts.userId,
    opts.threadId,
  ).filter((m) => !excludeIds.has(m.id))
  if (candidates.length === 0) return []

  // Embed the query with the `query` prefix nomic-embed-text
  // expects. Document-side embeddings were written with the
  // `document` prefix at persistence time, so the asymmetric
  // prefixes line up.
  let qvec: number[]
  try {
    const [v] = await embedBatch([opts.query], 'query')
    if (!v || v.length === 0) return []
    qvec = v
  } catch {
    // Ollama unreachable / model missing / network blip — fall
    // back to no retrieval rather than failing the whole turn.
    return []
  }
  const qf = Float32Array.from(qvec)
  let normQ = 0
  for (const x of qf) normQ += x * x
  normQ = Math.sqrt(normQ)
  if (normQ === 0) return []

  const scored: Array<EmbeddedChatMessage & { score: number }> = []
  for (const m of candidates) {
    const s = cosine(qf, m.embedding, normQ)
    if (s >= MIN_COSINE) scored.push({ ...m, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, topK)
  // Render in chronological order for the prompt so it reads as a
  // mini-transcript rather than a relevance ranking.
  top.sort((a, b) => a.createdAt - b.createdAt)
  return top.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    score: m.score,
  }))
}

/** Best-effort `document`-side embedding for a chat message. Returns
 *  null when Ollama is unreachable or returns empty so the caller
 *  can persist the message without an embedding (it just won't be
 *  retrievable on future turns). */
export async function embedMessageForStorage(
  content: string,
): Promise<Float32Array | null> {
  const trimmed = content.trim()
  if (!trimmed) return null
  try {
    const [v] = await embedBatch([trimmed], 'document')
    if (!v || v.length === 0) return null
    return Float32Array.from(v)
  } catch {
    return null
  }
}
