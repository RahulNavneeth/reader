import { describe, it, expect } from 'vitest'
import {
  retrieveAnchorSections,
  matchDocsByName,
  flattenMarkdownTables,
  formatSourceHint,
  parseProposedEdits,
  stripProposedEditBlocks,
  detectEditIntent,
  extractQuotedExcerpt,
  locateHeadingForExcerpt,
  stripInstructionEcho,
} from './chat.js'
import type { DocumentMeta } from '../types.js'

/**
 * Regression coverage for the markdown section-name matcher. The
 * embedding-based focus retrieval kept dragging in too much context
 * when the user asked about a specific subsection — this matcher
 * exists so a question like "explain Scenario B" returns the exact
 * Scenario B body verbatim from the doc.
 */

const meta: DocumentMeta = {
  id: 'd1',
  title: 'projection',
  originalFilename: 'projection.md',
  mime: 'text/markdown',
  bytes: 0,
  sha256: '',
  storageKey: 'projection.md',
  owner: 'alice',
  acl: { readers: [], editors: [] },
  publicExpiresAt: null,
  publicPasswordHash: null,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
  ingest: { status: 'ready', embedded: true },
}

const doc = `# Portfolio — long-term projection

Some intro about the portfolio strategy.

## Return assumptions

Long-term, INR, nominal.

## Scenario A — flat SIPs

In this scenario we don't step up the SIPs at all. Returns are flat.

## Scenario B — 15% step-up SIPs

Each year the SIP is increased by 15% to compound the contribution
rate. This scenario projects ~₹1.6Cr by year 15 at the assumed
return rates.

## Scenario C — step-up + windfalls

Adds in lumpy windfalls per the rule below.

## Caveats

This is a long-term projection. Markets vary.
`

describe('retrieveAnchorSections', () => {
  it('extracts the Scenario B section when the user asks about scenario B', () => {
    const r = retrieveAnchorSections('Explain me about Scenario B and how is it tied to portfolio target', meta, doc)
    expect(r.length).toBeGreaterThan(0)
    const titles = r.map((c) => c.text.split('\n')[0])
    expect(titles[0]).toMatch(/Scenario B/)
    // Body should include the actual scenario content, not Scenario A or C.
    expect(r[0].text).toMatch(/15% step-up/)
    expect(r[0].text).not.toMatch(/^## Scenario A/m)
  })

  it('returns empty for a query that doesn\'t name any section', () => {
    const r = retrieveAnchorSections('hi how are you', meta, doc)
    expect(r).toEqual([])
  })

  it('returns empty for a non-markdown doc', () => {
    const r = retrieveAnchorSections('Scenario B', meta, 'no headings here just prose')
    expect(r).toEqual([])
  })

  it('caps at 3 matched sections so we don\'t flood the prompt', () => {
    const r = retrieveAnchorSections('scenario A scenario B scenario C', meta, doc)
    expect(r.length).toBeLessThanOrEqual(3)
  })

  it('matches on a 2-word phrase even when individual tokens overlap with stopwords', () => {
    const r = retrieveAnchorSections('return assumptions', meta, doc)
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].text).toMatch(/Return assumptions/)
  })
})

/**
 * Doc-name matcher: when the user's query literally references
 * another doc in the vault (e.g. "tied to the portfolio target"),
 * we want that doc's chunks force-included in the RAG retrieval
 * — otherwise a third doc that merely mentions the target's
 * filename can outrank the actual target on raw cosine.
 */
