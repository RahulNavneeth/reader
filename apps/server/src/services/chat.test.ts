import { describe, it, expect } from 'vitest'
import {
  retrieveAnchorSections,
  matchDocsByName,
  flattenMarkdownTables,
  formatSourceHint,
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
