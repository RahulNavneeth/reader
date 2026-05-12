import { createWorker, type Worker } from 'tesseract.js'

/**
 * Lazy-initialized single Tesseract worker. ~30MB English traineddata is
 * fetched on first use and cached by tesseract.js. Keeping the worker around
 * avoids paying the warm-up cost on every image (~600ms cold, ~150ms warm).
 */
let workerPromise: Promise<Worker> | null = null

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise
  workerPromise = createWorker('eng').catch((e) => {
    workerPromise = null
    throw e
  })
  return workerPromise
}

export async function extractImageText(buffer: Buffer): Promise<string> {
  try {
    const w = await getWorker()
    const result = await w.recognize(buffer)
    return (result.data.text ?? '').trim()
  } catch {
    return ''
  }
}

/** Best-effort shutdown — called by Fastify's onClose hook if wired. */
export async function shutdownOcr(): Promise<void> {
  if (!workerPromise) return
  try {
    const w = await workerPromise
    await w.terminate()
  } catch {
    /* swallow */
  } finally {
    workerPromise = null
  }
}
