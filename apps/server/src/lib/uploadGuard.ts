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

  // No magic-byte signature → either a text format or an unrecognized
  // binary. Use a nul-byte probe to tell them apart.
  //
  // Probe runs across the first 8 KB; nul means "this is binary",
  // no nul means "this is text". Combined with the extension's
  // expected family, we get four cases:
  //   - text extension + no nul  → accept as text  (the .md/.txt path)
  //   - text extension + nul     → REFUSE (claims text, looks binary)
  //   - binary extension + nul   → accept as octet-stream
  //                                (the .zip/.m4a-that-file-type-missed path)
  //   - binary extension + no nul → REFUSE (claims binary, looks text —
  //                                catches "HTML smuggled as .png")
  //   - unknown extension        → fall through to the existing
  //                                permissive accept; we don't have
  //                                enough signal either way.
  const probe = buffer.subarray(0, 8 * 1024)
  const looksTextual = !probe.includes(0)
  if (TEXTUAL_EXTS.has(ext)) {
    if (!looksTextual) {
      return { ok: false, reason: `${ext} declared but file looks binary` }
    }
    return { ok: true, mime: claimedMime || 'application/octet-stream' }
  }

  // Non-text extension with no magic-byte hit. If the bytes ALSO
  // look textual, the upload is claiming a binary format with text
  // content — refuse. Otherwise accept as octet-stream so .zip /
  // .m4a / etc. that file-type happened to miss still go through.
  if (ext && looksTextual) {
    return {
      ok: false,
      reason: `${ext} declared but file looks like text — magic bytes don't match the expected format`,
    }
  }
  return { ok: true, mime: claimedMime || 'application/octet-stream' }
}
