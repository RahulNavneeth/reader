import { describe, expect, it } from 'vitest'
import { chunkText } from './chunk.js'

describe('chunkText', () => {
  it('returns an empty array for empty / whitespace input', () => {
    expect(chunkText('', 100, 10)).toEqual([])
    expect(chunkText('   \n\n  ', 100, 10)).toEqual([])
  })

  it('returns the input unchanged when it fits in one chunk', () => {
    expect(chunkText('hello world', 100, 10)).toEqual(['hello world'])
  })

  it('splits on paragraph boundaries first', () => {
    const text = ['para one', 'para two', 'para three'].join('\n\n')
    const chunks = chunkText(text, 18, 0)
    // Each para is shorter than the cap, but two together would
    // exceed it, so each chunk holds whatever fits.
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join(' ')).toContain('para one')
    expect(chunks.join(' ')).toContain('para three')
  })

  it('falls back to sentence splitting for oversized paragraphs', () => {
    const big = 'First sentence. Second sentence. Third sentence.'
    const chunks = chunkText(big, 20, 0)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40) // 20 + overlap slack
  })

  it('hard-cuts a single sentence longer than the cap', () => {
    const huge = 'a'.repeat(250)
    const chunks = chunkText(huge, 50, 0)
    expect(chunks.length).toBe(5)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50)
  })

  it('overlaps consecutive chunks by the configured tail', () => {
    const text = ['alpha block one', 'beta block two'].join('\n\n')
    const chunks = chunkText(text, 16, 5)
    expect(chunks.length).toBe(2)
    // Second chunk starts with the last 5 chars of the first chunk.
    const tail = chunks[0].slice(-5)
    expect(chunks[1].startsWith(tail)).toBe(true)
  })

  it('normalizes CRLF line endings', () => {
    const out = chunkText('line\r\nline', 100, 0)
    expect(out).toEqual(['line\nline'])
  })
})