describe('matchDocsByName', () => {
  const make = (overrides: Partial<DocumentMeta>): DocumentMeta => ({
    id: overrides.id ?? 'd?',
    title: overrides.title ?? '',
    originalFilename: overrides.originalFilename ?? '',
    mime: 'text/markdown',
    bytes: 0,
    sha256: '',
    storageKey: overrides.storageKey ?? '',
    owner: 'alice',
    acl: { readers: [], editors: [] },
    publicExpiresAt: null,
    publicPasswordHash: null,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ingest: { status: 'ready', embedded: true },
    ...overrides,
  })
  const docs: DocumentMeta[] = [
    make({ id: 'A', title: 'portfolio-target', originalFilename: 'portfolio-target.md', storageKey: 'investments/portfolio-target.md' }),
    make({ id: 'B', title: 'projection', originalFilename: 'projection.md', storageKey: 'investments/projection.md' }),
    make({ id: 'C', title: 'index', originalFilename: 'index.md', storageKey: 'investments/index.md' }),
  ]

  it('matches "portfolio target" (space form) to portfolio-target.md', () => {
    const r = matchDocsByName('how is it tied to the portfolio target', docs, 'B')
    expect(r.has('A')).toBe(true)
  })

  it('matches "portfolio-target" (hyphen form) too', () => {
    const r = matchDocsByName('see portfolio-target for the allocation', docs, 'B')
    expect(r.has('A')).toBe(true)
  })

  it('excludes the anchor doc from its own match list', () => {
    const r = matchDocsByName('tell me about projection', docs, 'B')
    expect(r.has('B')).toBe(false)
  })

  it('does not match unnamed docs', () => {
    const r = matchDocsByName('what is the weather today', docs, 'B')
    expect(r.size).toBe(0)
  })

  it('does not match on short names that could trigger false positives', () => {
    // 3-char title "go" wouldn't be allowed under the 4-char min.
    const shortDocs = [...docs, make({ id: 'D', title: 'go', originalFilename: 'go.md', storageKey: 'go.md' })]
    const r = matchDocsByName('please go to the store', shortDocs, 'B')
    expect(r.has('D')).toBe(false)
  })
})

/**
 * Table flattening for small-model consumption. Pipe-delimited
 * GFM tables are unreliable for sub-3B models; appending a prose
 * version lets the model still answer questions about row data.
 */
describe('flattenMarkdownTables', () => {
  it('appends a prose flattening after a simple 2-column table', () => {
    const md = `Some intro.

| Lever | Effect |
| --- | --- |
| Increase SIP by ₹10K | FI age 40 → 36 |
| Avoid lifestyle inflation | FI shifts 2-3 yrs earlier |

Tail prose.`
    const r = flattenMarkdownTables(md)
    expect(r).toContain('| Lever | Effect |')
    expect(r).toContain('Table contents in plain English:')
    expect(r).toContain('Lever: Increase SIP by ₹10K. Effect: FI age 40 → 36')
    expect(r).toContain('Lever: Avoid lifestyle inflation')
    expect(r).toContain('Tail prose.')
  })

  it('passes non-table content through untouched', () => {
    const md = `## Heading\n\nJust prose, no tables.\n\n- bullet 1\n- bullet 2`
    expect(flattenMarkdownTables(md)).toBe(md)
  })

  it('handles a table with missing trailing pipes', () => {
    const md = `| a | b |\n| - | - |\n| x | y |`
    const r = flattenMarkdownTables(md)
    expect(r).toContain('a: x. b: y')
  })

  it('skips a row-like line that lacks a separator (not a real table)', () => {
    const md = `| this | looks |\nlike a table but no separator.`
    expect(flattenMarkdownTables(md)).toBe(md)
  })

  it('handles a 3-column table', () => {
    const md = `| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |`
    const r = flattenMarkdownTables(md)
    expect(r).toContain('A: 1. B: 2. C: 3')
  })
})

/**
 * MIME-aware framing for the system prompt. Each source format
 * needs a one-line hint so the model knows it's looking at OCR'd
 * image text vs. extracted PDF text vs. a transcript, etc.
 */
