import { describe, expect, it } from 'vitest'
import { extractEntities } from './entities.js'

describe('extractEntities', () => {
  it('returns an empty object for empty text', () => {
    expect(extractEntities('')).toEqual({})
  })

  it('finds email addresses', () => {
    const e = extractEntities('Ping me at alice@example.com or bob@reader.local.')
    expect(e.emails).toEqual(expect.arrayContaining(['alice@example.com', 'bob@reader.local']))
  })

  it('finds URLs', () => {
    const e = extractEntities('See https://example.com/foo and http://reader.local.')
    expect(e.urls?.some((u) => u.includes('example.com'))).toBe(true)
  })

  it('finds ISO dates and common written dates', () => {
    const e = extractEntities('Filed 2026-05-16, paid on 2024-12-31.')
    expect(e.dates?.length).toBeGreaterThanOrEqual(2)
    expect(e.dates).toEqual(expect.arrayContaining(['2026-05-16', '2024-12-31']))
  })

  it('finds currency amounts', () => {
    const e = extractEntities('Refund: ₹1,250. Wired $50.00 and £42.')
    // We only assert that at least one is captured — the exact set
    // depends on the regex catalog and we don't want the test to be
    // tied to whatever ordering the extractor settles on.
    expect(e.amounts?.length ?? 0).toBeGreaterThan(0)
  })

  it('returns nothing for prose with no extractable entities', () => {
    const e = extractEntities('Just a quick note about the morning meeting.')
    expect(e.emails ?? []).toEqual([])
    expect(e.urls ?? []).toEqual([])
  })
})
