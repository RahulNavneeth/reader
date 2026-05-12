import { config } from '../config.js'

export class EmbedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
  }
}

export type EmbedKind = 'query' | 'document'

/**
 * `nomic-embed-text` is trained to be prompted with one of two prefixes:
 *   "search_query: ..."     for the query side
 *   "search_document: ..."  for indexed passages
 * Without these, effective cosine on related pairs drops by ~0.15–0.20.
 */
function prefixFor(text: string, kind: EmbedKind): string {
  const model = (config.ollama.embedModel || '').toLowerCase()
  if (model.includes('nomic-embed')) {
    return kind === 'query' ? `search_query: ${text}` : `search_document: ${text}`
  }
  return text
}

/** Returns embeddings of length `dim` per input, or throws EmbedError if Ollama is unreachable. */
export async function embedBatch(inputs: string[], kind: EmbedKind = 'document'): Promise<number[][]> {
  if (!config.ollama.enabled) throw new EmbedError('ollama disabled')
  if (inputs.length === 0) return []
  // Ollama /api/embeddings only accepts one prompt at a time as of 0.3.x.
  // Fan out concurrently with a small worker pool.
  const out: number[][] = new Array(inputs.length)
  const concurrency = 4
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= inputs.length) return
        out[i] = await embedOne(prefixFor(inputs[i], kind))
      }
    }),
  )
  return out
}

async function embedOne(text: string): Promise<number[]> {
  const url = `${config.ollama.baseUrl.replace(/\/+$/, '')}/api/embeddings`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ollama.embedModel, prompt: text }),
    })
  } catch (e) {
    throw new EmbedError(`ollama unreachable at ${url}`, e)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EmbedError(`ollama error ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { embedding?: number[] }
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new EmbedError('ollama response missing embedding')
  }
  return data.embedding
}

export async function isAvailable(): Promise<boolean> {
  if (!config.ollama.enabled) return false
  try {
    const res = await fetch(`${config.ollama.baseUrl.replace(/\/+$/, '')}/api/tags`)
    return res.ok
  } catch {
    return false
  }
}
