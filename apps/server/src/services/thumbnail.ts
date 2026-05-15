import path from 'node:path'
import {
  isImageNeedingTranscode,
  isVideo,
  transcodeImageToJpeg,
  videoFrameAt,
} from './media.js'

/**
 * Generate a small PNG preview for a file. Used by the folder grid so each
 * tile shows a visual sample instead of a generic icon.
 *
 * Returns `null` for filetypes we don't (or can't) render. The caller stores
 * the buffer alongside the document's meta + chunks.
 */
export async function generateThumbnail(
  buffer: Buffer,
  filename: string,
): Promise<Buffer | null> {
  const ext = path.extname(filename).toLowerCase()

  if (ext === '.pdf') return thumbnailFromPdf(buffer)
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'].includes(ext)) {
    return thumbnailFromImage(buffer)
  }
  if (isImageNeedingTranscode(filename)) {
    const jpeg = await transcodeImageToJpeg(buffer, filename)
    return jpeg ? thumbnailFromImage(jpeg) : null
  }
  if (isVideo(filename)) {
    const frame = await videoFrameAt(buffer, filename)
    return frame ? thumbnailFromImage(frame) : null
  }
  return null
}

const THUMB_WIDTH = 256

async function thumbnailFromPdf(buffer: Buffer): Promise<Buffer | null> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { createCanvas } = await import('@napi-rs/canvas')
    const pdf = await getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
    } as any).promise
    const page = await pdf.getPage(1)
    const initial = page.getViewport({ scale: 1 })
    const scale = THUMB_WIDTH / initial.width
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx as any, viewport }).promise
    const png = canvas.toBuffer('image/png')
    page.cleanup()
    await pdf.cleanup()
    await pdf.destroy()
    return png
  } catch {
    return null
  }
}

async function thumbnailFromImage(buffer: Buffer): Promise<Buffer | null> {
  try {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas')
    const img = await loadImage(buffer)
    if (!img.width || !img.height) return null
    const scale = Math.min(1, THUMB_WIDTH / img.width)
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toBuffer('image/png')
  } catch {
    return null
  }
}
