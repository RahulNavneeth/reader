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
  /** Click handler for PAST days: receives the YYYY-MM-DD string of
   *  the picked day. Useful for "jump to this day in the timeline". */
  onDayClick?: (day: string) => void
  /** Click handler for FUTURE days with at least one scheduled
   *  template firing. Receives the template's vault-relative path
   *  (e.g., `_templates/workout.md`). Called with the first
   *  schedule of the day when multiple fire — the legend already
   *  surfaces the full list. */
  onTemplateClick?: (template: string) => void
}

type ScheduleInfo = {
  key: string
  template: string
  cron: string
  label?: string
  color: string
}
/** Day → array of scheduleKey strings firing on that day. No
 *  per-day count: a daily calendar can't usefully express "fires
 *  1440 times today" vs "fires once today". */
type UpcomingDays = Record<string, string[]>
type Mode = 'past' | 'next'

export function CalendarHeatmap({
  days: windowDays = 365,
  onDayClick,
  onTemplateClick,
}: Props) {
  const [data, setData] = useState<{ days: DayRow[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-schedule color + per-day fire breakdown for the future
  // window. Lets the calendar paint each schedule distinctly so
  // overlapping schedules read as separate things on the same day.
  const [upcoming, setUpcoming] = useState<UpcomingDays>({})
  const [upcomingLoading, setUpcomingLoading] = useState(true)
  const [scheduleInfo, setScheduleInfo] = useState<ScheduleInfo[]>([])
  const scheduleByKey = useMemo(() => {
    const m = new Map<string, ScheduleInfo>()
    for (const s of scheduleInfo) m.set(s.key, s)
    return m
  }, [scheduleInfo])
  const [mode, setMode] = useState<Mode>('past')

  // Compute the window once and pass exact bounds to the API so
  // the heatmap is deterministic regardless of server clock skew.
  // The past window powers the activity colors; the FUTURE window
  // (today → today + windowDays) powers the upcoming overlay.
  const { from, to, upFrom, upTo, todayKey } = useMemo(() => {
    const today = new Date()
    const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const fromDate = new Date(toDate)
    fromDate.setDate(fromDate.getDate() - (windowDays - 1))
    const upToDate = new Date(toDate)
    upToDate.setDate(upToDate.getDate() + windowDays)
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return {
      from: fmt(fromDate),
      to: fmt(toDate),
      upFrom: fmt(toDate),
      upTo: fmt(upToDate),
      todayKey: fmt(toDate),
    }
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

  useEffect(() => {
    let cancel = false
    setUpcoming({})
    setScheduleInfo([])
    setUpcomingLoading(true)
    api
      .accountScheduledUpcoming(upFrom, upTo)
      .then((r) => {
        if (cancel) return
        setUpcoming(r.days ?? {})
        setScheduleInfo(r.schedules ?? [])
      })
      // Upcoming-overlay fetch failure is non-fatal — the heatmap
      // still renders past activity. Swallow rather than blocking
      // the whole panel on a misconfigured cron.
      .catch(() => {})
      .finally(() => {
        if (!cancel) setUpcomingLoading(false)
      })
    return () => {
      cancel = true
    }
  }, [upFrom, upTo])

  // Build the grid for the active mode. 'past' uses [from..today]
  // and shades by document activity; 'next' uses [today..upTo] and
  // shades each day with the color of its scheduled template (or
  // the dominant one if multiple fire). Single-mode keeps the grid
  // dense + readable instead of squeezing 730 columns into one row.
  const { weeks, quantiles } = useMemo(() => {
    const byDay = new Map<string, number>()
    for (const d of data?.days ?? []) {
      byDay.set(d.day, d.count)
    }
    type Cell = {
      day: string
      count: number
      isFuture: boolean
      scheduleKeys: string[]
    } | null
    const grid: Array<Cell[]> = []
    const start = new Date(mode === 'past' ? from : upFrom)
    const end = new Date(mode === 'past' ? to : upTo)
    const cursor = new Date(start)
    // Back up to the previous Sunday so the first column is aligned.
    cursor.setDate(cursor.getDate() - cursor.getDay())
    while (cursor <= end) {
      const week: Cell[] = []
      for (let i = 0; i < 7; i++) {
        if (cursor < start || cursor > end) {
          week.push(null)
        } else {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
          const isFuture = key > todayKey
          const keys = upcoming[key] ?? []
          week.push({
            day: key,
            count: isFuture ? 0 : byDay.get(key) ?? 0,
            isFuture,
            scheduleKeys: keys,
          })
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
  }, [data, from, to, upFrom, upTo, todayKey, upcoming, mode])

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

  /** Pick the first-listed schedule's color as the cell's fill, and
   *  step opacity by how many distinct schedules fire that day so
   *  a "3 things going on" day looks denser than "1 thing". */
  const upcomingShade = (
    keys: string[],
  ): { bg: string; opacity: number } => {
    if (keys.length === 0) {
      return {
        bg: 'color-mix(in srgb, var(--hover) 60%, transparent)',
        opacity: 1,
      }
    }
    const color = scheduleByKey.get(keys[0])?.color ?? '#7C3AED'
    const opacity = keys.length >= 3 ? 1 : keys.length === 2 ? 0.85 : 0.7
    return { bg: color, opacity }
  }

  return (
    <section aria-label="Activity heatmap">
      <div className="flex items-center justify-between mb-2 px-1 gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {/* Past / Next segmented toggle. Pill-style — active item
              rides a raised surface inside a recessed track, like
              Notion/macOS segmented controls. Smaller + softer than
              the previous bordered-rectangle version. */}
          <div
            className="inline-flex rounded-md p-0.5 shrink-0"
            style={{
              background: 'var(--hover)',
              border: '1px solid var(--border)',
            }}
            role="tablist"
            aria-label="Calendar window"
          >
            {(['past', 'next'] as const).map((m) => {
              const active = mode === m
              return (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMode(m)}
                  className="text-[11px] font-medium px-2.5 h-6 rounded transition-colors"
                  style={{
                    background: active ? 'var(--selected)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--fg-muted)',
                  }}
                >
                  {m === 'past' ? 'Past' : 'Next'}
                </button>
              )
            })}
          </div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-subtle truncate inline-flex items-center gap-1.5">
            {mode === 'past' ? (
              data ? (
                <>Activity <span className="font-normal opacity-80">· {data.total}</span></>
              ) : (
                'Activity'
              )
            ) : upcomingLoading ? (
              <>
                <Loader2 size={10} className="animate-spin" /> Scheduled
              </>
            ) : (
              <>Scheduled <span className="font-normal opacity-80">· {Object.values(upcoming).reduce((s, keys) => s + keys.length, 0)}</span></>
            )}
          </div>
        </div>
        {mode === 'past' && data && (
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
        {mode === 'next' && scheduleInfo.length > 0 && (
          <div className="flex items-center gap-2 text-[10px] text-subtle shrink-0 flex-wrap">
            {scheduleInfo.map((s) => (
              <span
                key={s.key}
                className="inline-flex items-center gap-1.5"
                title={`${s.template} · ${s.cron}`}
              >
                <span
                  className="w-2 h-2 rounded-sm"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span className="truncate max-w-[160px]">
                  {s.label || s.template.split('/').pop() || s.template}
                </span>
              </span>
            ))}
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
                const shade = cell.isFuture
                  ? upcomingShade(cell.scheduleKeys)
                  : shadeFor(cell.count)
                const isToday = cell.day === todayKey
                const titleText = isToday
                  ? `${cell.day} (today)`
                  : cell.isFuture
                    ? cell.scheduleKeys.length > 0
                      ? `${cell.day}\n${cell.scheduleKeys
                          .map((k) => {
                            const s = scheduleByKey.get(k)
                            return `• ${s?.label || s?.template || k}`
                          })
                          .join('\n')}`
                      : `${cell.day}: no scheduled fires`
                    : `${cell.day}: ${cell.count} document${cell.count === 1 ? '' : 's'}`
                const futureScheduleKey =
                  cell.isFuture && cell.scheduleKeys.length > 0
                    ? cell.scheduleKeys[0]
                    : null
                const futureTemplate = futureScheduleKey
                  ? scheduleByKey.get(futureScheduleKey)?.template ?? null
                  : null
                return (
                  <button
                    key={di}
                    type="button"
                    title={titleText}
                    aria-label={titleText}
                    onClick={() => {
                      if (cell.isFuture && futureTemplate) {
                        onTemplateClick?.(futureTemplate)
                      } else if (!cell.isFuture) {
                        onDayClick?.(cell.day)
                      }
                    }}
                    className={
                      'aspect-square w-full rounded-sm transition-opacity hover:ring-1 hover:ring-accent ' +
                      ((cell.isFuture && futureTemplate) || (!cell.isFuture && cell.count > 0)
                        ? 'cursor-pointer'
                        : 'cursor-default')
                    }
                    style={{
                      background: shade.bg,
                      opacity: shade.opacity,
                      boxShadow: isToday
                        ? 'inset 0 0 0 1.5px var(--accent)'
                        : undefined,
                    }}
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
