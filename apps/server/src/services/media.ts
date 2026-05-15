/**
 * Media classification + transcode helpers. Centralizes the format
 * knowledge so thumbnail / preview / extract / ingest can all ask the same
 * questions and call the same codepaths.
 *
 *   - Browser-renderable images go through unchanged.
 *   - HEIC/HEIF, TIFF, JXL get transcoded to JPEG (browsers can't render them).
 *   - Videos get a first-frame JPEG for thumb + preview; the original is what
 *     browsers play via <video>.
 */
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { convertHeicToJpeg } from './heic.js'

const IMAGE_TRANSCODE_EXTS = new Set(['.heic', '.heif', '.tiff', '.tif', '.jxl'])
const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm',
  '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
])

export function extOf(filename: string): string {
  return path.extname(filename).toLowerCase()
}

export function isVideo(filename: string): boolean {
  return VIDEO_EXTS.has(extOf(filename))
}

/** True for image formats that need server-side conversion to render in a browser. */
export function isImageNeedingTranscode(filename: string): boolean {
  return IMAGE_TRANSCODE_EXTS.has(extOf(filename))
}

/**
 * Transcode HEIC/TIFF/JXL bytes into a JPEG buffer browsers can display.
 * Returns null on failure so callers can fall back to type icons.
 */
export async function transcodeImageToJpeg(
  buffer: Buffer,
  filename: string,
): Promise<Buffer | null> {
  const ext = extOf(filename)
  if (ext === '.heic' || ext === '.heif') return convertHeicToJpeg(buffer)
  if (ext === '.tiff' || ext === '.tif' || ext === '.jxl') {
    try {
      const sharp = (await import('sharp')).default
      return await sharp(buffer).jpeg({ quality: 85 }).toBuffer()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Extract a single frame from a video at the given timestamp (default 1s in,
 * so we skip the usually-black opening frame) and return PNG bytes. Uses the
 * system ffmpeg; returns null if it's missing or the file isn't decodable.
 */
export async function videoFrameAt(
  inputBuffer: Buffer,
  filename: string,
  seekSeconds = 1,
): Promise<Buffer | null> {
  let tmpDir: string | null = null
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'reader-vid-'))
    // Preserve the extension so ffmpeg picks the right demuxer.
    const safeExt = extOf(filename) || '.bin'
    const inputPath = path.join(tmpDir, `in${safeExt}`)
    const outputPath = path.join(tmpDir, 'frame.png')
    await writeFile(inputPath, inputBuffer)
    const ok = await runFfmpeg([
      '-y',
      '-ss', String(seekSeconds),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=iw:ih', // identity; thumbnail pipeline downsizes later.
      '-f', 'image2',
      outputPath,
    ])
    if (!ok) return null
    return await readFile(outputPath)
  } catch {
    return null
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => null)
  }
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
    // 30s cap — even very large files should produce a frame quickly.
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {} ; resolve(false) }, 30_000)
  })
}
