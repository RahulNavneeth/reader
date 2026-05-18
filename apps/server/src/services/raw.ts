/**
 * RAW photo support. Camera RAW files (CR2/CR3, NEF, ARW, DNG, RAF,
 * ORF, RW2, PEF, SRW) are unrenderable by browsers — we shell out
 * to LibRaw's `dcraw_emu` binary to extract the embedded JPEG
 * preview that nearly every RAW format carries. That preview is
 * what gets used for thumbnails + the inline image viewer; the
 * full demosaic'd render would take 10× longer and isn't worth it
 * for a vault preview.
 *
 * Requires LibRaw installed on the host. The Docker image bundles
 * libraw-bin; bare-metal admins need `apt install libraw-bin` (or
 * `brew install libraw` on macOS dev).
 *
 * Falls back gracefully: returns null when dcraw_emu isn't on PATH
 * or the file has no embedded preview.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const RAW_EXTS = new Set([
  '.cr2', '.cr3',         // Canon
  '.nef', '.nrw',         // Nikon
  '.arw', '.srf', '.sr2', // Sony
  '.dng',                 // Adobe / many phones (Pixel)
  '.raf',                 // Fujifilm
  '.orf',                 // Olympus
  '.rw2',                 // Panasonic
  '.pef',                 // Pentax
  '.srw',                 // Samsung
  '.x3f',                 // Sigma
  '.kdc',                 // Kodak
])

export function isRaw(filename: string): boolean {
  const m = filename.toLowerCase().match(/\.[^./\\]+$/)
  return !!m && RAW_EXTS.has(m[0])
}

let dcrawChecked = false
let dcrawAvailable = false
async function hasDcraw(): Promise<boolean> {
  if (dcrawChecked) return dcrawAvailable
  dcrawChecked = true
  dcrawAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn('dcraw_emu', ['-h'], { stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('exit', () => resolve(true))
  })
  return dcrawAvailable
}

/**
 * Extract a JPEG preview from a RAW image buffer. Returns null when
 * the file isn't actually RAW, LibRaw isn't installed, or the RAW
 * has no usable embedded preview (rare — almost all modern cameras
 * write one).
 *
 * Memory: writes the input to a tempdir because dcraw_emu only
 * reads from disk, not stdin. Cleaned up before returning.
 */
export async function extractRawPreview(
  buffer: Buffer,
  filename: string,
): Promise<Buffer | null> {
  if (!isRaw(filename)) return null
  if (!(await hasDcraw())) return null

  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-raw-'))
  const ext = path.extname(filename) || '.raw'
  const inPath = path.join(dir, 'in' + ext)
  const outPath = path.join(dir, 'in.thumb.jpg')

  try {
    await writeFile(inPath, buffer)
    // `-e` = extract the embedded thumbnail/preview as-is (JPEG when
    // the camera wrote one, PPM otherwise). `-T` would force TIFF;
    // we want native JPEG bytes when available so the thumbnail
    // pipeline doesn't re-encode.
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn('dcraw_emu', ['-e', inPath], { stdio: 'ignore' })
      p.on('error', () => resolve(false))
      p.on('exit', (code) => resolve(code === 0))
    })
    if (!ok) return null
    // dcraw_emu writes alongside the input; the convention is
    // <stem>.thumb.<jpg|ppm>. JPEG is what 99% of cameras embed.
    const jpeg = await readFile(outPath).catch(() => null)
    return jpeg ?? null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
