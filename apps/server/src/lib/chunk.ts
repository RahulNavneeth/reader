/**
 * Character-based chunking. Greedy: pack paragraphs/sentences up to `maxChars`,
 * then start a new chunk that re-includes the last `overlap` characters of the
 * previous one. Cheap, language-agnostic, good enough for retrieval.
 */
export function chunkText(text: string, maxChars: number, overlap: number): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (cleaned.length === 0) return []
  if (cleaned.length <= maxChars) return [cleaned]

  // Split on paragraph boundaries first; if a paragraph exceeds maxChars,
  // fall back to sentence boundaries; if still too long, hard-cut.
  const segments = splitToSegments(cleaned, maxChars)

  const chunks: string[] = []
  let buf = ''
  for (const seg of segments) {
    if (buf.length === 0) {
      buf = seg
      continue
    }
    if (buf.length + seg.length + 2 <= maxChars) {
      buf += '\n\n' + seg
    } else {
      chunks.push(buf)
      const tail = overlap > 0 ? buf.slice(-overlap) : ''
      buf = (tail ? tail + '\n\n' : '') + seg
    }
  }
  if (buf.length) chunks.push(buf)
  return chunks
}

function splitToSegments(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= maxChars) {
      out.push(p)
      continue
    }
    // Long paragraph — split by sentences.
    const sentences = p.match(/[^.!?\n]+[.!?](?:\s|$)|[^.!?\n]+$/g) || [p]
    let buf = ''
    for (const s of sentences) {
      const t = s.trim()
      if (!t) continue
      if (t.length > maxChars) {
        if (buf) {
          out.push(buf)
          buf = ''
        }
        // Hard cut.
        for (let i = 0; i < t.length; i += maxChars) {
          out.push(t.slice(i, i + maxChars))
        }
        continue
      }
      if (buf.length + t.length + 1 <= maxChars) {
        buf = buf ? buf + ' ' + t : t
      } else {
        out.push(buf)
        buf = t
      }
    }
    if (buf) out.push(buf)
  }
  return out
}
