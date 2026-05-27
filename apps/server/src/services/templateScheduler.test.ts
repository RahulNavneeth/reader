import { describe, it, expect } from 'vitest'
import { firedBetween, nextFireAfter } from './templateScheduler.js'

describe('templateScheduler — cron math', () => {
  it('parses a standard 5-field cron and projects forward', () => {
    // 6 AM Mon + Thu
    const next = nextFireAfter('0 6 * * 1,4', new Date('2026-05-27T00:00:00Z'))
    expect(next).not.toBeNull()
    expect(next!.getTime()).toBeGreaterThan(new Date('2026-05-27T00:00:00Z').getTime())
  })

  it('returns null for malformed cron', () => {
    expect(nextFireAfter('not a cron', new Date())).toBeNull()
    expect(nextFireAfter('* * * * * * *', new Date())).toBeNull()
  })

  it('firedBetween: true when next fire lands in the window', () => {
    // 06:00 Monday — a window straddling that moment should fire.
    const prev = new Date('2026-05-25T05:59:00Z') // Mon 05:59 UTC
    const now = new Date('2026-05-25T06:01:00Z') // Mon 06:01 UTC
    // Use a cron tied to UTC by aligning the test with the local
    // timezone the parser uses (system tz). To keep this stable
    // we use `*/1 * * * *` — fires every minute — so any 2-min
    // window definitely contains a fire.
    expect(firedBetween('*/1 * * * *', prev, now)).toBe(true)
  })

  it('firedBetween: false when no fire lands in the window', () => {
    const prev = new Date('2026-05-25T06:01:00Z')
    const now = new Date('2026-05-25T06:02:30Z')
    // Daily at 03:00 — not in this 90s window.
    expect(firedBetween('0 3 * * *', prev, now)).toBe(false)
  })

  it('firedBetween: exclusive on the lower bound, inclusive on the upper', () => {
    // Cron `*/1` fires at every minute boundary. A window that
    // starts AT the boundary 06:00:00 shouldn't double-fire on it
    // — the next fire after prev=06:00:00 is 06:01:00. With now=
    // 06:00:30, no fire ≤ now.
    const prev = new Date('2026-05-25T06:00:00Z')
    const now = new Date('2026-05-25T06:00:30Z')
    expect(firedBetween('*/1 * * * *', prev, now)).toBe(false)
  })
})
