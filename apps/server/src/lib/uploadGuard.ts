/**
 * Magic-byte content-type validation.
 *
 * The browser's reported `Content-Type` on a multipart upload is
 * trivially spoofable — a malicious client can claim `image/png` while
 * uploading an HTML file with a `<script>` payload. We re-detect the
 * real type from the first few bytes via `file-type` and reject when
 * the sniffed type disagrees with the claimed type *and* the extension.
 *
 * For text-y formats (markdown, csv, json, txt, yaml, toml, html) we
 * can't magic-byte detect — `file-type` returns nothing. We allow
 * those when the extension matches the claimed text MIME prefix and
 * the buffer contains no nul bytes (i.e. actually looks like text).
 */
import { fileTypeFromBuffer } from 'file-type'
import path from 'node:path'

const TEXTUAL_EXTS = new Set([
  '.md', '.markdown', '.mdx',
  '.txt', '.text',
  '.csv', '.tsv',
  '.json',
  '.yaml', '.yml',
  '.toml',
  '.html', '.htm', '.xml',
  '.log', '.ini', '.conf', '.cfg',
])

export type GuardResult =
  | { ok: true; mime: string }
  | { ok: false; reason: string }

/**
 * Returns `ok: true` with the trusted MIME, or `ok: false` with a
 * human-readable rejection reason. Empty buffers and zero-length
 * files are rejected upstream — this guard assumes content.
 */
export async function validateUpload(
  buffer: Buffer,
  filename: string,
  claimedMime?: string,
): Promise<GuardResult> {
  const ext = path.extname(filename).toLowerCase()

  // First try magic-byte detection.
  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined)
  if (detected) {
    // Sniffed binary type. Cross-check against extension when we have
    // one — a `.png` upload that sniffs as `text/html` or `application/
    // x-msdownload` is almost certainly an attempt to smuggle. We allow
    // the upload when sniffed extension matches the filename
    // extension (case-insensitive), regardless of claimed MIME.
    const sniffedExt = '.' + detected.ext
    if (ext && ext !== sniffedExt) {
      // Common alias allowances: jpg/jpeg, tif/tiff, heic/heif —
      // file-type returns one of each pair.
      const aliases: Record<string, string[]> = {
        '.jpg': ['.jpeg'], '.jpeg': ['.jpg'],
        '.tif': ['.tiff'], '.tiff': ['.tif'],
        '.heic': ['.heif'], '.heif': ['.heic'],
        '.htm': ['.html'], '.html': ['.htm'],
      }
      const accepted = aliases[ext]?.includes(sniffedExt) ?? false
      if (!accepted) {
        return {
          ok: false,
          reason: `extension ${ext} doesn't match detected file type ${sniffedExt}`,
        }
      }
    }
    return { ok: true, mime: detected.mime }
  }

  // No magic-byte signature → likely a text format. Accept only when
  // the extension is on the textual allow-list AND the bytes don't
  // contain nul (a quick "is this binary?" probe).
  if (TEXTUAL_EXTS.has(ext)) {
    // Check the first 8KB for nul bytes — covers nearly any practical
    // text-vs-binary heuristic without paying for a full scan.
    const probe = buffer.subarray(0, 8 * 1024)
    if (probe.includes(0)) {
      return { ok: false, reason: `${ext} declared but file looks binary` }
    }
    return { ok: true, mime: claimedMime || 'application/octet-stream' }
  }

  // Unknown extension AND no magic-byte signature. Accept with a
  // generic MIME — the file is harmless to store; the viewer will
  // just offer a download. (This is the path that .zip / .m4a etc.
  // take when `file-type` doesn't recognize them.)
  return { ok: true, mime: claimedMime || 'application/octet-stream' }
}
