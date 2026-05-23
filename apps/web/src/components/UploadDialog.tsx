import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, X, Folder, FileText, Loader2, CornerDownLeft } from 'lucide-react'
import { api } from '../lib/api'

type Props = {
  files: File[]
  defaultDir: string
  onCancel: () => void
  onConfirm: (dir: string) => Promise<void> | void
}

export function UploadDialog({ files, defaultDir, onCancel, onConfirm }: Props) {
  // Input starts empty by default — the user explicitly picks the destination
  // via typing or the suggestion list. `defaultDir` is kept on the prop in case
  // a caller wants to prioritise it in the list, but does not pre-fill input.
  const [dir, setDir] = useState('')
  const [folderList, setFolderList] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  void defaultDir

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
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
  }, [])

  const clean = useMemo(() => dir.trim().replace(/^\/+|\/+$/g, ''), [dir])

  const matches = useMemo(() => {
    const q = clean.toLowerCase()
    if (!q) return folderList.slice(0, 8)
    return folderList.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }, [folderList, clean])

  useEffect(() => {
    setActiveIdx(0)
  }, [clean])

  const submit = async () => {
    setBusy(true)
    try {
      await onConfirm(clean)
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] px-4"
      style={{ background: 'var(--scrim)' }}
      onClick={onCancel}
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
            Upload {files.length} file{files.length === 1 ? '' : 's'}
          </div>
          <div className="flex-1" />
          <button className="btn-ghost h-7 w-7 px-0" onClick={onCancel} disabled={busy}>
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
              onKeyDown={onKeyDown}
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
                <span className="text-[12.5px] text-fg truncate">{f || '(vault root)'}</span>
              </div>
            ))}
          </div>
        )}

        <div className="px-4 py-3 max-h-[180px] overflow-y-auto">
          <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
            Files
          </div>
          <div className="space-y-1">
            {files.map((f, i) => (
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
            <kbd className="px-1 py-0.5 rounded" style={{ background: 'var(--panel)' }}>↵</kbd> to upload ·{' '}
            <kbd className="px-1 py-0.5 rounded" style={{ background: 'var(--panel)' }}>esc</kbd> to cancel
          </div>
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
