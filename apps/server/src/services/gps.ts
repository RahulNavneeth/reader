/**
 * GPS extraction from image EXIF. Powers the /map view.
 *
 * Uses `exifr` (no native bindings, supports JPEG / HEIC / HEIF / TIFF /
 * WebP). We only parse the GPS group to keep memory + CPU minimal —
 * one image extract is sub-millisecond on a modern machine.
 *
 * Returns `null` (not `undefined`) when the file is an image but has no
 * GPS — caller persists the null so we don't re-parse on every map
 * view. Returns `undefined` when the file isn't a GPS-capable image.
 */
import exifr from 'exifr'

const GPS_EXTS = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.webp',
])

export function couldHaveGps(filename: string): boolean {
  const m = filename.toLowerCase().match(/\.[^.]+$/)
  if (!m) return false
  return GPS_EXTS.has(m[0])
}

export async function extractGps(
  buffer: Buffer,
  filename: string,
): Promise<{ lat: number; lng: number } | null | undefined> {
  if (!couldHaveGps(filename)) return undefined
  try {
    // `gps: true` restricts the parse to GPS-only tags — much cheaper
    // than `tiff: true` or the full default.
    const out = await exifr.gps(buffer)
    if (!out || typeof out.latitude !== 'number' || typeof out.longitude !== 'number') {
      return null
    }
    const lat = out.latitude
    const lng = out.longitude
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    // Filter the "Null Island" junk reading. Many phones / cameras
    // write 0,0 when GPS data is absent or invalid rather than omitting
    // the field — without this, every such photo lands as a fake pin
    // in the Atlantic off the coast of Africa. Same heuristic Immich /
    // Apple Photos use: reject anything within ~1km of (0,0).
    if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) return null
    // 6 decimal places is ~10cm precision — plenty, and shrinks JSON.
    return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }
  } catch {
    return null
  }
}
