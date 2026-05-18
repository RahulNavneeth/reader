/**
 * Perceptual hash (dHash variant) for images. Returns a 64-bit
 * fingerprint where visually similar images (resize, recompress,
 * color tweak, mild crop) hash close together. Hamming distance
 * <= 6 ≈ "same image"; anything higher is probably a different
 * shot.
 *
 * Implementation: shrink to 9×8 grayscale, then bit i = (left[i] >
 * right[i]). That's dHash — cheaper than the DCT-based pHash and
 * empirically just as good for the "same photo, resaved" case which
 * is what our duplicate panel cares about.
 *
 * Hash is stored as a 16-char lowercase hex string (8 bytes).
 */
import sharp from 'sharp'

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif',
  '.bmp', '.ico', '.heic', '.heif', '.tiff', '.tif',
])

export function canPerceptualHash(filename: string): boolean {
  const m = filename.toLowerCase().match(/\.[^./\\]+$/)
  return !!m && IMAGE_EXTS.has(m[0])
}

/** Returns a 16-hex-char dHash or null when the image can't be
 *  decoded (corrupt file, unsupported format). Never throws. */
export async function dHash(buffer: Buffer): Promise<string | null> {
  try {
    const raw = await sharp(buffer, { failOn: 'none' })
      .resize(9, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer()
    // 8 rows × 9 cols → 8 bits per row from horizontal gradient.
    const bytes = new Uint8Array(8)
    for (let row = 0; row < 8; row++) {
      let byte = 0
      for (let col = 0; col < 8; col++) {
        const left = raw[row * 9 + col]
        const right = raw[row * 9 + col + 1]
        if (left > right) byte |= 1 << (7 - col)
      }
      bytes[row] = byte
    }
    return Buffer.from(bytes).toString('hex')
  } catch {
    return null
  }
}

/** Hamming distance between two 16-hex-char hashes. Lower = more
 *  similar. 0 = identical. ≤ 6 ≈ same image, recompressed/resized. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY
  let dist = 0
  for (let i = 0; i < a.length; i += 2) {
    const aByte = parseInt(a.slice(i, i + 2), 16)
    const bByte = parseInt(b.slice(i, i + 2), 16)
    let x = aByte ^ bByte
    while (x) {
      x &= x - 1
      dist++
    }
  }
  return dist
}
