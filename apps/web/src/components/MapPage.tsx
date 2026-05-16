import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  MapPin,
  Loader2,
  AlertCircle,
  Maximize2,
  X,
} from 'lucide-react'
// Aliased: pigeon-maps exports `Map` as a React component, which would
// otherwise shadow the JS `Map` global we use for clustering buckets.
import { Map as PigeonMap, Overlay } from 'pigeon-maps'
import { ApiError, api } from '../lib/api'

type Pin = {
  docId: string
  path: string
  name: string
  mime: string
  createdAt: number
  lat: number
  lng: number
}

type Cluster = {
  /** Stable key for React + selection — derived from the rounded coord. */
  key: string
  lat: number
  lng: number
  pins: Pin[]
}

/**
 * Photo map at /map. Plots geotagged images on OSM via pigeon-maps.
 *
 * Three things this component handles that aren't free out of the box:
 *
 *   1. Sizing. pigeon-maps doesn't auto-fill a flex parent — it needs
 *      explicit width/height props. We attach a ResizeObserver to the
 *      wrapper and feed dimensions through.
 *   2. Bounds-fit zoom. We compute the smallest zoom that holds every
 *      pin in view (with padding). One pin → city-level zoom; many
 *      pins across continents → world view; one pin → mid zoom.
 *   3. Co-located photos. Phone photos taken near each other share
 *      GPS to 5+ decimal places — without clustering they render as
 *      one marker and the count looks wrong. We round to 4 decimal
 *      places (~11m) and group; clusters show a +N badge.
 */
