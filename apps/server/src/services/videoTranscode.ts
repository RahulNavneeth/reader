/**
 * HLS transcoding for video files.
 *
 * For each uploaded video we shell out to ffmpeg to produce an HLS
 * playlist (`hls/playlist.m3u8`) + segment files (`hls/seg_NNN.ts`)
 * inside the doc's storage directory. Playback then streams 6-second
 * chunks instead of forcing the browser to download the whole file
 * before playing — essential for anything past phone-clip length.
 *
 * Two passes:
 *   1. Stream-copy attempt (`-c copy`). Free; works when the source
 *      codec is already H.264 / AAC + the container is MP4/M4V. Most
 *      iPhone uploads land here.
 *   2. Transcode fallback. Re-encode to H.264 yuv420p + AAC 128k at
 *      a fast preset. Slow (real-time-ish on CPU) but produces a
 *      universally-playable HLS.
 *
 * The whole thing is best-effort — failures don't block the upload
 * or break the existing `/api/file/raw` direct-serve path.
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'

let ffmpegChecked = false
let ffmpegAvailable = false
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegAvailable
  ffmpegChecked = true
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('exit', () => resolve(true))
  })
  return ffmpegAvailable
}

/** Where the per-doc HLS bundle lives on disk. Co-located with the
 *  doc's meta + chunks so a `deleteDocument` cleans it up too. */
export function hlsDir(docId: string): string {
  return path.join(config.paths.documents, docId, 'hls')
}

/** Public path the client requests for the playlist. */
export function hlsPlaylistName(): string {
  return 'playlist.m3u8'
}

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi',
  '.3gp', '.3gpp', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
])

export function isVideoForHls(filename: string): boolean {
  const m = filename.toLowerCase().match(/\.[^./\\]+$/)
  return !!m && VIDEO_EXTS.has(m[0])
}

async function runFfmpeg(args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: 'ignore' })
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.on('error', () => {
      clearTimeout(t)
      resolve(false)
    })
    p.on('exit', (code) => {
      clearTimeout(t)
      resolve(code === 0)
    })
  })
}

/**
 * Generate an HLS bundle for the given video. Writes
 * `<docDir>/hls/playlist.m3u8` + segments. Returns true on success.
 *
 * Buffer-in / disk-out: ffmpeg only reads from a file path (stdin
 * doesn't handle non-streamable containers reliably), so we land the
 * input in tmpdir first.
 */
export async function transcodeToHls(
  buffer: Buffer,
  filename: string,
  docId: string,
): Promise<boolean> {
  if (!isVideoForHls(filename)) return false
  if (!(await hasFfmpeg())) return false

  const tmp = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), 'reader-hls-')),
  )
  const inPath = path.join(tmp, 'in' + path.extname(filename))
  const out = hlsDir(docId)

  try {
    await writeFile(inPath, buffer)
    await mkdir(out, { recursive: true })

    const playlistPath = path.join(out, hlsPlaylistName())
    const segPattern = path.join(out, 'seg_%03d.ts')
    const commonArgs = [
      '-y',
      '-loglevel', 'error',
      '-i', inPath,
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', segPattern,
      '-movflags', '+faststart',
    ]

    // First attempt: stream-copy. Fast (no re-encode), works when the
    // source is already MP4-in-MP4 / H.264+AAC. ~2s for a 10min video.
    const copyOk = await runFfmpeg(
      [...commonArgs, '-c', 'copy', playlistPath],
      // 2 min ceiling — should be near-instant; we cap so a stuck
      // copy doesn't block the ingest queue forever.
      2 * 60 * 1000,
    )
    if (copyOk) return true

    // Fallback: transcode. Slower but reliable. Cap at 30 minutes —
    // anything longer than a 30min source on a modest CPU is a
    // signal to bump the box, not to wait.
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    const transcodeOk = await runFfmpeg(
      [
        ...commonArgs,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        playlistPath,
      ],
      30 * 60 * 1000,
    )
    return transcodeOk
  } catch {
    return false
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Returns true if an HLS bundle exists on disk for this doc. */
export async function hasHls(docId: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    const s = await stat(path.join(hlsDir(docId), hlsPlaylistName()))
    return s.isFile()
  } catch {
    return false
  }
}
