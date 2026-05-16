import { useEffect, useState } from 'react'
import {
  X,
  Globe,
  Lock,
  Sparkles,
  Star,
  Copy,
  Check,
  Calendar,
  Hash,
  Loader2,
  Share2,
  Tag,
  MapPin,
} from 'lucide-react'
import { Map, Marker } from 'pigeon-maps'
import { api, type DocumentMeta } from '../lib/api'
import { useVault } from '../lib/vault-context'

type Props = {
  /** Vault-relative path. */
  path: string
  meta: DocumentMeta | null
  owner?: string
  open: boolean
  onClose: () => void
}

/**
 * Slide-in right-rail showing rich file metadata. Complements the small
 * FileInfoButton popover by providing a persistent surface for actions
 * (pin, copy hash) and richer data (versions count,
 * recent activity, share grants). Re-uses /api/file/meta data which
 * PathViewer already has loaded.
 */
export function MetadataPanel({ path, meta, owner, open, onClose }: Props) {
  const { refresh } = useVault()
  const [pinned, setPinned] = useState<boolean | null>(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [activity, setActivity] = useState<Array<{ ts: number; action: string }>>([])
  const [versionsCount, setVersionsCount] = useState<number | null>(null)
  const [shaCopied, setShaCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([
      api.listPins().catch(() => ({ pins: [] })),
      api.fileActivity(path, 6).catch(() => ({ entries: [] })),
      api.fileVersions(path).catch(() => ({ versions: [] })),
    ]).then(([pinsR, actR, versR]) => {
      if (cancelled) return
      const norm = path.replace(/^\/+|\/+$/g, '')
      setPinned(
        pinsR.pins.some(
          (p) => p.storageKey === norm && (owner ? p.owner === owner : true),
        ),
      )
      setActivity(actR.entries.map((e) => ({ ts: e.ts, action: e.action })))
      setVersionsCount(versR.versions.length)
    })
    return () => {
      cancelled = true
    }
  }, [open, path, owner])

  // Reset the thumbnail-failed state when the panel is opened for a
  // different file — otherwise navigating from a PDF to a markdown
  // would keep the thumb hidden even on file types that do have one.
  useEffect(() => {
    setThumbFailed(false)
  }, [path])

  if (!open) return null

  const filename = meta?.originalFilename ?? path.split('/').pop() ?? path

  const togglePin = async () => {
    if (pinBusy || pinned == null) return
    setPinBusy(true)
    try {
      if (pinned) {
        await api.removePin({ path, owner })
        setPinned(false)
      } else {
        await api.addPin({ path, owner, isFolder: false })
        setPinned(true)
      }
      refresh()
    } finally {
      setPinBusy(false)
    }
  }

  return (
    <>
      {/* Backdrop — click-away to close. z-index sits above the header's
          search input (z-50) so opening Details fully dims the rest of
          the chrome. */}
      <div
        className="fixed inset-0 z-[55]"
        style={{ background: 'rgba(9, 30, 66, 0.18)' }}
        onClick={onClose}
      />
      <aside
        className="fixed top-0 right-0 h-full w-full sm:w-[380px] z-[60] flex flex-col overflow-y-auto"
        style={{ background: 'var(--panel)', borderLeft: '1px solid var(--border)' }}
      >
        <div
          className="h-11 px-3 flex items-center gap-2 shrink-0"
          style={{ borderBottom: '1px solid var(--border-soft)' }}
        >
          <span className="text-[11.5px] uppercase tracking-wider font-semibold text-subtle flex-1">
            Details
          </span>
          <button className="btn-ghost h-6 w-6 px-0" onClick={onClose}>
            <X size={12} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Thumbnail / preview — hidden entirely when the server has
              no thumbnail for this type (e.g. .md, .txt, .csv) so we
              don't render an awkward empty box. */}
          {!thumbFailed && hasThumbnail(meta?.mime, path) && (
            <div
              className="w-full aspect-video rounded-md overflow-hidden flex items-center justify-center"
              style={{ background: 'var(--bg)' }}
            >
              <img
                src={api.thumbnailUrl(path, { owner })}
                alt=""
                className="max-w-full max-h-full object-contain"
                onError={() => setThumbFailed(true)}
              />
            </div>
          )}

          <div>
            <div className="text-[15px] font-semibold text-fg break-all leading-snug">
              {filename}
            </div>
            <div className="text-[11.5px] text-subtle break-all mt-0.5">
              /{path}
            </div>
          </div>

          {/* Quick action row. */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-ghost"
              onClick={togglePin}
              disabled={pinBusy || pinned == null}
              style={
                pinned
                  ? { background: 'var(--selected)', color: 'var(--accent)' }
                  : undefined
              }
            >
              {pinBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Star
                  size={12}
                  fill={pinned ? 'currentColor' : 'none'}
                  strokeWidth={1.8}
                />
              )}
              {pinned ? 'Pinned' : 'Pin'}
            </button>
          </div>

          {meta && (
            <Section title="About">
              <Row
                label="Size"
                value={formatBytes(meta.bytes)}
              />
              <Row label="Type" value={meta.mime} mono />
              <Row label="Owner" value={meta.owner} />
              <Row
                label="Created"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Calendar size={10} className="text-subtle" />
                    {formatDate(meta.createdAt)}
                  </span>
                }
              />
              <Row label="Updated" value={formatDate(meta.updatedAt)} />
              <Row
                label="Visibility"
                value={
                  meta.public ? (
                    <span
                      className="inline-flex items-center gap-1 font-medium"
                      style={{ color: '#00875A' }}
                    >
                      <Globe size={11} /> Public
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted">
                      <Lock size={11} /> Private
                    </span>
                  )
                }
              />
              <Row
                label="Indexed"
                value={
                  meta.ingest.embedded ? (
                    <span
                      className="inline-flex items-center gap-1 font-medium"
                      style={{ color: 'var(--accent)' }}
                    >
                      <Sparkles size={11} /> {meta.ingest.chunkCount ?? 0} chunks
                    </span>
                  ) : (
                    <span className="text-muted">{meta.ingest.status}</span>
                  )
                }
              />
            </Section>
          )}

          {meta?.tags && meta.tags.length > 0 && (
            <Section title="Tags">
              <div className="flex flex-wrap gap-1">
                {meta.tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-1.5 h-[20px] rounded text-[11px]"
                    style={{ background: 'var(--selected)', color: 'var(--accent)' }}
                  >
                    <Tag size={9} />
                    {t}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Photo GPS — only renders when the image had EXIF GPS coords
              (cached as `meta.gps`). Tiny embedded OSM tile with a
              single marker; "Open in map" jumps to the global /map
              view centered on this pin. */}
          {meta?.gps && (
            <Section title="Location">
              <div
                className="rounded-md overflow-hidden"
                style={{
                  height: 160,
                  border: '1px solid var(--border-soft)',
                  position: 'relative',
                }}
              >
                <Map
                  defaultCenter={[meta.gps.lat, meta.gps.lng]}
                  defaultZoom={13}
                  mouseEvents={false}
                  touchEvents={false}
                  attribution={false}
                >
                  <Marker
                    width={26}
                    anchor={[meta.gps.lat, meta.gps.lng]}
                    color="#845EF7"
                  />
                </Map>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10.5px] text-subtle inline-flex items-center gap-1">
                  <MapPin size={9} className="text-subtle" />
                  {meta.gps.lat.toFixed(5)}, {meta.gps.lng.toFixed(5)}
                </span>
                <button
                  className="text-[10.5px] text-accent hover:underline"
                  onClick={() => {
                    window.open('/map', '_blank')
                  }}
                >
                  Open map →
                </button>
              </div>
            </Section>
          )}

          {meta?.entities && hasAnyEntity(meta.entities) && (
            <Section title="Extracted">
              {meta.entities.dates && meta.entities.dates.length > 0 && (
                <EntityRow label="Dates" items={meta.entities.dates} />
              )}
              {meta.entities.amounts && meta.entities.amounts.length > 0 && (
                <EntityRow label="Amounts" items={meta.entities.amounts} />
              )}
              {meta.entities.emails && meta.entities.emails.length > 0 && (
                <EntityRow label="Emails" items={meta.entities.emails} mono />
              )}
              {meta.entities.urls && meta.entities.urls.length > 0 && (
                <EntityRow label="URLs" items={meta.entities.urls} mono />
              )}
              {meta.entities.orgs && meta.entities.orgs.length > 0 && (
                <EntityRow label="Orgs" items={meta.entities.orgs} />
              )}
            </Section>
          )}

          {versionsCount != null && versionsCount > 0 && (
            <Section title="History">
              <Row label="Versions" value={`${versionsCount} on record`} />
            </Section>
          )}

          {activity.length > 0 && (
            <Section title="Recent activity">
              <ol className="space-y-1.5">
                {activity.map((e, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-[12px]">
                    <span
                      className="w-1 h-1 rounded-full mt-1.5 shrink-0"
                      style={{ background: 'var(--accent)' }}
                    />
                    <span className="text-fg flex-1">{prettyAction(e.action)}</span>
                    <span className="text-[10.5px] text-subtle">
                      {timeAgo(e.ts)}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {meta?.sha256 && (
            <Section title="Integrity">
              <div className="flex items-start gap-2">
                <Hash size={11} className="text-subtle mt-0.5 shrink-0" />
                <span className="text-[10.5px] text-subtle break-all flex-1">
                  {meta.sha256}
                </span>
                <button
                  className="btn-ghost h-6 w-6 px-0 shrink-0"
                  title="Copy"
                  onClick={async () => {
                    await navigator.clipboard.writeText(meta.sha256)
                    setShaCopied(true)
                    setTimeout(() => setShaCopied(false), 1500)
                  }}
                >
                  {shaCopied ? (
                    <Check size={11} className="text-accent" />
                  ) : (
                    <Copy size={11} />
                  )}
                </button>
              </div>
            </Section>
          )}

          {owner && (
            <Section title="Access">
              <Row
                label="Shared by"
                value={
                  <span className="inline-flex items-center gap-1">
                    <Share2 size={10} className="text-subtle" />
                    {owner}
                  </span>
                }
              />
            </Section>
          )}
        </div>
      </aside>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-md p-3"
      style={{ border: '1px solid var(--border-soft)' }}
    >
      <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-2">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function Row({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="text-subtle w-[72px] shrink-0">{label}</span>
      <span className="text-fg flex-1 break-all">
        {value}
      </span>
    </div>
  )
}

function EntityRow({ label, items }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] text-subtle mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {items.slice(0, 12).map((s, i) => (
          <span
            key={`${s}-${i}`}
            className="inline-flex items-center px-1.5 h-[18px] rounded text-[11px]"
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border-soft)',
              color: 'var(--fg)',
            }}
            title={s}
          >
            <span className="truncate" style={{ maxWidth: 160 }}>
              {s}
            </span>
          </span>
        ))}
        {items.length > 12 && (
          <span className="text-[10.5px] text-subtle self-center ml-1">
            +{items.length - 12} more
          </span>
        )}
      </div>
    </div>
  )
}

