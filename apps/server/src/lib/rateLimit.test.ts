import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimit } from './rateLimit.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('createRateLimit', () => {
  it('allows up to `capacity` requests in a burst', () => {
    const rl = createRateLimit({ capacity: 3, refillPerSecond: 1 })
    expect(rl.check('1.1.1.1').allowed).toBe(true)
    expect(rl.check('1.1.1.1').allowed).toBe(true)
    expect(rl.check('1.1.1.1').allowed).toBe(true)
    expect(rl.check('1.1.1.1')).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it('refills tokens over time at the configured rate', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const rl = createRateLimit({ capacity: 2, refillPerSecond: 1 })
    rl.check('ip')
    rl.check('ip')
    expect(rl.check('ip').allowed).toBe(false)
    vi.setSystemTime(1500)
    // 1.5s × 1 token/s = 1.5 tokens — enough for one more call.
    expect(rl.check('ip').allowed).toBe(true)
    expect(rl.check('ip').allowed).toBe(false)
  })

  it('scopes the bucket per IP', () => {
    const rl = createRateLimit({ capacity: 1, refillPerSecond: 1 })
    expect(rl.check('a').allowed).toBe(true)
    expect(rl.check('a').allowed).toBe(false)
    expect(rl.check('b').allowed).toBe(true)
  })

  it('returns a sane retry-after for a fully drained bucket', () => {
    const rl = createRateLimit({ capacity: 1, refillPerSecond: 0.5 })
    rl.check('ip')
    const r = rl.check('ip')
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      // Need 1 token at 0.5/sec → 2s.
      expect(r.retryAfterSeconds).toBe(2)
    }
  })
})
