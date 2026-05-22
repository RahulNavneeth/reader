import { useEffect, useState } from 'react'
import { History, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { VersionDiffModal } from './VersionDiffModal'

type Version = {
  ts: number
  sha256: string
  bytes: number
  title?: string
  hasText: boolean
}

type Props = {
  path: string
  /** The current on-disk text — used as the "right" side of the
   *  diff when the user clicks a version. Null if the viewer
   *  hasn't loaded it yet (we render the list but disable diff
   *  clicks). */
  currentText: string | null
}

/**
 * Standalone version-history rail. Sits beside the outline rail
 * (they're independent siblings — each can be expanded or
 * collapsed without the other) and lists every snapshot the vault
 * watcher captured for this doc.
 *
 * Clicking a row opens a real line-by-line diff against the
 * current text — replaces the old toolbar VersionsButton which
 * couldn't actually show a diff.
 *
 * Collapsed/expanded state persists per-user via localStorage
 * (same pattern the outline rail uses), so the user's preference
 * survives reloads.
 */
export function VersionsRail({ path, currentText }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTs, setActiveTs] = useState<number | null>(null)
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:versionsRailOpen') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('reader:versionsRailOpen', open ? '1' : '0') } catch { /* ignore */ }
  }, [open])

  useEffect(() => {
    let cancelled = false
    setVersions(null)
    setError(null)
    api
      .fileVersions(path)
      .then((r) => {
        if (cancelled) return
        setVersions(r.versions)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path])

  // Hide the rail entirely when there are no versions. The vault
  // watcher captures a snapshot on any on-disk change, so a fresh
  // doc legitimately has zero entries until something happens.
  if (versions !== null && versions.length === 0 && !error) return null

  if (!open) {
    return (
      <>
        <div
          className="w-8 shrink-0 border-l flex flex-col items-stretch"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
        >
          <button
            className="h-11 w-full inline-flex items-center justify-center border-b transition-colors hover:bg-hover"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-subtle)' }}
            onClick={() => setOpen(true)}
            title="Expand versions"
            aria-label="Expand versions"
          >
            <PanelRightOpen size={12} />
          </button>
        </div>
        {activeTs !== null && currentText !== null && (
          <VersionDiffModal
            path={path}
            ts={activeTs}
            currentText={currentText}
            onClose={() => setActiveTs(null)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <aside
        className="w-[240px] shrink-0 border-l overflow-y-auto"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      >
        <div
          className="sticky top-0 h-11 px-3 border-b text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex items-center gap-1.5"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
        >
          <History size={11} />
          <span className="flex-1">Versions</span>
          {versions && (
            <span className="text-[10.5px] text-subtle font-normal mr-1">
              {versions.length}
            </span>
          )}
          <button
            className="btn-ghost h-6 w-6 px-0"
            onClick={() => setOpen(false)}
            title="Collapse versions"
            aria-label="Collapse versions"
          >
            <PanelRightClose size={12} />
          </button>
        </div>
        <div className="px-2 py-2">
          {versions === null && !error && (
            <div className="px-2 py-1.5 text-[11.5px] text-subtle flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div
              className="px-2 py-1.5 text-[11px] rounded"
              style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
            >
              {error}
            </div>
          )}
          {versions && versions.map((v, i) => (
            <button
              key={v.ts}
              onClick={() => {
                if (currentText === null) return
                setActiveTs(v.ts)
              }}
              disabled={currentText === null}
              className="block w-full text-left px-2 py-1 rounded text-[12px] hover:bg-hover transition-colors text-fg truncate disabled:opacity-50 disabled:hover:bg-transparent"
              title={
                currentText === null
                  ? 'Loading doc…'
                  : `Show diff against current — ${new Date(v.ts).toLocaleString()}`
              }
            >
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11.5px] font-medium truncate">
                  {formatVersionLabel(v.ts, i === 0)}
                </span>
              </div>
              <div className="text-[10.5px] text-subtle">
                {(v.bytes / 1024).toFixed(1)} KB · {v.sha256.slice(0, 7)}
              </div>
            </button>
          ))}
        </div>
      </aside>
      {activeTs !== null && currentText !== null && (
        <VersionDiffModal
          path={path}
          ts={activeTs}
          currentText={currentText}
          onClose={() => setActiveTs(null)}
        />
      )}
    </>
  )
}

/** Friendly per-row label. "Just now / Nm ago / Nh ago" up to a
 *  day, then absolute date. The first item shows "Latest" prefix
 *  so the user knows where to look first. */
function formatVersionLabel(ts: number, isLatest: boolean): string {
  const rel = relTime(ts)
  return isLatest ? `Latest · ${rel}` : rel
}

function relTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  const s = Math.floor(delta / 1000)
  if (s < 30) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}
