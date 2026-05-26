import { describe, it, expect } from 'vitest'
import { applyTemplate, applyTemplateAsync } from './templateEngine.js'

describe('templateEngine', () => {
  it('substitutes flat vars', () => {
    expect(applyTemplate('Hello {{name}}', { name: 'Rahul' })).toBe('Hello Rahul')
  })

  it('leaves unknown placeholders intact', () => {
    expect(applyTemplate('Hello {{name}}', {})).toBe('Hello {{name}}')
  })

  it('renders #if when truthy', () => {
    expect(applyTemplate('{{#if x}}yes{{/if}}', { x: '1' })).toBe('yes')
  })

  it('skips #if when value is empty', () => {
    expect(applyTemplate('a{{#if x}}yes{{/if}}b', { x: '' })).toBe('ab')
    expect(applyTemplate('a{{#if x}}yes{{/if}}b', {})).toBe('ab')
  })

  it('treats "false"/"0"/"no" as falsy', () => {
    expect(applyTemplate('{{#if x}}y{{else}}n{{/if}}', { x: 'false' })).toBe('n')
    expect(applyTemplate('{{#if x}}y{{else}}n{{/if}}', { x: '0' })).toBe('n')
    expect(applyTemplate('{{#if x}}y{{else}}n{{/if}}', { x: 'NO' })).toBe('n')
  })

  it('honours #if/else', () => {
    expect(applyTemplate('{{#if x}}y{{else}}n{{/if}}', { x: '1' })).toBe('y')
    expect(applyTemplate('{{#if x}}y{{else}}n{{/if}}', { x: '' })).toBe('n')
  })

  it('supports negation with !', () => {
    expect(applyTemplate('{{#if !x}}absent{{/if}}', { x: '' })).toBe('absent')
    expect(applyTemplate('{{#if !x}}absent{{/if}}', { x: 'y' })).toBe('')
  })

  it('iterates a comma-separated list with {{this}}', () => {
    expect(applyTemplate('{{#each items}}- {{this}}\n{{/each}}', { items: 'a, b, c' })).toBe(
      '- a\n- b\n- c\n',
    )
  })

  it('iterates a newline-separated list', () => {
    expect(
      applyTemplate('{{#each items}}- {{this}}\n{{/each}}', { items: 'a\nb\nc' }),
    ).toBe('- a\n- b\n- c\n')
  })

  it('exposes @index and @index1 inside #each', () => {
    expect(
      applyTemplate('{{#each xs}}[{{@index}}|{{@index1}}|{{this}}]{{/each}}', { xs: 'a,b' }),
    ).toBe('[0|1|a][1|2|b]')
  })

  it('skips #each on missing var', () => {
    expect(applyTemplate('pre{{#each xs}}{{this}}{{/each}}post', {})).toBe('prepost')
  })

  it('nests #if inside #each', () => {
    const src = '{{#each xs}}{{#if highlight}}*{{/if}}{{this}}{{#if highlight}}*{{/if}}\n{{/each}}'
    expect(applyTemplate(src, { xs: 'a,b', highlight: '1' })).toBe('*a*\n*b*\n')
  })

  it('nests #each inside #if', () => {
    const src = '{{#if show}}{{#each xs}}{{this}}/{{/each}}{{/if}}'
    expect(applyTemplate(src, { xs: 'a,b,c', show: 'true' })).toBe('a/b/c/')
    expect(applyTemplate(src, { xs: 'a,b,c', show: '' })).toBe('')
  })

  it('throws on unterminated #if', () => {
    expect(() => applyTemplate('{{#if x}}oops', { x: '1' })).toThrow(/Unterminated/)
  })

  it('throws on stray closer', () => {
    expect(() => applyTemplate('hi {{/if}} bye', {})).toThrow(/Stray/)
  })

  it('refuses sync render when template uses {{> include}}', () => {
    expect(() => applyTemplate('a {{> foo.md}} b', {})).toThrow(/applyTemplateAsync/)
  })

  it('refuses sync render when template uses {{fetch}}', () => {
    expect(() => applyTemplate('a {{fetch url="x"}} b', {})).toThrow(/applyTemplateAsync/)
  })
})

describe('templateEngine async', () => {
  it('inlines a vault include', async () => {
    const out = await applyTemplateAsync('Header\n{{> body.md}}\nFooter\n', {}, {
      loadInclude: async (p) => {
        expect(p).toBe('body.md')
        return 'middle line'
      },
    })
    expect(out).toBe('Header\nmiddle line\nFooter\n')
  })

  it('substitutes vars inside an included partial', async () => {
    const out = await applyTemplateAsync('{{> hi.md}}', { who: 'Rahul' }, {
      loadInclude: async () => 'Hello {{who}}!',
    })
    expect(out).toBe('Hello Rahul!')
  })

  it('passes the section name through to the resolver', async () => {
    let called: { p: string; s: string | undefined } | null = null
    await applyTemplateAsync('{{> doc.md section="Status"}}', {}, {
      loadInclude: async (p, s) => {
        called = { p, s }
        return ''
      },
    })
    expect(called).toEqual({ p: 'doc.md', s: 'Status' })
  })

  it('recurses through nested includes', async () => {
    const out = await applyTemplateAsync('A{{> a.md}}Z', {}, {
      loadInclude: async (p) => {
        if (p === 'a.md') return 'B{{> b.md}}Y'
        if (p === 'b.md') return 'C'
        return ''
      },
    })
    expect(out).toBe('ABCYZ')
  })

  it('caps recursion at maxDepth', async () => {
    await expect(
      applyTemplateAsync('{{> a.md}}', {}, {
        maxDepth: 2,
        loadInclude: async () => '{{> a.md}}',
      }),
    ).rejects.toThrow(/depth exceeded/)
  })

  it('inlines a fetch result as text', async () => {
    const out = await applyTemplateAsync('Body: {{fetch url="https://example.test/x"}}', {}, {
      loadFetch: async (u) => `<${u}>`,
    })
    expect(out).toBe('Body: <https://example.test/x>')
  })

  it('treats fetched content as opaque text (not parsed as template)', async () => {
    const out = await applyTemplateAsync(
      'Out: {{fetch url="x"}}',
      { secret: 'TOPSECRET' },
      { loadFetch: async () => '{{secret}}' },
    )
    // The literal `{{secret}}` from the fetch body must not be
    // substituted — that's the SSRF-adjacent risk we're avoiding.
    expect(out).toBe('Out: {{secret}}')
  })

  it('throws when include is used without resolver', async () => {
    await expect(applyTemplateAsync('{{> x.md}}', {}, {})).rejects.toThrow(/no resolver/)
  })

  it('throws when fetch is used without resolver', async () => {
    await expect(
      applyTemplateAsync('{{fetch url="x"}}', {}, {}),
    ).rejects.toThrow(/no resolver/)
  })
})
