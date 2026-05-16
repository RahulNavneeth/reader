/**
 * Generic in-process IP rate-limiter — token bucket per (ip, key).
 *
 * Why not @fastify/rate-limit? It pulls in lru-cache + has its own
 * sweep timers. We already have the same pattern for login throttling
 * (auth.ts); this is a generalization. Sub-100 LOC, no deps.
 *
 * Limits are deliberately permissive — the goal is "block abuse, not
 * legitimate use." A logged-in user pulling a folder full of
 * thumbnails fires 50+ requests in a second and is fine.
 */

type Bucket = {
  /** Tokens currently available (fractional). */
  tokens: number
  /** Last refill timestamp (ms). */
  refilledAt: number
}

export type RateLimitOptions = {
  /** Bucket capacity in tokens. Equal to the burst the user can
   *  emit before the refill rate kicks in. */
  capacity: number
  /** Tokens added per second (sustained rate). */
  refillPerSecond: number
}

export type RateLimit = {
  /** Returns `true` and decrements the bucket if a token is
   *  available; otherwise returns `false` and the seconds the
   *  caller should wait. */
  check(ip: string): { allowed: true } | { allowed: false; retryAfterSeconds: number }
  /** Test-only: clears all state. */
  reset(): void
}

export function createRateLimit(opts: RateLimitOptions): RateLimit {
  const buckets = new Map<string, Bucket>()

  // Periodic GC so single-shot scanners don't grow the map forever.
  // Buckets with full capacity (= caller hasn't been seen in a
  // while) are safe to drop. Unref'd so we don't keep the process
  // alive in tests.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) {
      refill(b, now, opts)
      if (b.tokens >= opts.capacity) buckets.delete(k)
    }
  }, 60_000)
  if (typeof sweep.unref === 'function') sweep.unref()

  return {
    check(ip: string) {
      const now = Date.now()
      let b = buckets.get(ip)
      if (!b) {
        b = { tokens: opts.capacity, refilledAt: now }
        buckets.set(ip, b)
      } else {
        refill(b, now, opts)
      }
      if (b.tokens >= 1) {
        b.tokens -= 1
        return { allowed: true }
      }
      const needed = 1 - b.tokens
      const retryAfterSeconds = Math.max(1, Math.ceil(needed / opts.refillPerSecond))
      return { allowed: false, retryAfterSeconds }
    },
    reset() {
      buckets.clear()
    },
  }
}

function refill(b: Bucket, now: number, opts: RateLimitOptions): void {
  const elapsed = (now - b.refilledAt) / 1000
  if (elapsed <= 0) return
  b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSecond)
  b.refilledAt = now
}
