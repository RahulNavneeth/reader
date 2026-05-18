/**
 * Worker-thread body for OCR. Wraps tesseract.js so heavy recognize
 * calls don't block the main event loop (a 5 MP scanned PDF page is
 * ~600ms of CPU work that previously stalled HTTP request handling
 * mid-ingest).
 *
 * Protocol: main posts `{ id: number, buffer: ArrayBuffer }`; we
 * post back `{ id, text }` or `{ id, error: string }`.
 */
import { parentPort } from 'node:worker_threads'
import { createWorker, type Worker } from 'tesseract.js'

if (!parentPort) {
  throw new Error('ocrWorker.ts must be loaded as a worker_threads worker')
}

let workerPromise: Promise<Worker> | null = null

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise
  workerPromise = createWorker('eng', undefined, { errorHandler: () => {} }).catch((e) => {
    workerPromise = null
    throw e
  })
  return workerPromise
}

parentPort.on('message', async (msg: { id: number; buffer: ArrayBufferLike } | 'shutdown') => {
  if (msg === 'shutdown') {
    if (workerPromise) {
      const w = await workerPromise.catch(() => null)
      if (w) await w.terminate().catch(() => undefined)
      workerPromise = null
    }
    parentPort!.postMessage({ id: -1, text: '' })
    process.exit(0)
  }
  try {
    const w = await getWorker()
    const result = await w.recognize(Buffer.from(msg.buffer))
    parentPort!.postMessage({ id: msg.id, text: (result.data.text ?? '').trim() })
  } catch (e: any) {
    parentPort!.postMessage({ id: msg.id, error: e?.message ?? String(e) })
  }
})
