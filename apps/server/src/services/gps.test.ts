import { describe, expect, it } from 'vitest'
import { couldHaveGps, extractGps } from './gps.js'

describe('couldHaveGps', () => {
  it('accepts EXIF-capable image extensions', () => {
    for (const name of ['IMG.jpg', 'shot.JPEG', 'pic.heic', 'scan.tiff', 'frame.webp']) {
      expect(couldHaveGps(name), `${name} should be GPS-capable`).toBe(true)
    }
  })

  it('rejects everything else', () => {
    for (const name of ['note.md', 'movie.mp4', 'song.m4a', 'data.csv', 'README']) {
      expect(couldHaveGps(name), `${name} should NOT be GPS-capable`).toBe(false)
    }
  })
})

describe('extractGps', () => {
  it('returns undefined for non-image filenames (skips the parse)', async () => {
    const buf = Buffer.from('not an image')
    expect(await extractGps(buf, 'note.md')).toBeUndefined()
  })

  it('returns null when the bytes have no EXIF GPS', async () => {
    // exifr returns nothing for a junk buffer that's still a "GPS-
    // capable" extension. We cache the absence as null so future
    // calls don't re-parse.
    const buf = Buffer.from('not actually a jpeg')
    expect(await extractGps(buf, 'fake.jpg')).toBeNull()
  })
})
