/**
 * HEIC/HEIF → JPEG conversion. Browsers can't render HEIC natively, and our
 * other image pipeline (thumbnails, OCR) expects a format @napi-rs/canvas can
 * decode. Wraps `heic-convert` (pure-JS libheif) so we can keep the original
 * HEIC in the vault for downloads while serving a JPEG to anything that
 * needs to actually display the picture.
 */

const JPEG_QUALITY = 0.85

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer | null> {
  try {
    // @ts-expect-error — heic-convert ships no .d.ts; the runtime API is stable.
    const heicConvert = (await import('heic-convert')).default as (opts: {
      buffer: Uint8Array
      format: 'JPEG' | 'PNG'
      quality?: number
    }) => Promise<ArrayBuffer>
    // heic-decode's brand sniffer does `String.fromCharCode(...array.slice(8, 12))`
    // which requires a Uint8Array. A Node Buffer *is* a Uint8Array, but if you
    // hand it an ArrayBuffer the spread fails. Wrap defensively.
    const u8 =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer)
    const out = await heicConvert({
      buffer: u8,
      format: 'JPEG',
      quality: JPEG_QUALITY,
    })
    return Buffer.from(out)
  } catch {
    return null
  }
}

export function isHeic(filename: string): boolean {
  const m = filename.toLowerCase()
  return m.endsWith('.heic') || m.endsWith('.heif')
}
