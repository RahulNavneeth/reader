/**
 * OCR client. Forwards image buffers to a Node `worker_threads`
 * worker so the recognize() calls run off the main event loop. The
 * worker holds a single warmed tesseract.js instance — the same
 * ~30MB eng.traineddata is paid once on first use and cached by
 * tesseract.js across calls.
 *
 * Why a worker thread? A scanned-PDF page is ~600ms of CPU per
 * recognize(); previously that stalled HTTP request handling for
 * every concurrent request, including the SSE channel and any
 * read-side queries. Moving it off-thread keeps the API responsive
 * during background ingest.
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  { resolve: (text: string) => void; reject: (err: Error) => void }
>()

function workerPath(): string {
  // In dev (tsx) this file is .ts in src/; in prod (compiled) it's
  // .js in dist/. Both live next to ocrWorker so we can resolve
  // relative — `import.meta.url` gives us the on-disk URL of the
  // current module either way.
  const here = fileURLToPath(import.meta.url)
  const isCompiled = here.endsWith('.js')
  return path.join(path.dirname(here), isCompiled ? 'ocrWorker.js' : 'ocrWorker.ts')
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(workerPath(), {
    // tsx runtime wraps the worker entry when we're in dev, so we
    // pass `execArgv` through; production uses plain `node` which
    // needs no wrapper.
    execArgv: workerPath().endsWith('.ts') ? ['--import', 'tsx/esm'] : undefined,
  })
  w.on('message', (msg: { id: number; text?: string; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.text ?? '')
  })
  w.on('error', (err) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    worker = null
  })
  w.on('exit', () => {
    worker = null
  })
  worker = w
  return w
}

export async function extractImageText(buffer: Buffer): Promise<string> {
  try {
    const w = getWorker()
    const id = nextId++
    return await new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      // Copy the bytes into a fresh ArrayBuffer so we can transfer
      // ownership to the worker — saves a memcpy on the worker side
      // (the original Buffer may be a slice of a pool, which we
      // can't transfer safely).
      const ab = new ArrayBuffer(buffer.byteLength)
      new Uint8Array(ab).set(buffer)
      w.postMessage({ id, buffer: ab }, [ab])
    })
  } catch {
    return ''
  }
}

/** Best-effort shutdown — called by Fastify's onClose hook if wired. */
export async function shutdownOcr(): Promise<void> {
  if (!worker) return
  try {
    worker.postMessage('shutdown')
    await new Promise((r) => setTimeout(r, 100))
    await worker.terminate().catch(() => undefined)
  } finally {
    worker = null
  }
}
