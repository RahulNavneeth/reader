import { describe, it, expect } from 'vitest'
import {
  outline,
  outlineForTool,
  findSection,
  getSection,
  replaceSection,
  insertAfter,
  deleteSection,
  appendText,
  prependText,
} from './mdx.js'

/**
 * Regression coverage for the section-aware markdown helpers that
 * back the MCP granular-edit tools. Every documented edge case
 * the audit pass identified is locked down here.
 */

describe('outline', () => {
  it('returns an empty list when the doc has no headings', () => {
    expect(outline('just a paragraph')).toEqual([])
  })

  it('captures level + heading text + line span', () => {
    const doc = '# T\nintro\n## A\nbody\n## B\nbody'
    const o = outline(doc)
    expect(o).toHaveLength(3)
    expect(o[0]).toMatchObject({ level: 1, heading: 'T', startLine: 0 })
    expect(o[1]).toMatchObject({ level: 2, heading: 'A', startLine: 2 })
    expect(o[2]).toMatchObject({ level: 2, heading: 'B', startLine: 4 })
  })

  it('treats # inside fenced code blocks as content, not headings', () => {
    const doc = ['# Real', '', '```md', '## Fake', '```', '', '## After'].join('\n')
    const heads = outline(doc).map((h) => h.heading)
    expect(heads).toEqual(['Real', 'After'])
  })

  it('respects opening-fence length for closing — 3 ticks do NOT close a 4-tick fence', () => {
    const doc = [
      '# Real',
      '',
      '````md', // 4 backticks open
      '```', // 3 backticks: looks like a close but shouldn't be
      '## StillFake',
      '````', // 4 backticks: real close
      '',
      '## After',
    ].join('\n')
    const heads = outline(doc).map((h) => h.heading)
    expect(heads).toEqual(['Real', 'After'])
  })

  it('handles tilde-fenced blocks independently from backtick fences', () => {
    const doc = ['~~~md', '## Inside', '~~~', '## Outside'].join('\n')
    const heads = outline(doc).map((h) => h.heading)
    expect(heads).toEqual(['Outside'])
  })

  it('ignores escaped # at start of line', () => {
    // CommonMark: \# is literal text, not a heading
    expect(outline('\\# Not a heading\n## Real')).toEqual([
      expect.objectContaining({ heading: 'Real' }),
    ])
  })

  it('preserves headings with special characters (C#, emoji, punctuation)', () => {
    const doc = '## C# language\n## 📦 Boxes\n## Section: "Quoted"'
    const heads = outline(doc).map((h) => h.heading)
    expect(heads).toEqual(['C# language', '📦 Boxes', 'Section: "Quoted"'])
  })

  it('strips trailing #s from ATX-closed headings', () => {
    expect(outline('## A ##')[0].heading).toBe('A')
    expect(outline('### B ###')[0].heading).toBe('B')
  })
})

describe('outlineForTool', () => {
  it('1-indexes line numbers for human-friendliness', () => {
    const o = outlineForTool('# Title\n\n## A')
    expect(o[0].line).toBe(1)
    expect(o[1].line).toBe(3)
  })

  it('disambiguates duplicate slugs by appending -1, -2 like rehype-slug', () => {
    const doc = '## Notes\n## Notes\n## Notes'
    const o = outlineForTool(doc)
    expect(o.map((s) => s.slug)).toEqual(['notes', 'notes-1', 'notes-2'])
  })

  it('produces lowercased, hyphen-separated slugs', () => {
    expect(outlineForTool('## Hello World!')[0].slug).toBe('hello-world')
    expect(outlineForTool('## C# Language')[0].slug).toBe('c-language')
  })
})

describe('findSection / getSection', () => {
  const doc = '# T\n\n## A\nA body.\n\n## B\nB body.\n\n### B.1\nB.1 body.\n\n## C\nC body.'

  it('finds by exact heading text', () => {
    expect(findSection(doc, 'A')?.level).toBe(2)
    expect(findSection(doc, 'B.1')?.level).toBe(3)
  })

  it('returns null for unknown heading', () => {
    expect(findSection(doc, 'X')).toBeNull()
  })

  it('matches case-sensitively', () => {
    expect(findSection(doc, 'a')).toBeNull()
  })

  it('trims whitespace from the query', () => {
    expect(findSection(doc, '  A  ')?.heading).toBe('A')
  })

  it('includes nested sub-sections in getSection body', () => {
    // Section B owns B.1 because B.1 is deeper-nested.
    expect(getSection(doc, 'B')).toContain('### B.1')
    expect(getSection(doc, 'B')).toContain('B.1 body.')
  })

  it('returns null for missing heading', () => {
    expect(getSection(doc, 'X')).toBeNull()
  })

  it('returns the title section as the whole rest of the doc', () => {
    const body = getSection(doc, 'T')
    expect(body).toContain('## A')
    expect(body).toContain('## C')
  })
})

