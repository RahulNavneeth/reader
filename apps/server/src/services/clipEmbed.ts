/**
 * CLIP image-text embeddings via @huggingface/transformers (ONNX).
 *
 * Opt-in via CLIP_ENABLED=true. We lazy-load the model on the first
 * call so a Reader instance with CLIP disabled (the default) never
 * pays the ~150 MB model-download cost or the ONNX runtime startup.
 *
 * One model loads two pipelines:
 *   - image feature extractor (`getImageFeatures`)
 *   - text feature extractor   (`getTextFeatures`)
 * They share weights, so the second `pipeline()` call is cheap.
 *
 * The math the search code cares about: both pipelines emit 512-dim
 * float vectors in the same embedding space. Cosine similarity
 * between a text vector and an image vector is the CLIP "match
 * score". Normalize once at write-time so search-time math is a
 * plain dot product.
 */
import { config } from '../config.js'

type CLIPModel = {
  encodeImage(buffer: Buffer): Promise<number[] | null>
  encodeText(text: string): Promise<number[] | null>
}

let modelPromise: Promise<CLIPModel | null> | null = null

export function isClipEnabled(): boolean {
  return config.clip.enabled
}

/** Image extensions CLIP can usefully embed. Excludes RAW/HEIC since
 *  sharp would have to transcode first — for those we rely on the
 *  preview JPEG written at ingest time. */
const CLIP_IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp',
])

export function canClipEmbed(filename: string): boolean {
  const m = filename.toLowerCase().match(/\.[^./\\]+$/)
  return !!m && CLIP_IMAGE_EXTS.has(m[0])
}

function l2Normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum) || 1
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

async function loadModel(): Promise<CLIPModel | null> {
  try {
    // Dynamic import — keeps the heavy ONNX runtime out of the
    // server's hot path when CLIP_ENABLED=false. Also lets the
    // server still boot if @huggingface/transformers has a runtime
    // failure (missing native binding etc.).
    const tx = await import('@huggingface/transformers')
    const env = tx.env as { cacheDir?: string; allowLocalModels?: boolean }
    if (env.cacheDir !== undefined) env.cacheDir = config.clip.cacheDir
    if (env.allowLocalModels !== undefined) env.allowLocalModels = true

    // Hand the configured device + dtype to transformers.js.
    // It tries the requested provider first and surfaces an error
    // if the binding is missing. We catch that below and rebuild
    // on CPU so a misconfigured GPU env doesn't sink server boot.
    // transformers.js types device/dtype as discriminated unions;
    // cast since our config carries the validated string already.
    const pipelineOpts = {
      device: config.clip.device,
      dtype: config.clip.dtype,
    } as unknown as Parameters<typeof tx.pipeline>[2]
    let imagePipe: unknown
    let textPipe: unknown
    try {
      ;[imagePipe, textPipe] = await Promise.all([
        tx.pipeline('image-feature-extraction', config.clip.model, pipelineOpts),
        tx.pipeline('feature-extraction', config.clip.model, pipelineOpts),
      ])
    } catch (e) {
      if (config.clip.device !== 'cpu') {
        console.warn(
          `[clip] failed to load on device='${config.clip.device}' dtype='${config.clip.dtype}': ${(e as Error).message}. Falling back to CPU.`,
        )
        ;[imagePipe, textPipe] = await Promise.all([
          tx.pipeline('image-feature-extraction', config.clip.model),
          tx.pipeline('feature-extraction', config.clip.model),
        ])
      } else {
        throw e
      }
    }

    return {
      async encodeImage(buffer: Buffer): Promise<number[] | null> {
        try {
          // RawImage accepts a Blob; wrap the buffer.
          const blob = new Blob([buffer])
          const out = (await (imagePipe as unknown as (
            input: Blob,
            opts?: { pooling?: 'mean' | 'cls'; normalize?: boolean },
          ) => Promise<{ data: Float32Array | number[] }>)(blob, {
            pooling: 'mean',
            normalize: true,
          }))
          const arr = Array.from(out.data)
          return l2Normalize(arr)
        } catch (e) {
          console.warn('[clip] image embed failed:', (e as Error).message)
          return null
        }
      },
      async encodeText(text: string): Promise<number[] | null> {
        try {
          const out = (await (textPipe as unknown as (
            input: string,
            opts?: { pooling?: 'mean' | 'cls'; normalize?: boolean },
          ) => Promise<{ data: Float32Array | number[] }>)(text, {
            pooling: 'mean',
            normalize: true,
          }))
          const arr = Array.from(out.data)
          return l2Normalize(arr)
        } catch (e) {
          console.warn('[clip] text embed failed:', (e as Error).message)
          return null
        }
      },
    }
  } catch (e) {
    console.warn(
      '[clip] model load failed — image search will fall back to lexical+semantic:',
      (e as Error).message,
    )
    return null
  }
}

async function getModel(): Promise<CLIPModel | null> {
  if (!isClipEnabled()) return null
  if (!modelPromise) modelPromise = loadModel()
  return modelPromise
}

/** Embed an image into the shared CLIP space. Returns a 512-dim
 *  L2-normalized vector, or null if CLIP is off / the model couldn't
 *  load / decode failed. */
export async function embedImage(buffer: Buffer, filename: string): Promise<number[] | null> {
  if (!canClipEmbed(filename)) return null
  const model = await getModel()
  if (!model) return null
  return model.encodeImage(buffer)
}

/** Embed a text query into the shared CLIP space for image search. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const t = text.trim()
  if (!t) return null
  const model = await getModel()
  if (!model) return null
  return model.encodeText(t)
}

/** Plain dot product — both vectors are L2-normalized at write time,
 *  so this equals cosine similarity. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
