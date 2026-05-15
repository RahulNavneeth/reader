import { config } from '../config.js'
import { chunkText } from '../lib/chunk.js'
import {
  saveMeta,
  writeText,
  writeChunks,
  writeThumbnail,
  writePreview,
  loadMeta,
} from '../stores/documents.js'
import { extractText } from './extract.js'
import { embedBatch, EmbedError } from './embed.js'
import { generateThumbnail } from './thumbnail.js'
import {
  isImageNeedingTranscode,
  isVideo,
  transcodeImageToJpeg,
  videoFrameAt,
} from './media.js'
import type { Chunk, DocumentMeta } from '../types.js'
import { invalidateSearchCache } from './search.js'
import { publish } from './events.js'

/**
 * Run the full ingestion pipeline for a freshly-uploaded document:
 *  1. Extract text from the original blob
 *  2. Persist text.txt
 *  3. Chunk the text
 *  4. Embed each chunk via Ollama (best-effort; falls back to text-only)
 *  5. Persist chunks.jsonl + updated meta.json
 *
 * Always returns the latest meta. Errors are reflected in meta.ingest, never thrown.
 */
export async function ingestDocument(meta: DocumentMeta, buffer: Buffer): Promise<DocumentMeta> {
  // Fire-and-forget thumbnail (and HEIC preview) generation in parallel with
  // the extract/embed pipeline. We don't block the response on it.
  ;(async () => {
    try {
      const thumb = await generateThumbnail(buffer, meta.originalFilename)
      if (thumb) {
        await writeThumbnail(meta.id, thumb)
        publish({ type: 'thumbnail', path: meta.storageKey, docId: meta.id })
      }
    } catch {
      /* swallow — thumbnail is purely cosmetic */
    }
    // Full-size browser-renderable preview for formats browsers can't display
    // natively (HEIC, HEIF, TIFF, JXL, all video containers). The thumbnail
    // pipeline above handles the small grid tile; this gives the doc viewer a
    // JPEG it can drop into an <img>.
    try {
      if (isImageNeedingTranscode(meta.originalFilename)) {
        const jpeg = await transcodeImageToJpeg(buffer, meta.originalFilename)
        if (jpeg) {
          await writePreview(meta.id, jpeg)
          publish({ type: 'preview', path: meta.storageKey, docId: meta.id })
        }
      } else if (isVideo(meta.originalFilename)) {
        const frame = await videoFrameAt(buffer, meta.originalFilename)
        if (frame) {
          await writePreview(meta.id, frame)
          publish({ type: 'preview', path: meta.storageKey, docId: meta.id })
        }
      }
    } catch {
      /* swallow — preview is best-effort */
    }
  })()

  let next: DocumentMeta = { ...meta, ingest: { ...meta.ingest, status: 'extracting' } }
  await saveMeta(next)
  publish({ type: 'ingest', path: meta.storageKey, docId: meta.id, status: next.ingest.status })

  let text = ''
  try {
    text = await extractText(buffer, meta.mime, meta.originalFilename)
  } catch (e: any) {
    next = {
      ...next,
      updatedAt: Date.now(),
      ingest: { ...next.ingest, status: 'failed', error: `extract: ${e?.message ?? String(e)}` },
    }
    await saveMeta(next)
  publish({ type: 'ingest', path: meta.storageKey, docId: meta.id, status: next.ingest.status })
    return next
  }

  await writeText(meta.id, text)
  next = { ...next, updatedAt: Date.now(), ingest: { ...next.ingest, extractedAt: Date.now() } }

  if (!text.trim()) {
    next = {
      ...next,
      updatedAt: Date.now(),
      ingest: { ...next.ingest, status: 'no-text', chunkCount: 0, embedded: false },
    }
    await saveMeta(next)
  publish({ type: 'ingest', path: meta.storageKey, docId: meta.id, status: next.ingest.status })
    invalidateSearchCache()
    return next
  }

  const segments = chunkText(text, config.ingest.chunkChars, config.ingest.chunkOverlap)

  let chunks: Chunk[] = segments.map((t, idx) => ({ idx, text: t, embedding: [] }))
  let embedded = false
  let embedDim = 0

  next = { ...next, ingest: { ...next.ingest, status: 'embedding', chunkCount: chunks.length } }
  await saveMeta(next)
  publish({ type: 'ingest', path: meta.storageKey, docId: meta.id, status: next.ingest.status })

  try {
    const vectors = await embedBatch(segments)
    chunks = chunks.map((c, i) => ({ ...c, embedding: vectors[i] ?? [] }))
    embedded = chunks.some((c) => c.embedding.length > 0)
    embedDim = chunks[0]?.embedding.length ?? 0
  } catch (e) {
    if (e instanceof EmbedError) {
      // Soft-fail: keep chunks text-only, mark as not embedded so a later sweep can fill.
      console.warn(`[ingest] embedding skipped for ${meta.id}: ${e.message}`)
    } else {
      throw e
    }
  }

  await writeChunks(meta.id, chunks)
  next = {
    ...next,
    updatedAt: Date.now(),
    ingest: {
      ...next.ingest,
      status: 'ready',
      chunkCount: chunks.length,
      embedded,
      embedDim,
      embeddedAt: embedded ? Date.now() : next.ingest.embeddedAt,
    },
  }
  await saveMeta(next)
  publish({ type: 'ingest', path: meta.storageKey, docId: meta.id, status: next.ingest.status })
  invalidateSearchCache()
  return next
}

/** Re-embed a document whose text is already extracted. Used by an admin sweep. */
export async function reembedDocument(id: string): Promise<DocumentMeta | null> {
  const meta = await loadMeta(id)
  if (!meta) return null
  // We don't have the original buffer here; we just chunk text.txt and embed.
  const { readText } = await import('../stores/documents.js')
  const text = await readText(id)
  if (!text || !text.trim()) return meta
  const segments = chunkText(text, config.ingest.chunkChars, config.ingest.chunkOverlap)
  const vectors = await embedBatch(segments)
  const chunks: Chunk[] = segments.map((t, idx) => ({ idx, text: t, embedding: vectors[idx] ?? [] }))
  await writeChunks(id, chunks)
  const next: DocumentMeta = {
    ...meta,
    updatedAt: Date.now(),
    ingest: {
      ...meta.ingest,
      status: 'ready',
      chunkCount: chunks.length,
      embedded: true,
      embedDim: chunks[0]?.embedding.length ?? 0,
      embeddedAt: Date.now(),
    },
  }
  await saveMeta(next)
  publish({ type: 'ingest', path: meta.storageKey, docId: meta.id, status: next.ingest.status })
  invalidateSearchCache()
  return next
}
