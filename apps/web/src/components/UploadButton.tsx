import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Upload, FolderUp, Folder, FileText, Loader2, CornerDownLeft, X } from 'lucide-react'
import { api } from '../lib/api'

/**
 * Upload icon + centered destination overlay. Click the icon to open
 * the OS file picker; once files are chosen a centered panel slides
 * in (dimmed backdrop, pinned at 16vh from the top) with the
 * destination-folder autocomplete (filter, Tab to complete, ↑/↓ to
 * pick) and the list of files about to land.
 *
 * Drag-and-drop on the page still works: App.tsx passes the dropped
 * files in via `pendingFiles`, and we render the same overlay so the
 * user sees the same controls regardless of how they kicked it off.
 */
export function UploadButton({
  pendingFiles,
  setPendingFiles,
  defaultDir,
  onConfirm,
}: {
  /** Files awaiting a destination. Null = popover closed. */
  pendingFiles: File[] | null
  /** Setter App.tsx already owns — used to clear (cancel) or set
   *  (after the file picker resolves). */
  setPendingFiles: (files: File[] | null) => void
  /** Pre-fill hint. Kept on the prop in case a caller wants to
   *  surface it; we don't auto-fill the input so the user explicitly
   *  picks (mirrors the original UploadDialog behavior). */
  defaultDir: string
  /** Final upload kick-off. Resolves when the batch is done. */
  onConfirm: (files: File[], dir: string) => Promise<void>
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  // React strips non-standard attrs like `webkitdirectory` when set
  // via JSX, so attach them imperatively on mount. Without this,
  // the input behaves as a regular file picker instead of a folder
  // picker (was: dialog showed mixed files + folders, "Open" went
  // into the folder instead of selecting it).
  useEffect(() => {
    const el = folderInputRef.current
    if (!el) return
    el.setAttribute('webkitdirectory', '')
    el.setAttribute('directory', '')
    el.setAttribute('mozdirectory', '')
  }, [])
  const inputRef = useRef<HTMLInputElement>(null)
  const [dir, setDir] = useState('')
  const [folderList, setFolderList] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [busy, setBusy] = useState(false)

  const open = pendingFiles != null
  void defaultDir

  // Fetch folder suggestions every time the popover opens — same as
  // NewFolderButton, so a folder created elsewhere shows up.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .folders()
      .then((r) => {
        if (cancelled) return
        setFolderList(['', ...r.folders])
      })
      .catch(() => {
        if (!cancelled) setFolderList([''])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => inputRef.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const clean = useMemo(() => dir.trim().replace(/^\/+|\/+$/g, ''), [dir])

  const matches = useMemo(() => {
    const q = clean.toLowerCase()
    if (!q) return folderList.slice(0, 8)
    return folderList.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }, [folderList, clean])

  useEffect(() => {
    setActiveIdx(0)
  }, [clean])

  const cancel = () => {
    if (busy) return
    setPendingFiles(null)
    setDir('')
  }

  const submit = async () => {
    if (!pendingFiles || busy) return
    setBusy(true)
    try {
      const files = pendingFiles
      // Close the popover immediately — the actual upload runs in
      // App.tsx's progress card and may take a while; we don't want
      // the user staring at a frozen popover.
      setPendingFiles(null)
      setDir('')
      await onConfirm(files, clean)
    } finally {
      setBusy(false)
    }
  }

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault()
      submit()
      return
    }
    if (matches.length > 0) {
      if (e.key === 'Tab') {
        e.preventDefault()
        const pick = matches[activeIdx] ?? matches[0]
        if (pick !== undefined) setDir(pick)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(matches.length - 1, i + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(0, i - 1))
        return
      }
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files
          if (!files || files.length === 0) return
          setPendingFiles(Array.from(files))
          // Reset value so picking the same file twice fires onChange.
          e.target.value = ''
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files
          if (!files || files.length === 0) return
          setPendingFiles(Array.from(files))
          e.target.value = ''
        }}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-hover text-subtle hover:text-fg transition-colors"
        title="Upload files"
        aria-label="Upload files"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <Upload size={13} />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => folderInputRef.current?.click()}
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-hover text-subtle hover:text-fg transition-colors"
        title="Upload folder"
        aria-label="Upload folder"
      >
        <FolderUp size={13} />
      </button>
      {open && pendingFiles && createPortal(
        // Backdrop: dim everything + click-out cancels. Pinned at
        // 16vh from the top so the panel sits comfortably below the
        // app header instead of dead-center where the eye doesn't
        // naturally land first.
        //
        // Portaled into document.body because the toolbar wrapper up
        // the tree has a CSS transform (`-translate-y-1/2`), and a
        // transformed ancestor becomes the containing block for
        // `position:fixed` descendants. Rendering here in-tree would
        // clamp the backdrop to that wrapper's narrow column.
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] px-4"
          style={{ background: 'var(--scrim)' }}
          onClick={cancel}
        >
          <div
            className="w-full max-w-[520px] rounded-lg shadow-card overflow-hidden flex flex-col"
            style={{ background: 'var(--panel)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2.5 px-4 h-12 border-b shrink-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <Upload size={15} className="text-accent" />
              <div className="text-[13.5px] font-medium text-fg">
                Upload {pendingFiles.length} file{pendingFiles.length === 1 ? '' : 's'}
              </div>
              <div className="flex-1" />
              <button className="btn-ghost h-7 w-7 px-0" onClick={cancel} disabled={busy}>
                <X size={13} />
              </button>
            </div>

            <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                Destination folder
              </div>
              <div className="relative">
                <Folder size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
                <input
                  ref={inputRef}
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="(vault root)"
                  className="input pl-8 h-8 text-[13px]"
                  disabled={busy}
                />
              </div>
              <div className="text-[11px] text-subtle mt-1.5 flex items-center gap-2">
                <CornerDownLeft size={10} />
                <span>
                  Saving to <code className="text-fg">/{clean || '(root)'}</code> · Tab to autocomplete · ↑↓ to pick
                </span>
              </div>
            </div>

            {matches.length > 0 && (
              <div
                className="max-h-[200px] overflow-y-auto py-1 border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="px-4 pt-1 pb-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                  Folders
                </div>
                {matches.map((f, i) => (
                  <div
                    key={f || '__root__'}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => {
                      setDir(f)
                      inputRef.current?.focus()
                    }}
                    className="px-3 py-1.5 mx-1 rounded cursor-pointer flex items-center gap-2"
                    style={{ background: activeIdx === i ? 'var(--selected)' : 'transparent' }}
                  >
                    <Folder size={13} className="text-accent shrink-0" />
                    <span className="text-[12.5px] text-fg truncate">
                      {f || '(vault root)'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="px-4 py-3 max-h-[180px] overflow-y-auto">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                Files
              </div>
              <div className="space-y-1">
                {pendingFiles.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-2 text-[12.5px] text-fg">
                    <FileText size={12} className="text-subtle shrink-0" />
                    <span className="truncate flex-1">{f.name}</span>
                    <span className="text-[11px] text-subtle shrink-0">{formatBytes(f.size)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="flex items-center gap-2 px-4 py-3 border-t"
              style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
            >
              <div className="flex-1 text-[11.5px] text-subtle">
                {busy ? 'Uploading…' : `Ready · ${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'}`}
              </div>
              <button className="btn-ghost h-7" onClick={cancel} disabled={busy}>
                Cancel
              </button>
              <button className="btn-primary h-7" onClick={submit} disabled={busy}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Upload
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