export function MapPage() {
  const navigate = useNavigate()
  const [pins, setPins] = useState<Pin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [selected, setSelected] = useState<Cluster | null>(null)
  const polling = useRef<number | null>(null)
  // Tiny flag set by Marker.onClick so the very next Map.onClick can
  // bail out — pigeon-maps doesn't bubble events cleanly, so this is
  // how we tell "user clicked a marker" from "user clicked empty map".
  // Without it, clicking a marker would open + immediately close.
  const markerClickAt = useRef(0)
  // Live zoom level so we can scale marker size with the view. At
  // world zoom a 96px tile drapes a continent; at street zoom a 96px
  // tile is a thumbnail. Both look wrong.
  const [zoom, setZoom] = useState(2)

  // Container measurement for pigeon-maps. Two precautions to stop the
  // map from sliding around:
  //
  //   1. Threshold: ignore size deltas under 4px. Without this, pigeon's
  //      internal layout (it adds an absolute-positioned tile grid that
  //      can nudge the parent's flex box sub-pixel) triggers the
  //      observer → new height prop → re-layout → … feedback loop where
  //      the map appears to keep drifting upward.
  //   2. `overflow-hidden` on the wrap div (applied in JSX below) so
  //      pigeon's children can't push the parent taller in the first
  //      place. Belt + suspenders.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry.contentRect
      const w = Math.max(1, Math.round(cr.width))
      const h = Math.max(1, Math.round(cr.height))
      setSize((cur) => {
        if (cur && Math.abs(cur.w - w) < 4 && Math.abs(cur.h - h) < 4) return cur
        return { w, h }
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const load = async () => {
    try {
      const r = await api.accountMap()
      setPins(r.items)
      if (r.moreToBackfill) {
        setBackfilling(true)
        polling.current = window.setTimeout(load, 600)
      } else {
        setBackfilling(false)
        polling.current = null
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setBackfilling(false)
    }
  }

  useEffect(() => {
    load()
    return () => {
      if (polling.current != null) window.clearTimeout(polling.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Proximity-based clustering. Each pin joins the nearest existing
  // cluster within CLUSTER_RADIUS_M; otherwise it seeds a new one.
  // Why not coord-rounding? toFixed(4) buckets photos by *grid cells*,
  // so two shots taken 2m apart can land in different cells purely
  // because they straddle a 4-decimal boundary — looks broken to a
  // user who knows they were standing in the same spot.
  //
  // 120m is a deliberate choice: bigger than typical phone-GPS jitter
  // (~10-30m), but small enough that two photos on different blocks
  // stay separate at city zoom. Cluster centroid is updated as a
  // running mean so pins added later still pull the marker toward
  // the centroid.
  const clusters: Cluster[] = useMemo(() => {
    if (!pins) return []
    const CLUSTER_RADIUS_M = 120
    const out: Cluster[] = []
    for (const p of pins) {
      let nearest: Cluster | null = null
      let bestD = Infinity
      for (const c of out) {
        const d = haversineMeters(p.lat, p.lng, c.lat, c.lng)
        if (d < bestD && d <= CLUSTER_RADIUS_M) {
          bestD = d
          nearest = c
        }
      }
      if (nearest) {
        const n = nearest.pins.length
        nearest.pins.push(p)
        // Running mean for the cluster centroid so the marker sits at
        // the middle of the bundle, not pinned to the first photo.
        nearest.lat = (nearest.lat * n + p.lat) / (n + 1)
        nearest.lng = (nearest.lng * n + p.lng) / (n + 1)
      } else {
        out.push({ key: p.docId, lat: p.lat, lng: p.lng, pins: [p] })
      }
    }
    return out
  }, [pins])

  // Initial bounds-fit view, computed exactly once when pins + size
  // are both available. We snapshot it into state so subsequent
  // renders (ResizeObserver ticks, backfill polling) don't push new
  // center/zoom values into pigeon-maps and yank the camera around.
  // The user's pan/zoom is theirs after mount.
  const [view, setView] = useState<{ center: [number, number]; zoom: number } | null>(
    null,
  )
  // Bumped on "Fit all" click. Used as the map's React key so the
  // component remounts and `defaultCenter`/`defaultZoom` re-apply.
  const [viewKey, setViewKey] = useState(0)
  const fitAll = () => {
    setView(null) // forces the effect below to recompute from current pins/size
    setViewKey((k) => k + 1)
  }
  useEffect(() => {
    if (view != null) return
    if (!size) return
    if (pins == null) return
    if (clusters.length === 0) {
      setView({ center: [20, 0], zoom: 2 })
      return
    }
    if (clusters.length === 1) {
      setView({ center: [clusters[0].lat, clusters[0].lng], zoom: 13 })
      return
    }
    let minLat = Infinity, maxLat = -Infinity
    let minLng = Infinity, maxLng = -Infinity
    for (const c of clusters) {
      if (c.lat < minLat) minLat = c.lat
      if (c.lat > maxLat) maxLat = c.lat
      if (c.lng < minLng) minLng = c.lng
      if (c.lng > maxLng) maxLng = c.lng
    }
    setView({
      center: [(minLat + maxLat) / 2, (minLng + maxLng) / 2],
      zoom: zoomToFit({ minLat, maxLat, minLng, maxLng }, { w: size.w, h: size.h }),
    })
  }, [view, size, pins, clusters])

  return (
    <div className="flex-1 flex flex-col overflow-hidden surface">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <button className="btn-ghost h-7 w-7 px-0 shrink-0" onClick={() => navigate('/')} title="Back to vault">
          <ArrowLeft size={14} />
        </button>
        <MapPin size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Map</div>
        {backfilling && (
          <span className="ml-2 text-[11.5px] text-subtle inline-flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            scanning legacy images…
          </span>
        )}
        <div className="flex-1" />
        {pins && pins.length > 0 && (
          <button
            className="btn-ghost"
            onClick={fitAll}
            title="Recenter on all pins"
          >
            <Maximize2 size={12} />
            Fit all
          </button>
        )}
      </header>

      <div ref={wrapRef} className="flex-1 relative overflow-hidden">
        {error && (
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2"
            style={{ background: '#FFEBE6', color: '#BF2600' }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {pins == null ? null : pins.length === 0 && !backfilling ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="rounded-xl p-8 text-center max-w-md"
              style={{ background: 'var(--panel)', border: '1px dashed var(--border)' }}
            >
              <MapPin size={22} className="text-subtle mx-auto mb-2" />
              <div className="text-[14px] text-fg font-medium">No geotagged photos yet</div>
              <div className="text-[12px] text-muted mt-1.5">
                Upload any HEIC / JPEG with GPS in its EXIF and it'll appear here.
                Most phone photos include location by default.
              </div>
            </div>
          </div>
        ) : size && view ? (
          <PigeonMap
            key={viewKey}
            width={size.w}
            height={size.h}
            defaultCenter={view.center}
            defaultZoom={view.zoom}
            onBoundsChanged={({ zoom: z }) => setZoom(z)}
            onClick={() => {
              // Ignore the synthetic map click that fires right after a
              // marker click — otherwise opening a popover immediately
              // closes it. Wider window (500ms) because pigeon-maps
              // can route the map click after a React render tick on
              // slower devices.
              if (Date.now() - markerClickAt.current < 500) return
              setSelected(null)
            }}
            attribution={
              <span style={{ fontSize: 10 }}>© OpenStreetMap contributors</span>
            }
          >
            {clusters.map((c) => {
              const isSelected = selected?.key === c.key
              const isCluster = c.pins.length > 1
              // Marker scales with zoom so it doesn't drape a
              // continent at world view or vanish at street view.
              // Linear interpolation from 36px at zoom 2 to 96px at
              // zoom 14, clamped both ends.
              const size = Math.round(
                Math.max(36, Math.min(96, 30 + (zoom - 2) * 5.5)),
              )
              const half = size / 2
              const cover = c.pins[0]
              return (
                <Overlay
                  key={c.key}
                  anchor={[c.lat, c.lng]}
                  offset={[half, half]}
                >
                  <ThumbMarker
                    coverPath={cover.path}
                    size={size}
                    badge={isCluster ? c.pins.length : null}
                    selected={isSelected}
                    onClick={() => {
                      markerClickAt.current = Date.now()
                      setSelected(c)
                    }}
                  />
                </Overlay>
              )
            })}
            {/* Single-photo selection: in-map popover anchored to the
                marker. Multi-photo clusters use the right-side panel
                rendered outside the map below. */}
            {selected && selected.pins.length === 1 && (
              <Overlay anchor={[selected.lat, selected.lng]} offset={[110, 240]}>
                <ClusterCard
                  cluster={selected}
                  onClose={() => setSelected(null)}
                  onOpen={(pin) => {
                    const segs = pin.path.split('/').map(encodeURIComponent).join('/')
                    navigate(`/${segs}`)
                  }}
                />
              </Overlay>
            )}
          </PigeonMap>
        ) : null}

        {selected && selected.pins.length > 1 && (
          <ClusterSidebar
            cluster={selected}
            onClose={() => setSelected(null)}
            onOpen={(pin) => {
              const segs = pin.path.split('/').map(encodeURIComponent).join('/')
              navigate(`/${segs}`)
            }}
          />
        )}
      </div>
    </div>
  )
}

/** Popover for a marker. Single-pin variant shows the thumbnail + Open;
 *  cluster variant shows a scrollable list of all photos at that point. */
function ClusterCard({
  cluster,
  onClose,
  onOpen,
}: {
  cluster: Cluster
  onClose: () => void
  onOpen: (p: Pin) => void
}) {
  const isCluster = cluster.pins.length > 1
  if (!isCluster) {
    const pin = cluster.pins[0]
    // Whole popover is the click target — opens the file. No "Close"
    // button needed since clicking outside also closes via the map
    // backdrop. A hover hint at the bottom tells you the affordance.
    return (
      <button
        onClick={() => onOpen(pin)}
        className="group block rounded-lg overflow-hidden shadow-raised text-left hover:translate-y-[-1px] transition-transform"
        style={{
          width: 220,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
        }}
        title={`Open ${pin.name}`}
      >
        <img
          src={api.thumbnailUrl(pin.path)}
          alt=""
          className="block w-full h-[140px] object-cover"
        />
        <div className="px-2.5 py-2">
          <div className="text-[12.5px] font-medium text-fg truncate" title={pin.name}>
            {pin.name}
          </div>
          <div className="text-[10.5px] text-subtle mt-0.5 tabular-nums">
            {cluster.lat.toFixed(4)}, {cluster.lng.toFixed(4)}
          </div>
          <div className="text-[10.5px] text-accent mt-2 inline-flex items-center gap-1">
            Click to open
            <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </div>
        </div>
      </button>
    )
  }
  return (
    <div
      className="rounded-lg overflow-hidden shadow-raised"
      style={{
        width: 240,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        className="flex items-center gap-2 px-2.5 h-8"
        style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border-soft)' }}
      >
        <MapPin size={11} className="text-accent" />
        <div className="text-[11.5px] font-semibold text-fg flex-1">
          {cluster.pins.length} photos here
        </div>
        <button className="btn-ghost h-5 w-5 px-0" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {cluster.pins.map((pin) => (
          <button
            key={pin.docId}
            onClick={() => onOpen(pin)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-hover"
          >
            <img
              src={api.thumbnailUrl(pin.path)}
              alt=""
              className="w-10 h-10 object-cover rounded shrink-0"
              style={{ background: 'var(--bg)' }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-fg truncate" title={pin.name}>
                {pin.name}
              </div>
              <div className="text-[10.5px] text-subtle">
                {new Date(pin.createdAt).toLocaleDateString()}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Web Mercator zoom-to-fit. Returns the largest integer zoom level at
 * which the bbox fits inside `viewport` with 80px padding on each side.
 * Mirrors the standard Google-Maps-API formula but adapted for 256px
 * pigeon tiles.
 */
/** Great-circle distance between two WGS84 coords, in meters. Used by
 *  the proximity clustering to decide whether a new pin joins an
 *  existing cluster. Cheaper than Vincenty and accurate enough at the
 *  100m scale we care about here. */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function zoomToFit(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  viewport: { w: number; h: number },
): number {
  // 140px padding so markers + the cluster badge don't hug the edge.
  const PAD = 140
  const WORLD = 256
  // Cap auto-fit zoom at city/neighborhood level. Locations a few
  // hundred meters apart would otherwise pick street-deep zoom
  // (16-17) where the user can't see both markers without panning.
  const ZOOM_MAX = 14

  const latRad = (lat: number) => {
    const sin = Math.sin((lat * Math.PI) / 180)
    const r = Math.log((1 + sin) / (1 - sin)) / 2
    return Math.max(Math.min(r, Math.PI), -Math.PI) / 2
  }

  const latFrac = (latRad(bbox.maxLat) - latRad(bbox.minLat)) / Math.PI
  let lngSpan = bbox.maxLng - bbox.minLng
  if (lngSpan < 0) lngSpan += 360
  const lngFrac = lngSpan / 360

  const usableW = Math.max(1, viewport.w - PAD * 2)
  const usableH = Math.max(1, viewport.h - PAD * 2)

  // log2(usable / (WORLD * fraction)) — picks the zoom where the world
  // tile width matches the bbox's share of the viewport.
  const zForLat = latFrac > 0 ? Math.log2(usableH / (WORLD * latFrac)) : ZOOM_MAX
  const zForLng = lngFrac > 0 ? Math.log2(usableW / (WORLD * lngFrac)) : ZOOM_MAX
  const z = Math.floor(Math.min(zForLat, zForLng))
  return Math.max(2, Math.min(ZOOM_MAX, z))
}

/**
 * Slide-in right rail for a multi-photo cluster. Shows a thumbnail
 * grid of every photo at that point. Backdrop click closes; the
 * panel itself sits above pigeon-maps so map drags don't bleed
 * through.
 */
function ClusterSidebar({
  cluster,
  onClose,
  onOpen,
}: {
  cluster: Cluster
  onClose: () => void
  onOpen: (p: Pin) => void
}) {
  // Group pins by date (newest day first) — Photos / Immich-style
  // date headers make a big grid of photos scannable. Within a date,
  // newest first.
  const grouped = (() => {
    const map = new Map<string, { label: string; pins: Pin[] }>()
    const sorted = [...cluster.pins].sort((a, b) => b.createdAt - a.createdAt)
    for (const p of sorted) {
      const d = new Date(p.createdAt)
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      const label = d.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
      const entry = map.get(key) ?? { label, pins: [] }
      entry.pins.push(p)
      map.set(key, entry)
    }
    return Array.from(map.values())
  })()

  return (
    <>
      <div
        className="fixed inset-0 z-[55]"
        style={{ background: 'rgba(9, 30, 66, 0.18)' }}
        onClick={onClose}
      />
      <aside
        className="fixed top-0 right-0 h-full w-full sm:w-[400px] z-[60] flex flex-col overflow-hidden"
        style={{ background: 'var(--panel)', borderLeft: '1px solid var(--border)' }}
      >
        {/* Header: location pill + chevron-style chip showing N/M.
            Cleaner than the dense two-line subtitle. */}
        <div
          className="px-4 pt-4 pb-3 shrink-0"
          style={{ borderBottom: '1px solid var(--border-soft)' }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-9 h-9 rounded-full inline-flex items-center justify-center shrink-0"
              style={{ background: 'var(--selected)', color: 'var(--accent)' }}
            >
              <MapPin size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-semibold text-fg">
                {cluster.pins.length} {cluster.pins.length === 1 ? 'photo' : 'photos'}
              </div>
              <div className="text-[11.5px] text-subtle mt-0.5 tabular-nums">
                {cluster.lat.toFixed(5)}, {cluster.lng.toFixed(5)}
              </div>
            </div>
            <button
              className="btn-ghost h-7 w-7 px-0 shrink-0"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Photo grid grouped by date. No per-tile card chrome — the
            thumbnails ARE the content. Filenames are still accessible
            via hover overlay + title attr for screen readers. */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {grouped.map((g) => (
            <section key={g.label} className="mb-4 last:mb-1">
              <div className="px-1 pb-1.5 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                {g.label}
                <span className="ml-1.5 font-normal normal-case text-subtle">
                  · {g.pins.length}
                </span>
              </div>
              <div
                className="grid gap-1"
                style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
              >
                {g.pins.map((pin) => (
                  <button
                    key={pin.docId}
                    onClick={() => onOpen(pin)}
                    className="group relative block overflow-hidden rounded-md focus:outline-none focus:ring-2 focus:ring-offset-1"
                    style={{
                      aspectRatio: '1 / 1',
                      background: 'var(--bg)',
                    }}
                    title={pin.name}
                  >
                    <img
                      src={api.thumbnailUrl(pin.path)}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                    {/* Subtle bottom gradient + filename on hover */}
                    <div
                      className="absolute inset-x-0 bottom-0 px-1.5 py-1 text-[10px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{
                        background:
                          'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))',
                      }}
                    >
                      {pin.name}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </aside>
    </>
  )
}

/**
 * Round photo thumbnail used as a map marker. Stops mousedown
 * propagation so clicking the thumb doesn't start a map-drag. Failed
 * thumb loads fall back to a flat colored disk so the marker is still
 * clickable.
 */
function ThumbMarker({
  coverPath,
  size,
  badge,
  selected,
  onClick,
}: {
  coverPath: string
  size: number
  badge: number | null
  selected: boolean
  onClick: () => void
}) {
  const [failed, setFailed] = useState(false)
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        // Outer wrapper holds the badge OUTSIDE the rounded clip-area.
        // The inner div below does the actual border + overflow:hidden
        // so the image gets the rounded corners but the badge floats
        // freely past them.
        width: size,
        height: size,
        cursor: 'pointer',
        position: 'relative',
        padding: 0,
        background: 'transparent',
        border: 'none',
      }}
      title={badge != null ? `${badge} photos here` : 'Photo'}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--bg)',
          border: selected
            ? `2px solid var(--accent)`
            : `1px solid var(--border)`,
          boxShadow: selected
            ? '0 0 0 3px rgba(76, 110, 245, 0.18), 0 2px 10px rgba(9,30,66,0.25)'
            : '0 2px 8px rgba(9,30,66,0.22)',
          boxSizing: 'border-box',
        }}
      >
        {failed ? (
          <div style={{ width: '100%', height: '100%', background: 'var(--panel)' }} />
        ) : (
          <img
            src={api.thumbnailUrl(coverPath)}
            alt=""
            onError={() => setFailed(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        )}
      </div>
      {badge != null && (
        <span
          style={{
            position: 'absolute',
            // Tile size also drives chip offset/size so the proportions
            // hold at every zoom — at zoom 2 we want a tiny chip on a
            // tiny tile, at zoom 14 a chip that's actually readable.
            top: Math.round(-size * 0.12),
            right: Math.round(-size * 0.12),
            minWidth: Math.max(16, Math.round(size * 0.28)),
            height: Math.max(16, Math.round(size * 0.28)),
            borderRadius: 999,
            background: 'var(--accent)',
            color: 'white',
            fontSize: Math.max(10, Math.round(size * 0.13)),
            lineHeight: 1,
            padding: '0 6px',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'center',
            border: '1.5px solid var(--panel)',
            boxShadow: '0 1px 3px rgba(9,30,66,0.20)',
            pointerEvents: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
          }}
        >
          {badge}
        </span>
      )}
    </button>
  )
}
