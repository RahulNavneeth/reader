import { describe, it, expect } from 'vitest'
import { validateUpload } from './uploadGuard.js'

/**
 * Regression coverage for the magic-byte upload guard, including
 * the "binary extension claimed but bytes are text" case the MCP
 * upload_file smoke surfaced.
 */

// Minimal real PNG header (8-byte signature + IHDR start).
const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const HTML = Buffer.from('<!DOCTYPE html><html><body>hi</body></html>', 'utf8')
const MARKDOWN = Buffer.from('# heading\n\nbody\n', 'utf8')
const BIN_NO_MAGIC = Buffer.concat([
  Buffer.from('OOPSNOMAGIC'),
  Buffer.alloc(64, 0xff), // 0xff is binary-y, NOT nul
  Buffer.alloc(8), // some actual nul bytes so the probe sees binary
])

describe('validateUpload', () => {
  it('accepts a PNG with a .png extension', async () => {
    const r = await validateUpload(PNG_HEADER, 'photo.png', 'image/png')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mime).toMatch(/png/)
  })

  it('refuses HTML claiming .png extension (the upload_file smoke case)', async () => {
    const r = await validateUpload(HTML, 'fake.png', 'image/png')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/looks like text|doesn't match/i)
  })

  it('refuses HTML claiming .jpg extension', async () => {
    const r = await validateUpload(HTML, 'fake.jpg', 'image/jpeg')
    expect(r.ok).toBe(false)
  })

  it('refuses HTML claiming .pdf extension', async () => {
    const r = await validateUpload(HTML, 'fake.pdf', 'application/pdf')
    expect(r.ok).toBe(false)
  })

  it('accepts markdown with .md extension', async () => {
    const r = await validateUpload(MARKDOWN, 'note.md')
    expect(r.ok).toBe(true)
  })

  it('refuses a binary blob claiming .md extension', async () => {
    const r = await validateUpload(BIN_NO_MAGIC, 'fake.md', 'text/markdown')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/looks binary/)
  })

  it('refuses extension/magic mismatch (PNG bytes uploaded as .jpg)', async () => {
    const r = await validateUpload(PNG_HEADER, 'mismatch.jpg', 'image/jpeg')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/doesn't match/)
  })

  it('accepts jpg/jpeg alias', async () => {
    // Minimal JPEG SOI marker.
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex')
    const r = await validateUpload(jpeg, 'photo.jpeg', 'image/jpeg')
    expect(r.ok).toBe(true)
  })

  it('accepts an extension-less file as octet-stream', async () => {
    const r = await validateUpload(BIN_NO_MAGIC, 'mystery', undefined)
    // No extension to disagree with; we have to take it.
    expect(r.ok).toBe(true)
  })
})
