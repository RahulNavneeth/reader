import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, X, Folder, FileText, Loader2 } from 'lucide-react'
import { api } from '../lib/api'

type Props = {
  files: File[]
  defaultDir: string
  onCancel: () => void
  onConfirm: (dir: string) => Promise<void> | void
}

export function UploadDialog({ files, defaultDir, onCancel, onConfirm }: Props) {
  const [dir, setDir] = useState(defaultDir)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDir(defaultDir)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [defaultDir])

  useEffect(() => {
    // Pull top-level + immediate children of the default dir for quick-pick suggestions.
    let cancelled = false
    const load = async () => {
      const acc = new Set<string>()
      acc.add('')
      if (defaultDir) acc.add(defaultDir)
      try {
        const root = await api.list('')
        root.items.filter((n) => n.type === 'dir').forEach((n) => acc.add(n.path))
        if (defaultDir) {
          const sub = await api.list(defaultDir).catch(() => null)
          sub?.items.filter((n) => n.type === 'dir').forEach((n) => acc.add(n.path))
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setSuggestions(Array.from(acc))
    }
    load()
    return () => {
      cancelled = true
    }
  }, [defaultDir])

  const clean = useMemo(() => dir.trim().replace(/^\/+|\/+$/g, ''), [dir])
  const filteredSuggestions = useMemo(() => {
    const q = clean.toLowerCase()
    return suggestions
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 8)
  }, [suggestions, clean])

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
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] px-4"
      style={{ background: 'rgba(9, 30, 66, 0.42)' }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[520px] rounded-lg shadow-card overflow-hidden flex flex-col"
        style={{ background: 'var(--panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2.5 px-4 h-12 border-b shrink-0"
          style={{ borderColor: 'var(--border-soft)' }}
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

        <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
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
          <div className="text-[11px] text-subtle mt-1.5">
            Will save to <code className="text-fg">/{clean || '(root)'}</code>. Use <code>/</code> for nesting; folders are created if missing.
          </div>

          {filteredSuggestions.length > 0 && (
            <div className="mt-3">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                Quick pick
              </div>
              <div className="flex flex-wrap gap-1.5">
                {filteredSuggestions.map((s) => (
                  <button
                    key={s || '__root__'}
                    onClick={() => setDir(s)}
                    className="px-2 py-1 rounded text-[11.5px] hover:bg-hover transition-colors flex items-center gap-1.5"
                    style={{
                      background: clean === s ? 'var(--selected)' : 'var(--panel-2)',
                      border: '1px solid var(--border-soft)',
                    }}
                  >
                    <Folder size={10} className="text-subtle" />
                    {s || '(root)'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

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
          style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
        >
          <div className="flex-1 text-[11.5px] text-subtle">
            <kbd className="px-1 py-0.5 rounded font-mono" style={{ background: 'var(--panel)' }}>↵</kbd> to upload ·{' '}
            <kbd className="px-1 py-0.5 rounded font-mono" style={{ background: 'var(--panel)' }}>esc</kbd> to cancel
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