describe('replaceSection', () => {
  const doc = '# T\n\n## A\nold body.\n\n## B\nB body.'

  it('replaces the body and keeps the heading line', () => {
    const out = replaceSection(doc, 'A', 'new body line 1\nline 2')
    expect(out).toContain('## A\nnew body line 1\nline 2\n')
    expect(out).toContain('## B\nB body.')
    expect(out).not.toContain('old body')
  })

  it('replacing with empty content leaves the heading with an empty body', () => {
    const out = replaceSection(doc, 'A', '')
    expect(out).toContain('## A\n\n## B')
  })

  it('throws on missing heading', () => {
    expect(() => replaceSection(doc, 'X', 'body')).toThrow(/Heading not found/)
  })

  it('replacing a section with nested children removes the children', () => {
    const nested = '## A\nold\n### A.1\nchild\n\n## B\nb'
    const out = replaceSection(nested, 'A', 'new')
    expect(out).not.toContain('A.1')
    expect(out).toContain('## A\nnew\n')
  })
})

describe('insertAfter', () => {
  const doc = '# T\n\n## A\nA body.\n\n## B\nB body.'

  it('inserts after the matched section + its body', () => {
    const out = insertAfter(doc, 'A', '## A.5\nInserted.')
    // A.5 should appear between A's body and B
    const aIdx = out.indexOf('## A\n')
    const a5Idx = out.indexOf('## A.5')
    const bIdx = out.indexOf('## B\n')
    expect(aIdx).toBeLessThan(a5Idx)
    expect(a5Idx).toBeLessThan(bIdx)
  })

  it('throws on missing heading', () => {
    expect(() => insertAfter(doc, 'X', 'foo')).toThrow(/Heading not found/)
  })

  it('inserts after the last section when targeting the last heading', () => {
    const out = insertAfter(doc, 'B', '## C\nNew tail.')
    expect(out).toMatch(/## B\nB body\.[\s\S]*## C\nNew tail\./)
  })
})

describe('deleteSection', () => {
  const doc = '# T\n\n## A\nA body.\n\n## B\nB body.\n\n## C\nC body.'

  it('removes heading line and its body together', () => {
    const out = deleteSection(doc, 'B')
    expect(out).not.toContain('## B')
    expect(out).not.toContain('B body.')
    expect(out).toContain('## A')
    expect(out).toContain('## C')
  })

  it('removes nested sub-sections along with the parent', () => {
    const nested = '## A\n\n### A.1\nchild\n\n## B\nb'
    const out = deleteSection(nested, 'A')
    expect(out).not.toContain('## A')
    expect(out).not.toContain('A.1')
    expect(out).toContain('## B')
  })

  it('throws on missing heading', () => {
    expect(() => deleteSection(doc, 'X')).toThrow(/Heading not found/)
  })
})

describe('prependText with YAML frontmatter', () => {
  it('prepends AFTER the closing --- when frontmatter is present', () => {
    const doc = '---\ntitle: Foo\nslug: bar\n---\n\n# Heading\nbody.'
    const out = prependText(doc, '## Status\nDraft')
    // Frontmatter intact at the top
    expect(out.startsWith('---\ntitle: Foo')).toBe(true)
    // Status block lives between frontmatter and the original heading
    const fmEnd = out.indexOf('\n---\n', 4) + 4
    const statusIdx = out.indexOf('## Status')
    const headingIdx = out.indexOf('# Heading')
    expect(statusIdx).toBeGreaterThan(fmEnd)
    expect(statusIdx).toBeLessThan(headingIdx)
  })

  it('accepts TOML-style +++ as a frontmatter marker', () => {
    const doc = '+++\ntitle = "Foo"\n+++\n\n# Heading'
    const out = prependText(doc, '## After')
    expect(out.startsWith('+++\ntitle')).toBe(true)
    expect(out.indexOf('## After')).toBeGreaterThan(out.indexOf('\n+++\n', 4))
  })

  it('falls back to true prepend when no frontmatter is present', () => {
    expect(prependText('# Heading', 'head')).toBe('head\n\n# Heading')
  })

  it('treats an unclosed --- as no frontmatter', () => {
    // First line is `---` but there's no matching close; we should
    // NOT treat the whole doc as frontmatter and prepend normally.
    const doc = '---\nthis looks like frontmatter but never closes\n# Heading'
    const out = prependText(doc, 'head')
    expect(out.startsWith('head')).toBe(true)
  })
})

describe('appendText / prependText', () => {
  it('appendText separates with a blank line', () => {
    expect(appendText('# X', 'tail')).toBe('# X\n\ntail\n')
  })

  it('appendText preserves an existing trailing newline', () => {
    expect(appendText('# X\n', 'tail')).toBe('# X\n\ntail\n')
  })

  it('prependText separates with a blank line', () => {
    expect(prependText('# X', 'head')).toBe('head\n\n# X')
  })

  it('appendText on an empty doc lands cleanly', () => {
    // Two leading newlines are cosmetic but acceptable; what
    // matters is that the content is appended.
    const out = appendText('', 'first line')
    expect(out.trimStart()).toBe('first line\n')
  })
})