describe('formatSourceHint', () => {
  const make = (overrides: Partial<DocumentMeta>): DocumentMeta => ({
    id: 'd',
    title: 't',
    originalFilename: 'f',
    mime: 'text/plain',
    bytes: 0,
    sha256: '',
    storageKey: 'f',
    owner: 'alice',
    acl: { readers: [], editors: [] },
    publicExpiresAt: null,
    publicPasswordHash: null,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ingest: { status: 'ready', embedded: true },
    ...overrides,
  })

  it('returns null for markdown', () => {
    expect(formatSourceHint(make({ mime: 'text/markdown', originalFilename: 'note.md' }))).toBeNull()
  })

  it('returns null for plain text', () => {
    expect(formatSourceHint(make({ mime: 'text/plain', originalFilename: 'log.txt' }))).toBeNull()
  })

  it('flags images as OCR-extracted', () => {
    const r = formatSourceHint(make({ mime: 'image/heic', originalFilename: 'IMG_8163.heic' }))
    expect(r).toMatch(/image/i)
    expect(r).toMatch(/OCR/i)
  })

  it('flags PDFs with the layout-flattening caveat', () => {
    const r = formatSourceHint(make({ mime: 'application/pdf', originalFilename: 'paper.pdf' }))
    expect(r).toMatch(/PDF/)
    expect(r).toMatch(/layout/i)
  })

  it('flags audio + video transcripts distinctly', () => {
    expect(formatSourceHint(make({ mime: 'audio/mpeg', originalFilename: 'a.mp3' }))).toMatch(/audio/i)
    expect(formatSourceHint(make({ mime: 'video/mp4', originalFilename: 'v.mp4' }))).toMatch(/video/i)
  })

  it('flags CSV/TSV with the header-row hint', () => {
    expect(formatSourceHint(make({ mime: 'text/csv', originalFilename: 'data.csv' }))).toMatch(/CSV/)
    expect(formatSourceHint(make({ originalFilename: 'data.tsv', mime: 'application/octet-stream' }))).toMatch(/TSV/)
  })

  it('flags spreadsheets', () => {
    const r = formatSourceHint(make({
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalFilename: 'book.xlsx',
    }))
    expect(r).toMatch(/spreadsheet/i)
  })

  it('flags JSON', () => {
    expect(formatSourceHint(make({ mime: 'application/json', originalFilename: 'data.json' }))).toMatch(/JSON/)
  })

  it('flags .docx', () => {
    const r = formatSourceHint(make({
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalFilename: 'doc.docx',
    }))
    expect(r).toMatch(/Word/)
  })

  it('flags HTML', () => {
    expect(formatSourceHint(make({ mime: 'text/html', originalFilename: 'page.html' }))).toMatch(/HTML/)
  })
})

/**
 * Structured-edit parser for in-chat document editing. The model
 * emits <proposed_edit> blocks in its streaming output; the parser
 * pulls them out as typed ops the server can persist + apply.
 */
describe('parseProposedEdits', () => {
  it('returns empty for content with no proposed_edit block', () => {
    expect(parseProposedEdits('Just a normal answer with no edits.')).toEqual([])
    expect(parseProposedEdits('')).toEqual([])
  })

  it('parses a replace_section op with multi-line body', () => {
    const body = `<proposed_edit op="replace_section" heading="Caveats">
This is a long-term projection. Markets vary; assumptions may not hold.
Recheck yearly.
</proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({
      op: 'replace_section',
      heading: 'Caveats',
      content: 'This is a long-term projection. Markets vary; assumptions may not hold.\nRecheck yearly.',
    })
  })

  it('parses an insert_after op carrying a new heading in the body', () => {
    const body = `<proposed_edit op="insert_after" heading="Scenario B">
## Scenario D — flat SIPs + windfalls
A hybrid scenario combining flat contributions with quarterly
windfall additions.
</proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
    expect(r[0].op).toBe('insert_after')
    if (r[0].op === 'insert_after') {
      expect(r[0].heading).toBe('Scenario B')
      expect(r[0].content).toContain('## Scenario D')
    }
  })

  it('parses delete_section with no body needed', () => {
    const body = `<proposed_edit op="delete_section" heading="Old Caveats"></proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({ op: 'delete_section', heading: 'Old Caveats' })
  })

  it('parses append_text and prepend_text (no heading)', () => {
    const body = `<proposed_edit op="append_text">
## Closing thought
The numbers above are estimates; revisit annually.
</proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
    expect(r[0].op).toBe('append_text')
    if (r[0].op === 'append_text') {
      expect(r[0].content).toContain('Closing thought')
    }
  })

  it('parses multiple proposed_edit blocks in one stream', () => {
    const body = `Here are two edits.

<proposed_edit op="replace_section" heading="A">new A body</proposed_edit>

Some intervening narration.

<proposed_edit op="delete_section" heading="B"></proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(2)
    expect(r[0].op).toBe('replace_section')
    expect(r[1].op).toBe('delete_section')
  })

  it('tolerates single-quoted attribute values', () => {
    const body = `<proposed_edit op='replace_section' heading='Notes'>new notes</proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
    if (r[0].op === 'replace_section') expect(r[0].heading).toBe('Notes')
  })

  it('skips section-ops with no heading attribute (malformed)', () => {
    const body = `<proposed_edit op="replace_section">no heading attr</proposed_edit>`
    expect(parseProposedEdits(body)).toEqual([])
  })

  it('skips unknown op (typo or hallucination)', () => {
    const body = `<proposed_edit op="rewrite_everything" heading="X">stuff</proposed_edit>`
    expect(parseProposedEdits(body)).toEqual([])
  })

  it('extracts blocks even when they are interleaved with prose', () => {
    const body = `Sure, here's the change.
<proposed_edit op="replace_section" heading="Intro">new intro body</proposed_edit>
Let me know if you want anything else.`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
  })

  it('preserves markdown table content inside the body', () => {
    const body = `<proposed_edit op="replace_section" heading="Data">
| A | B |
| - | - |
| 1 | 2 |
</proposed_edit>`
    const r = parseProposedEdits(body)
    expect(r).toHaveLength(1)
    if (r[0].op === 'replace_section') {
      expect(r[0].content).toContain('| A | B |')
      expect(r[0].content).toContain('| 1 | 2 |')
    }
  })
})