/** True for file types the server actually produces a thumbnail for.
 *  Markdown / text / json / csv are rendered inline, so the thumbnail
 *  pipeline never writes a `thumb.png` for them — we'd 404 and leave
 *  an empty box otherwise. */
function hasThumbnail(mime: string | undefined, path: string): boolean {
  const ext = (path.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
  const noThumbExt = [
    '.md', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml',
    '.toml', '.html', '.htm', '.xml', '.log',
  ]
  if (noThumbExt.includes(ext)) return false
  if (mime && (mime.startsWith('text/') || mime === 'application/json')) return false
  return true
}

function hasAnyEntity(e: NonNullable<DocumentMeta['entities']>): boolean {
  return Boolean(
    (e.dates && e.dates.length) ||
      (e.amounts && e.amounts.length) ||
      (e.emails && e.emails.length) ||
      (e.urls && e.urls.length) ||
      (e.orgs && e.orgs.length),
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function prettyAction(a: string): string {
  switch (a) {
    case 'vault.upload': return 'Uploaded'
    case 'vault.edit': return 'Edited'
    case 'vault.tags': return 'Tags updated'
    case 'vault.visibility': return 'Visibility changed'
    case 'vault.index': return 'Re-indexed'
    case 'vault.move': return 'Moved'
    case 'vault.share-with': return 'Shared with user'
    case 'vault.share-revoke': return 'Share revoked'
    default: return a.replace(/^vault\./, '')
  }
}
