import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  AlertCircle,
  Play,
  FileText,
  Folder,
  ArrowUp,
  Loader2,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useVault } from '../lib/vault-context'

type Folder = Awaited<ReturnType<typeof api.accountArchive>>['folders'][number]
type FileItem = Awaited<ReturnType<typeof api.accountArchive>>['files'][number]

/**
 * Archive view at /archive. Renders archived folders + archived files
 * as a single thumbnail grid — folders appear as folder tiles, files
 * as image/video/generic tiles same as Timeline. Files that already
 * sit under an archived folder are de-duplicated server-side so the
 * grid doesn't show the same content twice (the folder represents
 * its contents).
 *
 * Hover any tile to reveal an "Unarchive" button. Folders cascade
 * implicitly — unarchiving the folder restores every descendant
 * because they were never individually flagged in the first place.
 */
export function ArchivePage() {
  const navigate = useNavigate()
  const { refresh } = useVault()
  const [folders, setFolders] = useState<Folder[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.accountArchive()
      setFolders(r.folders)
      setFiles(r.files)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Show/hide the back-to-top button based on scroll position.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setShowScrollTop(el.scrollTop > 400)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const openItem = (path: string) => {
    const segs = path.split('/').map(encodeURIComponent).join('/')
    navigate(`/${segs}`)
  }

  const unarchive = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    setBusyPath(path)
    setError(null)
    try {
      await api.fileArchive(path, false)
      // Optimistic prune from the local lists; the next vault refresh
      // brings the doc/folder back into default views.
      setFolders((prev) => prev.filter((f) => f.path !== path))
      setFiles((prev) => prev.filter((f) => f.path !== path))
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyPath(null)
    }
  }

  const totalItems = folders.length + files.length

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
          aria-label="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <Archive size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Archive</div>
        {!loading && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {totalItems} {totalItems === 1 ? 'item' : 'items'}
          </span>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2 max-w-[1080px] mx-auto"
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-fg)',
              border: '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
            }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {!loading && totalItems === 0 && !error && (
          <div className="h-full flex items-center justify-center">
            <div
              className="rounded-xl p-8 text-center max-w-md"
              style={{ background: 'var(--viewer)', border: '1px dashed var(--border)' }}
            >
              <Archive size={22} className="text-subtle mx-auto mb-2" />
              <div className="text-[14px] text-fg font-medium">Nothing archived</div>
              <div className="text-[12px] text-muted mt-1.5">
                Archived files and folders are hidden from your default vault,
                timeline, and search — and stay around indefinitely. Use the
                Archive button in any doc or folder toolbar to move it here.
              </div>
            </div>
          </div>
        )}

        <div className="max-w-[1080px] mx-auto">
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
          >
            {folders.map((f) => (
              <ArchiveTile
                key={`folder:${f.path}`}
                label={f.name}
                kind="folder"
                onOpen={() => openItem(f.path)}
                onUnarchive={(e) => unarchive(e, f.path)}
                busy={busyPath === f.path}
              />
            ))}
            {files.map((it) => (
              <ArchiveTile
                key={`file:${it.docId}`}
                label={it.name}
                kind={it.kind}
                thumbSrc={
                  it.kind === 'image' || it.kind === 'video'
                    ? api.thumbnailUrl(it.path)
                    : undefined
                }
                onOpen={() => openItem(it.path)}
                onUnarchive={(e) => unarchive(e, it.path)}
                busy={busyPath === it.path}
              />
            ))}
          </div>
        </div>
      </div>

      {showScrollTop && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
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

function ArchiveTile({
  label,
  kind,
  thumbSrc,
  busy,
  onOpen,
  onUnarchive,
}: {
  label: string
  kind: 'folder' | 'image' | 'video' | 'file'
  thumbSrc?: string
  busy?: boolean
  onOpen: () => void
  onUnarchive: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onClick={onOpen}
      className="group relative overflow-hidden rounded-md cursor-pointer"
      style={{
        aspectRatio: '1 / 1',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
      }}
      title={label}
    >
      {kind === 'folder' ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2"
          style={{ background: 'var(--surface-2)' }}
        >
          <Folder size={32} className="text-accent" strokeWidth={1.4} />
          <div className="text-[12px] text-fg text-center leading-tight line-clamp-3 break-all px-1">
            {label}
          </div>
        </div>
      ) : kind === 'file' ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2"
          style={{ background: 'var(--surface-2)' }}
        >
          <FileText size={28} className="text-subtle" strokeWidth={1.4} />
          <div className="text-[11px] text-fg text-center leading-tight line-clamp-3 break-all">
            {label}
          </div>
        </div>
      ) : (
        <>
          {thumbSrc && (
            <img
              src={thumbSrc}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => {
                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
          )}
          {kind === 'video' && (
            <div
              className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full inline-flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.55)' }}
            >
              <Play size={10} color="white" fill="white" />
            </div>
          )}
        </>
      )}

      <div
        className="absolute top-1.5 left-1.5 px-1.5 h-4 rounded inline-flex items-center text-[9px] font-semibold uppercase tracking-wider"
        style={{ background: 'var(--accent)', color: 'white' }}
      >
        Archived
      </div>

      {/* Hover-revealed Unarchive — floating chip, no gradient
          overlay. The old `rgba(0,0,0,0.55)` scrim looked correct
          on photo thumbnails but read as a heavy dark wash on
          folder + file tiles in light mode. The accent chip alone
          has enough contrast against either surface. */}
      <button
        onClick={onUnarchive}
        disabled={busy}
        className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 px-2 h-6 rounded text-[11px] font-medium opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        style={{
          background: 'var(--accent)',
          color: 'white',
          boxShadow: '0 2px 6px -2px rgba(0, 0, 0, 0.35)',
        }}
        title="Restore to default vault listings"
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <ArchiveRestore size={11} />
        )}
        Unarchive
      </button>
    </div>
  )
}