describe('stripProposedEditBlocks', () => {
  it('removes a single block and trims surrounding whitespace', () => {
    const body = `Sure.

<proposed_edit op="replace_section" heading="X">new</proposed_edit>

Apply if you like.`
    const r = stripProposedEditBlocks(body)
    expect(r).not.toContain('<proposed_edit')
    expect(r).toContain('Sure.')
    expect(r).toContain('Apply if you like.')
  })

  it('collapses 3+ blank lines that result from removal', () => {
    const body = `A\n\n<proposed_edit op="delete_section" heading="X"></proposed_edit>\n\nB`
    const r = stripProposedEditBlocks(body)
    // Should be "A\n\nB", not "A\n\n\n\nB".
    expect(r).toMatch(/^A\n\nB$/)
  })

  it('leaves non-edit content untouched', () => {
    const body = `Just a normal answer.`
    expect(stripProposedEditBlocks(body)).toBe(body)
  })

  it('removes multiple blocks', () => {
    const body = `<proposed_edit op="replace_section" heading="A">x</proposed_edit>
Some text.
<proposed_edit op="delete_section" heading="B"></proposed_edit>`
    const r = stripProposedEditBlocks(body)
    expect(r).not.toContain('<proposed_edit')
    expect(r).toContain('Some text.')
  })
})

describe('detectEditIntent', () => {
  it('fires on common edit verbs', () => {
    for (const q of [
      'rephrase this',
      'rewrite the Risks section',
      'edit this paragraph',
      'fix the typo in the second bullet',
      'improve this',
      'tighten this up',
      'shorten the intro',
      'add a TODO at the end',
      'append a note about Q3',
      'remove the third bullet',
      'delete the Risks section',
      'replace the table with prose',
      'make this more formal',
      'turn this into a bulleted list',
    ]) {
      expect(detectEditIntent(q), q).toBe(true)
    }
  })

  it('does NOT fire on pure explain / lookup intent', () => {
    for (const q of [
      'explain this',
      'summarize',
      'what does this mean?',
      'how does this work?',
      'why is this here?',
      'compare X and Y',
      'describe section 3',
      'what is the deadline?',
    ]) {
      expect(detectEditIntent(q), q).toBe(false)
    }
  })

  it('strips a leading blockquote before scanning — verbs inside the quote do NOT count', () => {
    // The Reply popover prepends a `> "..."` blockquote. If the
    // quote itself happens to say "add" or "remove", that's the
    // document's wording, not the user's request.
    const q = `> "The team should add a section on risks and remove the deprecated bullet."

what does this paragraph mean?`
    expect(detectEditIntent(q)).toBe(false)
  })

  it('fires when the freeform question after a quoted excerpt asks for an edit', () => {
    const q = `> "Tax planning — fully max ₹50K NPS-80CCD(1B)."

rephrase this`
    expect(detectEditIntent(q)).toBe(true)
  })

  it('returns false for empty / whitespace-only input', () => {
    expect(detectEditIntent('')).toBe(false)
    expect(detectEditIntent('   ')).toBe(false)
  })
})

