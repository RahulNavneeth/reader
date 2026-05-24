import { useEffect, useMemo, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { ApiError, api } from '../lib/api'

/**
 * GitHub-style contribution heatmap for the caller's vault. One
 * column per ISO week (Sunday-anchored), one row per weekday.
 * Cells are sized 11×11 with 2px gaps so a year fits comfortably
 * in the timeline's content column without scrolling.
 *
 * Empty cells render at a neutral background; populated cells
 * step through 5 accent shades by quantile so a single high-count
 * day doesn't drown the rest of the scale.
 *
 * Hover any cell to see the date + doc count. Click to navigate
 * (caller wires this through `onDayClick`); the default no-op
 * just shows the tooltip.
 */
type DayRow = { day: string; count: number; lastTs: number }

type Props = {
  /** Window length in days (default 365). */
  days?: number
  /** Click handler: receives the YYYY-MM-DD string of the picked
   *  day. Useful for "jump to this day in the timeline". */
  onDayClick?: (day: string) => void
}

export function CalendarHeatmap({ days: windowDays = 365, onDayClick }: Props) {
  const [data, setData] = useState<{ days: DayRow[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Compute the window once and pass exact bounds to the API so
  // the heatmap is deterministic regardless of server clock skew.
  const { from, to } = useMemo(() => {
    const today = new Date()
    const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const fromDate = new Date(toDate)
    fromDate.setDate(fromDate.getDate() - (windowDays - 1))
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { from: fmt(fromDate), to: fmt(toDate) }
  }, [windowDays])

  useEffect(() => {
    let cancel = false
    setData(null)
    setError(null)
    api
      .accountCalendar(from, to)
      .then((r) => {
        if (!cancel) setData({ days: r.days, total: r.total })
      })
      .catch((e) => {
        if (!cancel) setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancel = true
    }
  }, [from, to])

  // Build the grid: an array of weeks, each week an array of 7
  // cells (Sun–Sat). The from-date may land mid-week — pad the
  // first column with empty cells for the days before `from`.
  const { weeks, quantiles } = useMemo(() => {
    const byDay = new Map<string, number>()
    for (const d of data?.days ?? []) {
      byDay.set(d.day, d.count)
    }
    const grid: Array<Array<{ day: string; count: number } | null>> = []
    const start = new Date(from)
    const end = new Date(to)
    const cursor = new Date(start)
    // Back up to the previous Sunday so the first column is aligned.
    cursor.setDate(cursor.getDate() - cursor.getDay())
    while (cursor <= end) {
      const week: Array<{ day: string; count: number } | null> = []
      for (let i = 0; i < 7; i++) {
        if (cursor < start || cursor > end) {
          week.push(null)
        } else {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
          week.push({ day: key, count: byDay.get(key) ?? 0 })
        }
        cursor.setDate(cursor.getDate() + 1)
      }
      grid.push(week)
    }
    // Quantile thresholds for the 4 nonzero shade buckets. Linear
    // would let a single 50-doc day suppress everything else; we
    // bucket by rank so the color scale stays informative across
    // both low-volume and high-volume vaults.
    const positives = (data?.days ?? [])
      .map((d) => d.count)
      .filter((c) => c > 0)
      .sort((a, b) => a - b)
    const q = (p: number) => {
      if (positives.length === 0) return Infinity
      const i = Math.min(positives.length - 1, Math.floor(positives.length * p))
      return positives[i]
    }
    return {
      weeks: grid,
      quantiles: [q(0.25), q(0.5), q(0.75), q(1)],
    }
  }, [data, from, to])

  const shadeFor = (count: number): { bg: string; opacity: number } => {
    if (count === 0) return { bg: 'var(--hover)', opacity: 1 }
    // Bucket into 4 accent intensities by quantile rank.
    const bucket =
      count <= quantiles[0]
        ? 0
        : count <= quantiles[1]
          ? 1
          : count <= quantiles[2]
            ? 2
            : 3
    const opacities = [0.3, 0.55, 0.8, 1]
    return { bg: 'var(--accent)', opacity: opacities[bucket] }
  }

  return (
    <section aria-label="Activity heatmap">
      <div className="flex items-end justify-between mb-2 px-1 gap-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-subtle truncate">
          {data ? `Last ${windowDays} days` : 'Activity'}
          {data && (
            <span className="ml-1.5 font-normal opacity-80">· {data.total}</span>
          )}
        </div>
        {data && (
          <div className="flex items-center gap-1 text-[10px] text-subtle shrink-0">
            Less
            {[0, 0.3, 0.55, 0.8, 1].map((o, i) => (
              <span
                key={i}
                className="w-2 h-2 rounded-sm"
                style={{
                  background: o === 0 ? 'var(--hover)' : 'var(--accent)',
                  opacity: o === 0 ? 1 : o,
                }}
                aria-hidden
              />
            ))}
            More
          </div>
        )}
      </div>
      {data == null && !error && (
        <div className="text-[12px] text-subtle flex items-center gap-1.5 py-2 px-1">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div
          className="px-2 py-1.5 rounded text-[12px] flex items-start gap-1.5"
          style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
        >
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}
      {data && (
        <div
          className="grid gap-[2px] w-full"
          style={{
            gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))`,
          }}
        >
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-rows-7 gap-[2px]">
              {week.map((cell, di) => {
                if (!cell) {
                  return <div key={di} className="aspect-square" />
                }
                const shade = shadeFor(cell.count)
                const titleText = `${cell.day}: ${cell.count} document${cell.count === 1 ? '' : 's'}`
                return (
                  <button
                    key={di}
                    type="button"
                    title={titleText}
                    aria-label={titleText}
                    onClick={() => onDayClick?.(cell.day)}
                    className="aspect-square w-full rounded-sm transition-opacity hover:ring-1 hover:ring-accent"
                    style={{ background: shade.bg, opacity: shade.opacity }}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
