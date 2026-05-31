import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Clock, AlertCircle, Play, FileText, ArrowUp, X } from 'lucide-react'
import { SelectIndicator } from './SelectIndicator'
import { ApiError, api } from '../lib/api'
import { CalendarHeatmap } from './CalendarHeatmap'
import { BulkTagsButton } from './BulkTagsButton'
import { BulkArchiveButton } from './BulkArchiveButton'

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
  /** Bulk selection — same shape as FolderGrid's. Selection is by
   *  vault-relative path so the bulk endpoints (archive, tags)
   *  accept the entries directly. */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const selectedPaths = useMemo(() => Array.from(selection), [selection])
  /** When the user dismisses selection mode, also resets when the
   *  set goes empty (e.g. after a bulk archive finishes). */
  const clearSelection = () => setSelection(new Set())

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
  const loadPage = async (
    next: string | null,
  ): Promise<{ days: DayGroup[]; nextCursor: string | null } | null> => {
    if (inFlight.current || done) return null
    inFlight.current = true
    setLoading(true)
    setError(null)
    try {
      const r = await api.accountTimeline({ cursor: next ?? undefined })
      setDays((prev) => mergeDays(prev, r.days))
      setCursor(r.nextCursor)
      setTotal(r.total)
      if (!r.nextCursor) setDone(true)
      return { days: r.days, nextCursor: r.nextCursor }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      return null
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }

  /** Click a calendar cell whose day section hasn't been loaded
   *  yet — walk forward through the cursor pages until either the
   *  closest-day-on-or-before lands in the DOM or we run out. Used
   *  by the heatmap's onDayClick so pagination doesn't make the
   *  click feel dead. */
  const scrollToDay = async (clickedDay: string) => {
    let nearest = days.find((g) => g.day <= clickedDay)
    let curCursor = cursor
    let safetyCap = 20
    while (!nearest && curCursor && safetyCap-- > 0) {
      // Wait for any concurrent infinite-scroll load to settle so we
      // don't double-fire loadPage and skip pages.
      while (inFlight.current) {
        await new Promise((r) => setTimeout(r, 40))
      }
      const r = await loadPage(curCursor)
      if (!r) break
      curCursor = r.nextCursor
      nearest = r.days.find((g) => g.day <= clickedDay) ?? nearest
    }
    if (!nearest) return
    // rAF so React commits the appended sections before we look
    // them up in the DOM.
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-day="${nearest!.day}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
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

  const toggleSelected = (path: string, additive: boolean) => {
    setSelection((cur) => {
      const next = new Set(additive ? cur : cur)
      if (!additive) {
        // Single-item toggle: flip just this one. Other selections
        // stay; we don't model "click clears, ctrl-click adds"
        // because the picker is one-handed on touch.
      }
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Click handler: in selection mode (anything selected), every
  // click toggles. Out of selection mode, the first click opens
  // the doc; entering selection mode requires the header toggle.
  const onItemClick = (path: string, e: React.MouseEvent) => {
    if (selection.size > 0 || e.shiftKey || e.metaKey || e.ctrlKey) {
      toggleSelected(path, e.shiftKey || e.metaKey || e.ctrlKey)
      return
    }
    openItem(path)
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative"
      style={{ background: 'var(--surface-3)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
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
        {total != null && selection.size === 0 && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {total} {total === 1 ? 'item' : 'items'}
          </span>
        )}
        {selection.size > 0 && (
          <>
            <span className="text-[11.5px] text-accent ml-1.5">
              {selection.size} selected
            </span>
            <div className="flex-1" />
            <BulkTagsButton paths={selectedPaths} />
            <BulkArchiveButton
              paths={selectedPaths}
              onChanged={() => {
                // Archived items drop out of the default timeline
                // window on the next reload — easier to clear and
                // let the user keep working than to surgically
                // remove them from the in-memory `days`.
                clearSelection()
              }}
            />
            <button
              className="btn-ghost h-7 w-7 px-0"
              onClick={clearSelection}
              title="Clear selection"
              aria-label="Clear selection"
            >
              <X size={13} />
            </button>
          </>
        )}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 py-6"
        onClick={(e) => {
          // Click-outside-to-clear: drop any active selection when
          // the user clicks anywhere that isn't a tile or other
          // interactive control. `closest('button, a, input')`
          // catches the tile buttons themselves (which already
          // handled the click via onItemClick), so we only clear
          // when the click landed on actual empty grid space.
          if (selection.size === 0) return
          const t = e.target as HTMLElement
          if (t.closest('button, a, input, [data-keep-selection]')) return
          clearSelection()
        }}
      >
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
              style={{ background: 'var(--surface-2)', border: '1px dashed var(--border)' }}
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
                // scrollToDay walks pagination forward if the target
                // day hasn't been loaded yet, so clicking an old
                // cell doesn't silently no-op just because the
                // infinite scroll hasn't reached that page.
                void scrollToDay(day)
              }}
              // Future scheduled-template cell click → open the
              // template doc itself. Beats trying to scroll-to-day
              // (no section exists yet for future dates) and lets
              // the user jump straight to "what is this thing".
              onTemplateClick={(template) => openItem(template)}
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
                {g.items.map((it) => {
                  const isSel = selection.has(it.path)
                  return (
                  <button
                    key={it.docId}
                    onClick={(e) => onItemClick(it.path, e)}
                    className="group relative overflow-hidden rounded-md transition-colors hover:border-[var(--accent)]"
                    style={{
                      aspectRatio: '1 / 1',
                      // Tile sits one tier above the page body
                      // (`--surface-3`) — uses `--surface-2` so
                      // the card has a subtle elevation without
                      // popping as the brighter `--viewer` white
                      // strip in light mode. Hover promotes the
                      // border to accent; selected state tints
                      // with `--selected`.
                      background: isSel ? 'var(--selected)' : 'var(--surface-2)',
                      border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border)'}`,
                    }}
                    title={
                      selection.size > 0
                        ? `${isSel ? 'Deselect' : 'Select'} · ${it.name}`
                        : it.name
                    }
                  >
                    {/* Selected tile keeps its checkbox permanently
                        visible so deselecting is a one-click
                        affordance. Unselected tiles only reveal
                        the checkbox on hover — even when other
                        tiles ARE selected — so the grid doesn't
                        fill with unchecked boxes the user isn't
                        engaging with. File/folder tiles use the
                        theme-aware `light` variant; photo / video
                        thumbnails use `over-image` so the check
                        reads against the image itself. */}
                    {isSel && (
                      <SelectIndicator
                        checked
                        variant={
                          it.kind === 'image' || it.kind === 'video'
                            ? 'over-image'
                            : 'light'
                        }
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          toggleSelected(it.path, true)
                        }}
                      />
                    )}
                    {!isSel && (
                      <span
                        className="absolute top-1.5 left-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleSelected(it.path, true)
                          }}
                          className="w-4 h-4 rounded flex items-center justify-center"
                          style={{
                            background: 'var(--bg)',
                            border: '1px solid var(--border)',
                          }}
                          title="Select"
                          aria-label="Select"
                        />
                      </span>
                    )}
                    {it.kind === 'file' ? (
                      // Non-media doc — no thumbnail to show; render
                      // a generic icon-and-filename tile so the grid
                      // stays visually uniform alongside media tiles.
                      // Inner div is transparent — the outer button
                      // already provides the surface-2 fill / hover
                      // tint / selected tint we want.
                      <div
                        className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2"
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
                  )
                })}
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
