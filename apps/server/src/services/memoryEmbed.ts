/**
 * Memory embeddings — compute, store, and backfill.
 *
 * Memories are short text snippets the user wants Reader AI to
 * remember ("PRAN = Permanent Retirement Account Number", "Use
 * INR by default"). The chat retrieval ranker uses these
 * embeddings to decide which memories are relevant to a given
 * query and shouldn't dump all of them into every prompt.
 *
 * Two entry points:
 *   • embedMemoryFact(fact)            — used on memory create, so
 *                                        the row lands with an
 *                                        embedding instead of NULL.
 *   • backfillMissingMemoryEmbeddings() — boot job that fills any
 *                                        legacy rows. Best-effort:
 *                                        a failure here doesn't
 *                                        block the server from
 *                                        starting; we'll retry on
 *                                        the next boot.
 */
import {
  listUserMemoriesWithoutEmbedding,
  listDocMemoriesWithoutEmbedding,
  setUserMemoryEmbedding,
  setDocMemoryEmbedding,
} from '../db/memoriesRepo.js'
import { embedBatch, EmbedError } from './embed.js'

/** Embed a single memory fact. Throws EmbedError if the embed
 *  backend is unavailable — callers in non-critical paths should
 *  catch + fall through (the row gets a NULL embedding and the
 *  next backfill cycle picks it up). */
export async function embedMemoryFact(fact: string): Promise<Float32Array | null> {
  const trimmed = fact.trim()
  if (!trimmed) return null
  const [vec] = await embedBatch([trimmed], 'document')
  if (!vec || vec.length === 0) return null
  return new Float32Array(vec)
}

/** Best-effort backfill of NULL embeddings. Returns counts for
 *  logging. Designed to be called on boot AFTER migrations run;
 *  catches EmbedError so a stopped Ollama doesn't block startup. */
export async function backfillMissingMemoryEmbeddings(): Promise<{
  user: { attempted: number; succeeded: number }
  doc: { attempted: number; succeeded: number }
}> {
  const userResult = { attempted: 0, succeeded: 0 }
  const docResult = { attempted: 0, succeeded: 0 }

  // User memories first.
  const userRows = listUserMemoriesWithoutEmbedding()
  userResult.attempted = userRows.length
  if (userRows.length > 0) {
    try {
      // Batch in chunks of 32 — the embed endpoint accepts arrays
      // and the network round-trip dominates over CPU work, so a
      // single batch per chunk is cheapest.
      for (let i = 0; i < userRows.length; i += 32) {
        const batch = userRows.slice(i, i + 32)
        const vecs = await embedBatch(batch.map((r) => r.fact), 'document')
        for (let j = 0; j < batch.length; j++) {
          const vec = vecs[j]
          if (!vec || vec.length === 0) continue
          setUserMemoryEmbedding(batch[j].id, new Float32Array(vec))
          userResult.succeeded++
        }
      }
    } catch (e) {
      if (!(e instanceof EmbedError)) throw e
      // Embed offline; leave NULLs, next boot will retry.
    }
  }

  // Doc memories.
  const docRows = listDocMemoriesWithoutEmbedding()
  docResult.attempted = docRows.length
  if (docRows.length > 0) {
    try {
      for (let i = 0; i < docRows.length; i += 32) {
        const batch = docRows.slice(i, i + 32)
        const vecs = await embedBatch(batch.map((r) => r.fact), 'document')
        for (let j = 0; j < batch.length; j++) {
          const vec = vecs[j]
          if (!vec || vec.length === 0) continue
          setDocMemoryEmbedding(batch[j].id, new Float32Array(vec))
          docResult.succeeded++
        }
      }
    } catch (e) {
      if (!(e instanceof EmbedError)) throw e
    }
  }

  return { user: userResult, doc: docResult }
}
