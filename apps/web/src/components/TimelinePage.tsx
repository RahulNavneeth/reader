import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Clock, AlertCircle, Play, FileText, ArrowUp } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { CalendarHeatmap } from './CalendarHeatmap'

type DayGroup = Awaited<ReturnType<typeof api.accountTimeline>>['days'][number]

/**
 * Document timeline at /timeline. Chronological grid of every doc
 * the user owns — images, videos, and other files — bucketed by day.
 * Infinite scroll via IntersectionObserver — the next page loads
 * when the sentinel at the bottom of the list comes into view.
 */
export function TimelinePage() {
  const navigate = useNavigate()
  const [days, setDays] = useState<DayGroup[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  /** Shown once the user has scrolled past a couple viewports —
   *  jumping back to today is one click instead of a long flick. */
  const [showScrollTop, setShowScrollTop] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Merge incoming days into the existing list, deduping by both
  // day key and per-item docId. Originally we only checked the seam
  // day, which left every other day vulnerable to React StrictMode's
  // double-mount fetching the same page twice and producing visible
  // duplicate sections.
  const mergeDays = (existing: DayGroup[], incoming: DayGroup[]): DayGroup[] => {
    if (incoming.length === 0) return existing
    const byDay = new Map<string, DayGroup>()
    for (const g of existing) {
      byDay.set(g.day, { day: g.day, items: [...g.items] })
    }
    for (const g of incoming) {
      const cur = byDay.get(g.day)
      if (!cur) {
        byDay.set(g.day, { day: g.day, items: [...g.items] })
        continue
      }
      const seenIds = new Set(cur.items.map((it) => it.docId))
      for (const it of g.items) {
        if (!seenIds.has(it.docId)) {
          cur.items.push(it)
          seenIds.add(it.docId)
        }
      }
    }
    // Newest day first — the server already returns that order, but
    // a map drops it. Re-sort by the first item's createdAt.
    return Array.from(byDay.values()).sort(
      (a, b) => (b.items[0]?.createdAt ?? 0) - (a.items[0]?.createdAt ?? 0),
    )
  }

  // Ref-based in-flight guard. `loading` is async state — two
  // useEffect runs in the same tick (StrictMode) both see
  // `loading=false` before either setLoading commits. A ref flips
  // synchronously.
  const inFlight = useRef(false)
  const loadPage = async (next: string | null) => {
    if (inFlight.current || done) return
    inFlight.current = true
    setLoading(true)
    setError(null)
    try {
      const r = await api.accountTimeline(next ?? undefined)
      setDays((prev) => mergeDays(prev, r.days))
      setCursor(r.nextCursor)
      setTotal(r.total)
      if (!r.nextCursor) setDone(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }

  useEffect(() => {
    loadPage(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Show/hide the "back to top" button based on scroll position.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setShowScrollTop(el.scrollTop > 400)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Infinite scroll sentinel.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && cursor && !loading) {
          loadPage(cursor)
        }
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [cursor, loading])

  const openItem = (path: string) => {
    const segs = path.split('/').map(encodeURIComponent).join('/')
    navigate(`/${segs}`)
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative"
      style={{ background: 'var(--rail)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/')}
          title="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <Clock size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Timeline</div>
        {total != null && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {total} {total === 1 ? 'item' : 'items'}
          </span>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2 max-w-[1080px] mx-auto"
            style={{ background: '#FFEBE6', color: '#BF2600' }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {days.length === 0 && !loading && !error && (
          <div className="h-full flex items-center justify-center">
            <div
              className="rounded-xl p-8 text-center max-w-md"
              style={{ background: 'var(--viewer)', border: '1px dashed var(--border)' }}
            >
              <Clock size={22} className="text-subtle mx-auto mb-2" />
              <div className="text-[14px] text-fg font-medium">No documents yet</div>
              <div className="text-[12px] text-muted mt-1.5">
                Upload files to your vault and they'll appear here grouped by date.
              </div>
            </div>
          </div>
        )}

        <div className="max-w-[1080px] mx-auto space-y-6">
          {/* Heatmap renders inline with day sections — same max
              width, same px offset, no card chrome — so it reads
              as the first item in the timeline list rather than a
              separate panel sitting above it. Hidden when there's
              nothing to summarise: an empty 365-cell grid in an
              otherwise blank page is pure visual noise. */}
          {days.length > 0 && (
            <CalendarHeatmap
              onDayClick={(day) => {
                const el = document.querySelector(`[data-day="${day}"]`)
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              }}
            />
          )}
          {days.map((g) => (
            <section key={g.day} data-day={g.day}>
              <div className="px-1 mb-2 text-[12px] uppercase tracking-wider font-semibold text-subtle">
                {formatDay(g.day)}
                <span className="ml-1.5 normal-case font-normal">
                  · {g.items.length}
                </span>
              </div>
              <div
                className="grid gap-1.5"
                style={{
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                }}
              >
                {g.items.map((it) => (
                  <button
                    key={it.docId}
                    onClick={() => openItem(it.path)}
                    className="group relative overflow-hidden rounded-md"
                    style={{
                      aspectRatio: '1 / 1',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                    }}
                    title={it.name}
                  >
                    {it.kind === 'file' ? (
                      // Non-media doc — no thumbnail to show; render a
                      // generic file tile with truncated filename so the
                      // grid stays visually uniform alongside media tiles.
                      // Uses --viewer so the tile stays white in light
                      // mode (pops against the --rail canvas) but keeps
                      // its panel-tint in dark mode (where pure --bg
                      // would be the deepest base and read as a hole).
                      <div
                        className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2"
                        style={{ background: 'var(--viewer)' }}
                      >
                        <FileText size={28} className="text-subtle" strokeWidth={1.4} />
                        <div className="text-[11px] text-fg text-center leading-tight line-clamp-3 break-all">
                          {it.name}
                        </div>
                      </div>
                    ) : (
                      <>
                        <img
                          src={api.thumbnailUrl(it.path)}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => {
                            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                          }}
                        />
                        {it.kind === 'video' && (
                          <div
                            className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full inline-flex items-center justify-center"
                            style={{ background: 'rgba(0,0,0,0.55)' }}
                          >
                            <Play size={10} color="white" fill="white" />
                          </div>
                        )}
                        {/* Live Photo indicator — small badge in the
                            bottom-left so users can spot pairs at a glance. */}
                        {it.kind === 'image' && it.livePhotoPair && (
                          <div
                            className="absolute bottom-1.5 left-1.5 px-1.5 h-4 rounded inline-flex items-center text-[9px] font-semibold uppercase tracking-wider"
                            style={{ background: 'rgba(0,0,0,0.6)', color: 'white' }}
                          >
                            Live
                          </div>
                        )}
                      </>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}

          {/* Sentinel — keeps loading the next page as it scrolls
              into view. Renders a noticeable area so the observer
              definitely fires once it's ~600px from being on screen. */}
          {!done && <div ref={sentinelRef} className="h-12" aria-hidden />}
        </div>
      </div>
      {/* Back to top — appears after the user has scrolled a bit.
          Smooth-scrolls the timeline pane (not window) since the
          scroll container is the inner div. */}
      {showScrollTop && (
        <button
          type="button"
          onClick={() =>
            scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          }
          className="absolute bottom-5 right-5 h-9 w-9 rounded-full shadow-card inline-flex items-center justify-center transition-opacity hover:opacity-90"
          style={{
            background: 'var(--accent)',
            color: 'white',
            border: '1px solid var(--accent)',
          }}
          title="Back to top"
          aria-label="Back to top"
        >
          <ArrowUp size={16} />
        </button>
      )}
    </div>
  )
}

function formatDay(day: string): string {
  // day = "YYYY-MM-DD"
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
