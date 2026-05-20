/**
 * Section-aware markdown manipulation. Powers the MCP granular-edit
 * tools (`get_outline`, `get_section`, `replace_section`,
 * `insert_after`, `delete_section`, `append_text`, `prepend_text`).
 *
 * Why a focused parser instead of a full mdast: every operation
 * here is line-keyed, identity-preserving, and stays inside the
 * original whitespace + formatting. A real AST round-trip would
 * normalize things the user wrote intentionally (loose vs. tight
 * lists, link reference defs, trailing whitespace) — exactly the
 * surprise a granular-edit tool needs to avoid.
 *
 * The parser only recognizes ATX headings (`#`, `##`, ...). Setext
 * headings (`Heading\n======`) are intentionally ignored — they're
 * rare in modern markdown and conflate readability tradeoffs we
 * don't want to inherit. ATX headings inside fenced code blocks
 * are also skipped so a `# python comment` inside ```python ... ```
 * doesn't get treated as a section boundary.
 *
 * Heading text is matched case-sensitively after trimming. If
 * multiple headings have the same text, the FIRST match wins; the
 * caller should disambiguate via more specific heading text.
 */

export type SectionRef = {
  level: number   // 1–6 (number of `#`)
  heading: string // text after the `#`s, trimmed
  /** Line index of the heading line itself. */
  startLine: number
  /** First line of the next sibling-or-ancestor heading. Exclusive. */
  endLine: number
  /** Line index of the first line of the body (heading + 1). */
  bodyStart: number
}

/**
 * Locate the heading lines in the document, skipping over fenced
 * code blocks so embedded "# whatever" comments don't get treated
 * as section boundaries.
 */
function findHeadings(lines: string[]): Array<{ level: number; heading: string; index: number }> {
  const out: Array<{ level: number; heading: string; index: number }> = []
  let inFence = false
  let fenceMarker = ''
  // CommonMark: closing fence must be at least as long as the open.
  // Tracking the opening length lets us reject a 3-tick close on a
  // 4-tick open and keep treating the inside as code.
  let fenceOpenLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^([`~]{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!inFence) {
        inFence = true
        fenceMarker = marker[0]
        fenceOpenLen = marker.length
      } else if (marker[0] === fenceMarker && marker.length >= fenceOpenLen) {
        inFence = false
        fenceMarker = ''
        fenceOpenLen = 0
      }
      continue
    }
    if (inFence) continue
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (!m) continue
    out.push({ level: m[1].length, heading: m[2].trim(), index: i })
  }
  return out
}

/** Build the flat outline. Sections come back in document order;
 *  use `nestedOutline` if a caller wants a tree. */
export function outline(text: string): SectionRef[] {
  const lines = text.split('\n')
  const heads = findHeadings(lines)
  const refs: SectionRef[] = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    // Section runs until the next heading at same OR higher level.
    let endLine = lines.length
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        endLine = heads[j].index
        break
      }
    }
    refs.push({
      level: h.level,
      heading: h.heading,
      startLine: h.index,
      endLine,
      bodyStart: h.index + 1,
    })
  }
  return refs
}

/** Find the first section whose heading text matches exactly. */
export function findSection(text: string, heading: string): SectionRef | null {
  const target = heading.trim()
  for (const s of outline(text)) {
    if (s.heading === target) return s
  }
  return null
}

/** Return just the body lines under the matched heading, joined
 *  back into a string. Returns null when the heading isn't found. */
export function getSection(text: string, heading: string): string | null {
  const ref = findSection(text, heading)
  if (!ref) return null
  const lines = text.split('\n')
  return lines.slice(ref.bodyStart, ref.endLine).join('\n')
}

/** Splice helper that returns the new text. `replaceLines` is
 *  [start, end) over the line array. */
function spliceLines(
  text: string,
  startLine: number,
  endLine: number,
  replacement: string[],
): string {
  const lines = text.split('\n')
  const before = lines.slice(0, startLine)
  const after = lines.slice(endLine)
  return [...before, ...replacement, ...after].join('\n')
}

/** Replace the body of the matched section (the heading line stays
 *  intact). Throws if the heading isn't found — MCP tools translate
 *  that into a structured error. */
export function replaceSection(
  text: string,
  heading: string,
  body: string,
): string {
  const ref = findSection(text, heading)
  if (!ref) throw new Error(`Heading not found: "${heading}"`)
  // The body lines we splice in. Trailing newline normalization:
  // ensure exactly one blank line at the end of the body so the
  // next heading isn't visually glued onto the last line.
  const bodyLines = body.split('\n')
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop()
  }
  bodyLines.push('') // single trailing blank
  return spliceLines(text, ref.bodyStart, ref.endLine, bodyLines)
}

/** Insert content immediately after the matched heading's body
 *  (i.e., at the start of the next sibling-or-ancestor heading).
 *  Useful for adding subsections under a section. */
export function insertAfter(
  text: string,
  heading: string,
  content: string,
): string {
  const ref = findSection(text, heading)
  if (!ref) throw new Error(`Heading not found: "${heading}"`)
  const insertion = content.split('\n')
  // Ensure a blank line before and after the inserted content so
  // it's separated from surrounding sections.
  if (insertion[0] !== '') insertion.unshift('')
  if (insertion[insertion.length - 1] !== '') insertion.push('')
  return spliceLines(text, ref.endLine, ref.endLine, insertion)
}

/** Drop the heading line and its body together. */
export function deleteSection(text: string, heading: string): string {
  const ref = findSection(text, heading)
  if (!ref) throw new Error(`Heading not found: "${heading}"`)
  return spliceLines(text, ref.startLine, ref.endLine, [])
}

/** Append content to the end of the document. Adds a separating
 *  blank line if the doc doesn't already end with one. */
export function appendText(text: string, content: string): string {
  let base = text
  if (!base.endsWith('\n')) base += '\n'
  if (!base.endsWith('\n\n')) base += '\n'
  let tail = content
  if (!tail.endsWith('\n')) tail += '\n'
  return base + tail
}

/** Prepend content to the start of the document. Inserts a blank
 *  line between the new content and the existing one. */
export function prependText(text: string, content: string): string {
  let head = content
  if (!head.endsWith('\n')) head += '\n'
  if (!head.endsWith('\n\n')) head += '\n'
  return head + text
}

/** Flat outline view for the MCP get_outline tool. Heading slugs
 *  match rehype-slug's algorithm closely enough that an agent can
 *  build `#anchor` URLs from them. */
export function outlineForTool(
  text: string,
): Array<{ level: number; heading: string; slug: string; line: number }> {
  return outline(text).map((s) => ({
    level: s.level,
    heading: s.heading,
    slug: slugify(s.heading),
    line: s.startLine + 1, // 1-indexed for human-friendliness
  }))
}

/** GitHub-style slugify: lowercase, replace non-alphanumerics with
 *  hyphens, collapse repeats, strip leading/trailing hyphens.
 *  Matches rehype-slug's default behavior for ATX headings. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
