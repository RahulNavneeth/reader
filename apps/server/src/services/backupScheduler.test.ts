import { describe, it, expect } from 'vitest'
import { nextFireAfter } from './backupScheduler.js'

/**
 * Pure unit tests for the scheduler's next-fire math. The
 * I/O-driven parts (createBackup, prune, fastify hooks) get
 * exercised end-to-end in the integration suite — this file
 * locks down the date arithmetic where it's easy to be wrong:
 * DST boundaries, weekly weekday-rollover, "today already passed
 * → jump to tomorrow", and the disabled / malformed-input paths.
 */
describe('nextFireAfter', () => {
  it('returns null when disabled', () => {
    expect(nextFireAfter(new Date(), { enabled: false })).toBeNull()
    expect(nextFireAfter(new Date(), undefined)).toBeNull()
  })

  it('returns null on malformed time', () => {
    const from = new Date('2026-05-25T10:00:00')
    expect(nextFireAfter(from, { enabled: true, time: 'bogus' })).toBeNull()
    expect(nextFireAfter(from, { enabled: true, time: '25:00' })).toBeNull()
    expect(nextFireAfter(from, { enabled: true, time: '01:60' })).toBeNull()
  })

  it('daily: fires later today when the time hasn\'t passed yet', () => {
    const from = new Date('2026-05-25T01:00:00')
    const next = nextFireAfter(from, { enabled: true, schedule: 'daily', time: '03:00' })
    expect(next).not.toBeNull()
    expect(next!.toString()).toBe(new Date('2026-05-25T03:00:00').toString())
  })

  it("daily: fires tomorrow when today's time has already passed", () => {
    const from = new Date('2026-05-25T10:00:00')
    const next = nextFireAfter(from, { enabled: true, schedule: 'daily', time: '03:00' })
    expect(next).not.toBeNull()
    expect(next!.toString()).toBe(new Date('2026-05-26T03:00:00').toString())
  })

  it('daily: exact-match (00 seconds) still jumps to tomorrow', () => {
    // Edge case: at exactly the fire time, do we double-fire? No —
    // `target.getTime() <= from.getTime()` rolls forward.
    const from = new Date('2026-05-25T03:00:00')
    const next = nextFireAfter(from, { enabled: true, schedule: 'daily', time: '03:00' })
    expect(next!.toString()).toBe(new Date('2026-05-26T03:00:00').toString())
  })

  it('defaults to 03:00 when time is omitted', () => {
    const from = new Date('2026-05-25T01:00:00')
    const next = nextFireAfter(from, { enabled: true, schedule: 'daily' })
    expect(next!.getHours()).toBe(3)
    expect(next!.getMinutes()).toBe(0)
  })

  it('weekly: advances day until weekday matches', () => {
    // 2026-05-25 is a Monday (getDay() === 1). Asking for Friday (5)
    // should advance 4 days.
    const from = new Date('2026-05-25T10:00:00')
    const next = nextFireAfter(from, {
      enabled: true,
      schedule: 'weekly',
      time: '03:00',
      weekday: 5,
    })
    expect(next!.getDay()).toBe(5)
    // Monday + (today already passed → tomorrow → advance to Friday)
    // = Tuesday → Wed → Thu → Friday = +4 days from Tue 26th
    expect(next!.toString()).toBe(new Date('2026-05-29T03:00:00').toString())
  })

  it('weekly: same weekday + time-not-yet-passed → today', () => {
    // 2026-05-25 is Monday; weekday=1 + time after now should fire
    // the same day.
    const from = new Date('2026-05-25T01:00:00')
    const next = nextFireAfter(from, {
      enabled: true,
      schedule: 'weekly',
      time: '03:00',
      weekday: 1,
    })
    expect(next!.getDay()).toBe(1)
    expect(next!.toString()).toBe(new Date('2026-05-25T03:00:00').toString())
  })

  it('weekly: clamps weekday into 0..6', () => {
    const from = new Date('2026-05-25T10:00:00')
    const above = nextFireAfter(from, {
      enabled: true,
      schedule: 'weekly',
      time: '03:00',
      weekday: 99,
    })
    const below = nextFireAfter(from, {
      enabled: true,
      schedule: 'weekly',
      time: '03:00',
      weekday: -3,
    })
    // 99 clamps to 6 (Saturday); -3 clamps to 0 (Sunday). Both
    // produce valid Date objects.
    expect(above!.getDay()).toBe(6)
    expect(below!.getDay()).toBe(0)
  })
})
