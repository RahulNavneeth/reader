import { useEffect, useRef, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Version = {
  ts: number
  sha256: string
  bytes: number
  title?: string
  hasText: boolean
}

/**
 * Header trigger that shows the file's edit history. Each row is a snapshot
 * taken by the vault watcher when the on-disk content changed. Clicking a
 * row loads that version's extracted text into a side-by-side preview pane.
 */
export function VersionsButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [activeTs, setActiveTs] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setActiveTs(null)
      setSnapshot(null)
      return
    }
    api
      .fileVersions(path)
      .then((r) => setVersions(r.versions))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, path])

  const loadVersion = async (ts: number) => {
    setActiveTs(ts)
    setSnapshot(null)
    setBusy(true)
    setError(null)
    try {
      const r = await api.fileVersionText(path, ts)
      setSnapshot(r.text)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Only show the button if at least one version exists. Probe lazily on
  // first mount so users don't see a useless control on untouched files.
  const [hasAny, setHasAny] = useState<boolean | null>(null)
  useEffect(() => {
    api
      .fileVersions(path)
      .then((r) => setHasAny(r.versions.length > 0))
      .catch(() => setHasAny(false))
  }, [path])
  if (!hasAny) return null

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Version history"
      >
        <History size={13} />
        Versions
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[480px] rounded-md shadow-card overflow-hidden"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <div className="flex h-[320px]">
            <div className="w-[180px] overflow-y-auto" style={{ borderRight: '1px solid var(--border-soft)' }}>
              {versions == null && !error && (
                <div className="px-3 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </div>
              )}
              {error && (
                <div className="px-3 py-2 text-[11.5px]" style={{ color: '#BF2600' }}>
                  {error}
                </div>
              )}
              {versions && versions.length === 0 && (
                <div className="px-3 py-2 text-[11.5px] text-subtle">No saved versions.</div>
              )}
              {versions &&
                versions.map((v) => (
                  <button
                    key={v.ts}
                    onClick={() => loadVersion(v.ts)}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-hover"
                    style={{
                      background: activeTs === v.ts ? 'var(--selected)' : undefined,
                      color: activeTs === v.ts ? 'var(--accent)' : 'var(--fg)',
                      borderBottom: '1px solid var(--border-soft)',
                    }}
                  >
                    <div className="text-[11.5px] font-medium truncate">
                      {new Date(v.ts).toLocaleString()}
                    </div>
                    <div className="text-[10.5px] text-subtle">
                      {(v.bytes / 1024).toFixed(1)} KB · {v.sha256.slice(0, 7)}
                    </div>
                  </button>
                ))}
            </div>
            <div className="flex-1 overflow-y-auto p-2.5">
              {activeTs == null ? (
                <div className="text-[11.5px] text-subtle">
                  Select a version on the left to preview its extracted text.
                </div>
              ) : busy ? (
                <div className="text-[11.5px] text-muted flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Loading text…
                </div>
              ) : snapshot != null ? (
                <pre
                  className="text-[11px] whitespace-pre-wrap break-words"
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
                >
                  {snapshot.slice(0, 12_000)}
                  {snapshot.length > 12_000 && '\n\n…truncated…'}
                </pre>
              ) : (
                <div className="text-[11.5px] text-subtle">No extracted text in this snapshot.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
