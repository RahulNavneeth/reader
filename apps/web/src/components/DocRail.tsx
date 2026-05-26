import { useEffect, useMemo, useState } from 'react'
import {
  List,
  Clock,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { computeLineDiffCounts } from '../lib/lineDiff'

type Version = {
  ts: number
  sha256: string
  bytes: number
  title?: string
  hasText: boolean
}

type Heading = {
  level: number
  slug: string
  text: string
}

type Props = {
  path: string
  text: string | null
  headings: Heading[]
  hasOutlineList: boolean
  outlineOpen: boolean
  setOutlineOpen: (v: boolean) => void
  versionsOpen: boolean
  setVersionsOpen: (v: boolean) => void
  jumpTo: (slug: string) => void
  /** When set, this row's diff is currently being shown inline
   *  in the main viewer — DocRail highlights it as the active
   *  selection. */
  activeDiffTs?: number | null
  /** Tells the parent (PathViewer) to swap the main content
   *  area to an inline diff against this version's snapshot. */
  onPickVersion?: (ts: number) => void
  /** Bumped by the parent to force the version list to refetch —
   *  used after a restore so the just-created pre-restore snapshot
   *  shows up in the rail without a page reload. */
  versionsReloadKey?: number
}

/**
 * Single right-side rail that hosts both the Outline and Versions
 * sections in one column.
 *
 *   • Both sections collapsed → 32-px narrow strip with two
 *     stacked icons (List + Clock). Clicking either icon opens
 *     that section without disturbing the other.
 *   • Either section open → 240-px wide column rendering header
 *     bars for both sections. Each header has its own collapse
 *     toggle, so the user can independently hide either body
 *     without leaving the rail.
 *
 * Versions list is fetched on mount; the rail (and the section)
 * hide themselves entirely if there are no saved versions.
 */
export function DocRail({
  path,
  text,
  headings,
  hasOutlineList,
  outlineOpen,
  setOutlineOpen,
  versionsOpen,
  setVersionsOpen,
  jumpTo,
  activeDiffTs,
  onPickVersion,
  versionsReloadKey,
}: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  /** Per-version line-delta vs the chronologically older snapshot.
   *  Populated lazily by a background job once `versions` lands so
   *  the row renders an at-a-glance "+5 −2 lines" hint without
   *  waiting for the user to click into the diff modal. */
  const [deltaByTs, setDeltaByTs] = useState<Map<number, { added: number; removed: number }>>(
    new Map(),
  )

  useEffect(() => {
    let cancelled = false
    setVersions(null)
    setVersionsError(null)
    setDeltaByTs(new Map())
    api
      .fileVersions(path)
      .then((r) => {
        if (!cancelled) setVersions(r.versions)
      })
      .catch((e) => {
        if (!cancelled) setVersionsError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, versionsReloadKey])

  // Memoised bucketed rows — shared by the delta-compute effect
  // and the render below. Bucketing collapses adjacent-in-time
  // snapshots into a single row so a flurry of saves in one
  // editing session shows up as one entry, not eight.
  const bucketedRows = useMemo(() => {
    if (!versions) return []
    return bucketByTimeWindow(collapseVersions(versions))
  }, [versions])

  // Once bucketed rows are known AND the user has actually opened
  // the versions section, fetch each bucket's kept-snapshot text
  // and compute the line-delta vs the CURRENT doc text. This
  // mirrors what the inline diff view shows when the row is
  // clicked — "what would change if I went back to this
  // snapshot" — so the +/- on the row predicts the inline diff
  // exactly. (Earlier passes diffed against the next bucket,
  // which produced numbers that didn't match the inline view.)
  useEffect(() => {
    if (bucketedRows.length === 0) return
    if (!versionsOpen) return
    if (text === null) return
    let cancelled = false
    const FETCH_LIMIT = 30
    const slice = bucketedRows.slice(0, FETCH_LIMIT)
    Promise.all(
      slice.map((v) =>
        api
          .fileVersionText(path, v.ts)
          .then((r) => [v.ts, r.text ?? ''] as const)
          .catch(() => [v.ts, ''] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return
      const textByTs = new Map<number, string>(pairs)
      const map = new Map<number, { added: number; removed: number }>()
      for (const v of slice) {
        const snapText = textByTs.get(v.ts) ?? ''
        if (!snapText && text === '') continue
        // Same direction as the inline view: (snapshot → current).
        // `ins` lines count as added (in current, not in snapshot),
        // `del` as removed (in snapshot, not in current).
        map.set(v.ts, computeLineDiffCounts(snapText, text))
      }
      setDeltaByTs(map)
    })
    return () => {
      cancelled = true
    }
  }, [bucketedRows, versionsOpen, path, text])

  const hasVersions = (versions?.length ?? 0) > 0 || !!versionsError
  // Mirror the versions auto-hide: when the doc has no headings to
  // outline, skip the Outline section entirely. Without this an
  // empty doc would still show a rail icon that opens an empty pane.
  const eitherOpen = (outlineOpen && hasOutlineList) || (versionsOpen && hasVersions)

  // No outline + no versions → the entire rail is dead weight. Hide.
  if (!hasOutlineList && !hasVersions) return null

  return (
    <>
      {!eitherOpen ? (
        <div
          className="w-8 shrink-0 border-l flex flex-col items-stretch"
          style={{ borderColor: 'var(--border)', background: 'var(--rail)' }}
        >
          {hasOutlineList && (
            <RailIconButton
              label="Expand outline"
              icon={<List size={12} />}
              onClick={() => {
                // Mutually exclusive — opening outline closes versions.
                setVersionsOpen(false)
                setOutlineOpen(true)
              }}
            />
          )}
          {hasVersions && (
            <RailIconButton
              label="Expand versions"
              icon={<Clock size={12} />}
              onClick={() => {
                setOutlineOpen(false)
                setVersionsOpen(true)
              }}
            />
          )}
        </div>
      ) : (
        <aside
          className="w-[240px] shrink-0 border-l overflow-y-auto"
          style={{ borderColor: 'var(--border)', background: 'var(--rail)' }}
        >
          {outlineOpen && hasOutlineList && (
            <>
              <SectionHeader
                icon={<List size={11} />}
                label="Outline"
                open={true}
                onToggle={() => setOutlineOpen(false)}
              />
              {hasOutlineList && (
                <nav className="px-2 py-2">
                  {headings.map((h, i) => (
                    <button
                      key={i + h.slug}
                      onClick={() => jumpTo(h.slug)}
                      className="block w-full text-left px-2 py-1 rounded text-[12px] hover:bg-hover transition-colors text-fg truncate"
                      style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                      title={h.text}
                    >
                      {h.text}
                    </button>
                  ))}
                </nav>
              )}
            </>
          )}
          {versionsOpen && hasVersions && (
            <>
              <SectionHeader
                icon={<Clock size={11} />}
                label="Versions"
                count={versions?.length ?? undefined}
                open={true}
                onToggle={() => setVersionsOpen(false)}
              />
              <div className="px-2 py-2">
                  {versions === null && !versionsError && (
                    <div className="px-2 py-1.5 text-[11.5px] text-subtle flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" /> Loading…
                    </div>
                  )}
                  {versionsError && (
                    <div
                      className="px-2 py-1.5 text-[11px] rounded"
                      style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
                    >
                      {versionsError}
                    </div>
                  )}
                  {(() => {
                    if (!versions) return null
                    // Compact display: collapse runs of identical
                    // sha256 (back-to-back snapshots with no actual
                    // change) and group rows by their day so the
                    // user can scan the timeline at a glance.
                    const rows = bucketedRows
                    return groupedByDay(rows).map((group) => (
                      <div key={group.dayKey} className="mb-2">
                        <div className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider font-semibold text-subtle">
                          {group.dayLabel}
                        </div>
                        {group.items.map((v) => (
                          <button
                            key={v.ts}
                            onClick={() => {
                              if (text === null) return
                              onPickVersion?.(v.ts)
                            }}
                            disabled={text === null}
                            className="block w-full text-left px-2 py-2 mb-0.5 rounded text-[12px] hover:bg-hover transition-colors text-fg disabled:opacity-50 disabled:hover:bg-transparent"
                            style={
                              activeDiffTs === v.ts
                                ? { background: 'var(--selected)', color: 'var(--accent)' }
                                : undefined
                            }
                            title={
                              text === null
                                ? 'Loading doc…'
                                : `Show diff against current — ${new Date(v.ts).toLocaleString()}`
                            }
                          >
                            <div className="flex items-center gap-1.5 leading-tight">
                              <span className="text-[12px] font-medium tabular-nums">
                                {formatRowTime(v.ts)}
                              </span>
                              {v.isLatest && (
                                <span
                                  className="text-[12px] leading-none font-semibold"
                                  style={{ color: 'var(--accent)' }}
                                  aria-label="Latest snapshot"
                                  title="Latest snapshot"
                                >
                                  *
                                </span>
                              )}
                              {v.duplicateCount > 1 && (
                                <span
                                  className="text-[10.5px] text-subtle leading-none"
                                  title={`${v.duplicateCount} snapshots folded into this entry (consecutive identical content or rapid-fire edits within 5 minutes)`}
                                >
                                  ×{v.duplicateCount}
                                </span>
                              )}
                            </div>
                            <div className="text-[10.5px] mt-1 leading-tight flex items-center gap-1.5 text-subtle">
                              <span>{formatRelative(v.ts)}</span>
                              <span>·</span>
                              <span>{formatBytes(v.bytes)}</span>
                              {(() => {
                                const d = deltaByTs.get(v.ts)
                                if (!d) return null
                                if (d.added === 0 && d.removed === 0) {
                                  return <span className="ml-auto">no line change</span>
                                }
                                return (
                                  <span className="ml-auto inline-flex items-baseline gap-1">
                                    {d.added > 0 && (
                                      <span style={{ color: '#00875A' }}>+{d.added}</span>
                                    )}
                                    {d.removed > 0 && (
                                      <span style={{ color: 'var(--danger-fg)' }}>
                                        −{d.removed}
                                      </span>
                                    )}
                                  </span>
                                )
                              })()}
                            </div>
                          </button>
                        ))}
                      </div>
                    ))
                  })()}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  )
}

function RailIconButton({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      className="h-11 w-full inline-flex items-center justify-center border-b transition-[background-color] hover:bg-hover"
      style={{ borderColor: 'var(--border)', color: 'var(--fg-subtle)' }}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  )
}

function SectionHeader({
  icon,
  label,
  count,
  open,
  onToggle,
}: {
  icon: React.ReactNode
  label: string
  count?: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <div
      className="sticky top-0 h-11 px-3 border-b text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex items-center gap-1.5"
      style={{ background: 'var(--rail)', borderColor: 'var(--border)' }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {typeof count === 'number' && (
        <span className="text-[10.5px] text-subtle font-normal">{count}</span>
      )}
      <button
        className="btn-ghost h-6 w-6 px-0"
        onClick={onToggle}
        title={open ? `Collapse ${label.toLowerCase()}` : `Expand ${label.toLowerCase()}`}
        aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      >
        {open ? <PanelRightClose size={12} /> : <PanelRightOpen size={12} />}
      </button>
    </div>
  )
}

/** A version row in the rendered list — derived from the raw
 *  Version[] by collapsing identical consecutive sha256 runs and
 *  attaching the byte-delta vs the chronologically previous
 *  snapshot. */
type RowVersion = {
  ts: number
  sha256: string
  bytes: number
  isLatest: boolean
  /** How many adjacent snapshots had this exact sha256 (1 = the
   *  original, 2 = collapsed one duplicate, etc.). */
  duplicateCount: number
}

/** Collapse runs of consecutive identical sha256 into a single row.
 *  Input is newest-first; the kept row is the newest of each run.
 *  Also computes byte deltas vs the chronologically prior version
 *  (the row immediately BELOW it in the newest-first list). */
function collapseVersions(versions: Version[]): RowVersion[] {
  const out: RowVersion[] = []
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const last = out[out.length - 1]
    if (last && last.sha256 === v.sha256) {
      last.duplicateCount++
      continue
    }
    out.push({
      ts: v.ts,
      sha256: v.sha256,
      bytes: v.bytes,
      isLatest: i === 0,
      duplicateCount: 1,
    })
  }
  return out
}

/** Time-window bucketing: collapse rows that fall within
 *  BUCKET_WINDOW_MS of each other into a single row. Solves the
 *  "I made 8 tiny edits in 9 minutes and now I have 8 versions"
 *  problem — a flurry of saves during one editing session
 *  shouldn't crowd the list. The kept row is the NEWEST in each
 *  bucket (which is what users care about — "where did we end
 *  up after that edit session?"). duplicateCount accumulates the
 *  raw count so the ×N badge reflects how many snapshots were
 *  folded in.
 *
 *  Input is newest-first. */
const BUCKET_WINDOW_MS = 60 * 1000 // 1 minute — collapse sub-minute edit bursts
function bucketByTimeWindow(rows: RowVersion[]): RowVersion[] {
  const out: RowVersion[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    // last is NEWER than r (we go newest-first). Bucket together
    // if r is within WINDOW_MS BEFORE the bucket's newest entry.
    if (last && last.ts - r.ts <= BUCKET_WINDOW_MS) {
      last.duplicateCount += r.duplicateCount
      continue
    }
    out.push({ ...r })
  }
  return out
}

type DayGroup = { dayKey: string; dayLabel: string; items: RowVersion[] }

/** Group rows by local-calendar day. Day labels use friendly names
 *  for today/yesterday so the user scans the timeline by date,
 *  not by raw timestamps. */
function groupedByDay(rows: RowVersion[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const r of rows) {
    const d = new Date(r.ts)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const existing = groups[groups.length - 1]
    if (existing && existing.dayKey === dayKey) {
      existing.items.push(r)
    } else {
      groups.push({ dayKey, dayLabel: formatDayLabel(d), items: [r] })
    }
  }
  return groups
}

function formatDayLabel(d: Date): string {
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(d, now)) return 'Today'
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, yesterday)) return 'Yesterday'
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Per-row clock time — always HH:mm so adjacent versions are
 *  visually distinct even when they're on the same day. */
function formatRowTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Short "N min ago / N hr ago / N d ago" style for the secondary
 *  detail line. Falls back to a localized date for older entries
 *  so the user gets useful context regardless of age. */
function formatRelative(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  const s = Math.floor(delta / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Render a file-size in human units. Bytes for very small files,
 *  KB / MB beyond. Used in the version-list secondary line so the
 *  user gets a sense of the snapshot's heft at a glance. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

