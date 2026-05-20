import { describe, it, expect } from 'vitest'
import { isPrivateIp, parseDataUri, sanitizeUrlForLog } from './safeFetch.js'

/**
 * isPrivateIp is the SSRF gate — every public-fetch caller relies on
 * this list being exhaustive. Test the named ranges so a refactor
 * can't silently drop one.
 */
describe('isPrivateIp', () => {
  describe('IPv4 — must reject', () => {
    it.each([
      ['0.0.0.0'],
      ['0.1.2.3'],            // 0/8
      ['10.0.0.1'],           // 10/8 RFC1918
      ['10.255.255.255'],
      ['127.0.0.1'],          // loopback
      ['127.0.0.99'],
      ['169.254.169.254'],    // link-local (AWS metadata!)
      ['172.16.0.1'],         // 172.16/12
      ['172.31.255.255'],
      ['192.168.0.1'],        // 192.168/16
      ['192.168.255.255'],
      ['100.64.0.1'],         // CGNAT 100.64/10
      ['100.127.255.255'],
      ['224.0.0.1'],          // multicast
      ['239.255.255.255'],
      ['255.255.255.255'],    // broadcast / reserved
    ])('%s', (addr) => {
      expect(isPrivateIp(addr)).toBe(true)
    })
  })

  describe('IPv4 — must accept (public)', () => {
    it.each([
      ['1.1.1.1'],
      ['8.8.8.8'],
      ['172.15.0.1'],         // just below the 172.16 range
      ['172.32.0.1'],         // just above
      ['192.167.0.1'],        // just below 192.168
      ['100.63.255.255'],     // just below CGNAT 100.64
      ['100.128.0.1'],        // just above CGNAT 100.127
      ['223.255.255.255'],    // just below multicast 224
    ])('%s', (addr) => {
      expect(isPrivateIp(addr)).toBe(false)
    })
  })

  describe('IPv6 — must reject', () => {
    it.each([
      ['::1'],                                       // loopback
      ['::'],                                        // unspecified
      ['fe80::1'],                                   // link-local
      ['fc00::1'],                                   // ULA fc00::/7
      ['fd12:3456:789a::1'],
      ['ff02::1'],                                   // multicast
      ['::ffff:10.0.0.1'],                           // IPv4-mapped private
      ['::ffff:127.0.0.1'],                          // IPv4-mapped loopback
    ])('%s', (addr) => {
      expect(isPrivateIp(addr)).toBe(true)
    })
  })

  describe('IPv6 — must accept (public)', () => {
    it.each([
      ['2001:4860:4860::8888'],                      // Google DNS
      ['2606:4700:4700::1111'],                      // Cloudflare DNS
      ['::ffff:8.8.8.8'],                            // IPv4-mapped public
    ])('%s', (addr) => {
      expect(isPrivateIp(addr)).toBe(false)
    })
  })

  it('rejects unparseable input', () => {
    expect(isPrivateIp('not.an.ip')).toBe(true)
    expect(isPrivateIp('')).toBe(true)
  })
})

/**
 * Audit-log credential redaction. Embedded basic-auth (`user:pass@`)
 * gets surfaced wherever the URL is rendered, so the upload audit
 * log strips it before storing.
 */
describe('sanitizeUrlForLog', () => {
  it('strips user:pass from a basic-auth URL', () => {
    expect(sanitizeUrlForLog('https://alice:hunter2@example.com/file.png'))
      .toBe('https://example.com/file.png')
  })

  it('strips a token-only userinfo segment', () => {
    expect(sanitizeUrlForLog('https://token123@example.com/file.png'))
      .toBe('https://example.com/file.png')
  })

  it('passes plain URLs through untouched (modulo URL normalisation)', () => {
    expect(sanitizeUrlForLog('https://example.com/file.png'))
      .toBe('https://example.com/file.png')
  })

  it('preserves query strings while stripping credentials', () => {
    expect(sanitizeUrlForLog('https://u:p@example.com/x?k=v&token=abc'))
      .toBe('https://example.com/x?k=v&token=abc')
  })

  it('returns a sentinel on garbage input', () => {
    expect(sanitizeUrlForLog('not a url at all')).toBe('[invalid URL]')
  })
})

/**
 * Data-URI prefix stripping. upload_file is the only path that
 * needs this — agents and copy-paste flows routinely supply the
 * whole URI rather than the raw base64 segment.
 */
describe('parseDataUri', () => {
  it('extracts MIME + payload from a standard image data URI', () => {
    const r = parseDataUri('data:image/png;base64,iVBORw0KGgo=')
    expect(r).toEqual({ mime: 'image/png', data: 'iVBORw0KGgo=' })
  })

  it('handles data URIs without a MIME', () => {
    const r = parseDataUri('data:;base64,aGVsbG8=')
    expect(r?.mime).toBeUndefined()
    expect(r?.data).toBe('aGVsbG8=')
  })

  it('handles data URIs without ;base64', () => {
    const r = parseDataUri('data:text/plain,hello%20world')
    expect(r).toEqual({ mime: 'text/plain', data: 'hello%20world' })
  })

  it('tolerates parameter segments like ;charset=utf-8', () => {
    const r = parseDataUri('data:text/plain;charset=utf-8;base64,aGVsbG8=')
    expect(r).toEqual({ mime: 'text/plain', data: 'aGVsbG8=' })
  })

  it('returns null for raw base64 (the common case)', () => {
    expect(parseDataUri('iVBORw0KGgoAAAANSUhEUgAA')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseDataUri('')).toBeNull()
  })

  it('returns null for a string that merely starts with "data" but lacks the colon', () => {
    expect(parseDataUri('database://localhost')).toBeNull()
  })
})
