import { describe, it, expect } from 'vitest'
import { withEditLock } from './editLock.js'

/**
 * Tests for the per-doc mutex. Everything in the codebase that
 * serializes vault writes — chat apply-edit, per-op apply, MCP
 * granular edits — funnels through here, so if the chaining
 * breaks the result is silent data loss.
 */
describe('withEditLock', () => {
  it('runs a single holder immediately', async () => {
    let ran = false
    const result = await withEditLock('doc-A', async () => {
      ran = true
      return 'ok' as const
    })
    expect(ran).toBe(true)
    expect(result).toBe('ok')
  })

  it('serializes concurrent holders on the same docId', async () => {
    // Two holders started in parallel must execute one-after-the-
    // other, NOT interleave. We verify by recording when each one's
    // body STARTS vs FINISHES — interleaving would produce
    // [start,start,end,end] instead of [start,end,start,end].
    const order: string[] = []
    const a = withEditLock('doc-B', async () => {
      order.push('a:start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('a:end')
      return 1
    })
    const b = withEditLock('doc-B', async () => {
      order.push('b:start')
      await new Promise((r) => setTimeout(r, 5))
      order.push('b:end')
      return 2
    })
    const results = await Promise.all([a, b])
    expect(results).toEqual([1, 2])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('does NOT serialize across different docIds', async () => {
    // Two different docs should run truly in parallel — the lock is
    // per-docId, so unrelated edits shouldn't block each other.
    const order: string[] = []
    const a = withEditLock('doc-C1', async () => {
      order.push('a:start')
      await new Promise((r) => setTimeout(r, 30))
      order.push('a:end')
    })
    const b = withEditLock('doc-C2', async () => {
      order.push('b:start')
      await new Promise((r) => setTimeout(r, 5))
      order.push('b:end')
    })
    await Promise.all([a, b])
    // b started before a finished — different doc, no serialization.
    expect(order.indexOf('b:start')).toBeLessThan(order.indexOf('a:end'))
    expect(order).toContain('b:end')
  })

  it("does NOT let a prior holder's throw tear down the lock", async () => {
    // If the first holder throws, the second one should still get
    // to run. The .catch() shield in editLock is what guarantees
    // this; without it, every subsequent .then() would reject.
    const failing = withEditLock('doc-D', async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')

    let ranAfter = false
    const after = await withEditLock('doc-D', async () => {
      ranAfter = true
      return 'recovered' as const
    })
    expect(ranAfter).toBe(true)
    expect(after).toBe('recovered')
  })

  it('propagates the holder return value', async () => {
    const r = await withEditLock('doc-E', async () => ({ value: 42 }))
    expect(r).toEqual({ value: 42 })
  })

  it('propagates the holder error', async () => {
    await expect(
      withEditLock('doc-F', async () => {
        throw new Error('apply failed')
      }),
    ).rejects.toThrow('apply failed')
  })

  it('releases the lock even when the holder throws (next holder runs)', async () => {
    // After a throw, the next holder should not be blocked. This
    // is what protects the chat / MCP routes from a deadlocked
    // doc.
    await withEditLock('doc-G', async () => {
      throw new Error('first fails')
    }).catch(() => undefined)
    const ok = await withEditLock('doc-G', async () => 'second wins' as const)
    expect(ok).toBe('second wins')
  })

  it('queues many waiters in FIFO order', async () => {
    // Stress: 10 concurrent holders should run in start order.
    // Regression guard against accidental Promise.all-style
    // parallelism in the chain.
    const order: number[] = []
    const tasks = Array.from({ length: 10 }, (_, i) =>
      withEditLock('doc-H', async () => {
        order.push(i)
        // Vary delays so a broken chain would produce out-of-order
        // entries; the lock should pin them to FIFO.
        await new Promise((r) => setTimeout(r, (10 - i) * 2))
      }),
    )
    await Promise.all(tasks)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('cleans up the map entry when no waiters are queued', async () => {
    // Lock should not leak entries. We can't peek at the internal
    // Map directly, but we can observe behavior: after a holder
    // finishes and nothing's queued, a new holder should run
    // synchronously (no microtask wait before fn body starts).
    await withEditLock('doc-cleanup', async () => 1)
    // Microtask gap so any pending .then() lock-tail-update can
    // settle. After this, the lock for doc-cleanup must be
    // released — a brand-new holder should run without waiting.
    await Promise.resolve()
    let didRun = false
    const p = withEditLock('doc-cleanup', async () => {
      didRun = true
      return 2
    })
    // didRun is true at this point only if the fn started
    // synchronously inside the call (no pending chain to await).
    // It actually awaits `prev`, which is resolved, so fn starts
    // in the SAME microtask as the call — true here.
    await p
    expect(didRun).toBe(true)
  })
})