describe('extractQuotedExcerpt', () => {
  it('extracts the quote when the message starts with a Reply blockquote', () => {
    const q = `> "Top up emergency fund to whatever 6× new monthly expenses looks like."

rephrase this`
    expect(extractQuotedExcerpt(q)).toBe('Top up emergency fund to whatever 6× new monthly expenses looks like.')
  })

  it('returns null when there is no leading blockquote', () => {
    expect(extractQuotedExcerpt('just rephrase the Risks section')).toBeNull()
  })

  it('returns null on an empty quote', () => {
    expect(extractQuotedExcerpt('> ""\n\nrephrase this')).toBeNull()
  })
})

describe('locateHeadingForExcerpt', () => {
  const doc = `# Tier 0 — Insurance

Make sure health + term insurance are sorted before anything else.

## Tier 1 — Emergency Fund

Top up emergency fund to whatever 6× new monthly expenses looks like.
Park it in liquid funds (not savings account).

## Tier 2 — Tax planning

Tax planning — fully max ₹50K NPS-80CCD(1B), then max ₹1.5L 80C (ELSS or PPF). These reduce tax on the windfall year.
`

  it('finds the heading whose section contains the excerpt', () => {
    expect(
      locateHeadingForExcerpt(doc, 'Top up emergency fund to whatever 6× new monthly expenses looks like.'),
    ).toBe('Tier 1 — Emergency Fund')
  })

  it('walks back through subheadings to the nearest one', () => {
    expect(
      locateHeadingForExcerpt(doc, 'fully max ₹50K NPS-80CCD(1B)'),
    ).toBe('Tier 2 — Tax planning')
  })

  it('tolerates whitespace differences between excerpt and doc', () => {
    expect(
      locateHeadingForExcerpt(doc, 'Top  up   emergency fund\nto whatever 6× new monthly expenses'),
    ).toBe('Tier 1 — Emergency Fund')
  })

  it('returns null when the excerpt is not in the doc', () => {
    expect(locateHeadingForExcerpt(doc, 'this string does not appear')).toBeNull()
  })

  it('returns null for an excerpt in the doc preamble before any heading', () => {
    const preambleDoc = `Just a top-of-doc line before any heading.

## Some Section

body text here.
`
    expect(locateHeadingForExcerpt(preambleDoc, 'Just a top-of-doc line')).toBeNull()
  })

  it('skips heading-shaped lines inside fenced code blocks', () => {
    const fencedDoc = `## Real Section

\`\`\`
## not-a-real-heading
some code
\`\`\`

target line lives in real section.
`
    expect(locateHeadingForExcerpt(fencedDoc, 'target line lives in real section')).toBe('Real Section')
  })
})

describe('stripInstructionEcho', () => {
  it('strips a trailing line that echoes the user instruction', () => {
    const response = `Tax drag is the slow erosion of returns caused by taxes on dividends and short-term gains.

explain it with simple words.`
    const out = stripInstructionEcho(response, 'explain it with simple words')
    expect(out).toBe('Tax drag is the slow erosion of returns caused by taxes on dividends and short-term gains.')
  })

  it('strips an echo at the end of the last sentence (no newline)', () => {
    const response = `Tax drag is the slow erosion of returns. explain it with simple words.`
    const out = stripInstructionEcho(response, 'explain it with simple words')
    expect(out).toBe('Tax drag is the slow erosion of returns.')
  })

  it('leaves the response untouched when the trailing line is informative', () => {
    const response = `Tax drag is the slow erosion of returns caused by taxes on dividends and short-term gains.

In an ELSS fund this is largely neutralised by the 80C deduction and the 1-year long-term capital gains regime.`
    const out = stripInstructionEcho(response, 'explain it with simple words')
    expect(out).toBe(response)
  })

  it('leaves the response untouched when the query has no useful tokens', () => {
    const response = `Some answer here.`
    expect(stripInstructionEcho(response, 'a the')).toBe(response)
  })

  it('returns empty string unchanged', () => {
    expect(stripInstructionEcho('', 'whatever')).toBe('')
  })

  it('handles a multi-line echo by running two passes', () => {
    const response = `Real answer here.

show me
the details please`
    const out = stripInstructionEcho(response, 'show me the details please')
    expect(out).toBe('Real answer here.')
  })
})
