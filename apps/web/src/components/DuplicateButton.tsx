import { useEffect, useMemo, useRef, useState } from 'react'
import { Files as FilesIcon, Folder, Loader2, X } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useNavigate } from 'react-router-dom'

type Props = {
  /** Vault-relative path of the file to duplicate. */
  path: string
  /** Owner of the original — duplicates always land in the
   *  requesting user's vault, but we still hide the button when
   *  this is a shared file (the server would 403). */
  owner?: string
  /** Optional callback fired after a successful duplicate. */
  onDuplicated?: (newPath: string) => void
}

/**
 * Toolbar button that duplicates the current file into a
 * user-chosen folder. The popover wraps a typeahead folder
 * picker — same UX shape as the upload-folder picker so the
 * destination input feels familiar.
 *
 * Icon is `Files` (stacked file glyph) rather than `Copy` so it
 * doesn't visually collide with the toolbar's existing "Copy
 * content to clipboard" button which uses `Copy`.
 */
export function DuplicateButton({ path, owner, onDuplicated }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [folderList, setFolderList] = useState<string[]>([])
  const [folder, setFolder] = useState('')
  const [filename, setFilename] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const origFilename = useMemo(() => {
    const last = path.split('/').filter(Boolean).pop() ?? path
    return last
  }, [path])
  const origDir = useMemo(() => {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i)
  }, [path])

  // Default destination filename: "name (copy).ext". Avoids
  // colliding with the original on the very first duplicate; the
  // user can edit before saving for anything else.
  const defaultCopyName = useMemo(() => {
    const dot = origFilename.lastIndexOf('.')
    if (dot <= 0) return `${origFilename} (copy)`
    return `${origFilename.slice(0, dot)} (copy)${origFilename.slice(dot)}`
  }, [origFilename])

  useEffect(() => {
    if (!open) return
    setFolder(origDir)
    setFilename(defaultCopyName)
    setError(null)
    setActiveIdx(0)
    setTimeout(() => inputRef.current?.focus(), 0)
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
  }, [open, origDir, defaultCopyName])

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current
      if (el && !el.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const cleanFolder = useMemo(
    () => folder.trim().replace(/^\/+|\/+$/g, ''),
    [folder],
  )
  const matches = useMemo(() => {
    const q = cleanFolder.toLowerCase()
    if (!q) return folderList.slice(0, 8)
    return folderList.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }, [folderList, cleanFolder])

  const targetPath = useMemo(() => {
    const safeName = filename.trim().replace(/^\/+|\/+$/g, '')
    if (!safeName) return ''
    return cleanFolder ? `${cleanFolder}/${safeName}` : safeName
  }, [cleanFolder, filename])

  const submit = async () => {
    setError(null)
    const safeName = filename.trim().replace(/^\/+|\/+$/g, '')
    if (!safeName) {
      setError('Enter a filename')
      return
    }
    setBusy(true)
    try {
      const r = await api.duplicate(path, targetPath)
      setOpen(false)
      onDuplicated?.(r.document.storageKey)
      const segs = targetPath
        .split('/')
        .map(encodeURIComponent)
        .join('/')
      navigate(`/${segs}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (owner) return null

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Duplicate file"
        aria-label="Duplicate file"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <FilesIcon size={13} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[340px] rounded-md overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
          }}
        >
          <div
            className="flex items-center gap-2 px-3 h-8"
            style={{
              background: 'var(--panel-2)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <FilesIcon size={13} style={{ color: 'var(--fg-muted)' }} />
            <span className="text-[12px] font-semibold flex-1" style={{ color: 'var(--fg)' }}>
              Duplicate
            </span>
            <button
              type="button"
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--hover)]"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <X size={11} />
            </button>
          </div>
          <div className="px-3 py-3 flex flex-col gap-2.5">
            <div>
              <label
                className="block text-[10.5px] uppercase tracking-wider mb-1"
                style={{ color: 'var(--subtle)' }}
              >
                Filename
              </label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                className="w-full h-7 px-2 text-[12.5px] rounded outline-none"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)',
                }}
              />
            </div>
            <div>
              <label
                className="block text-[10.5px] uppercase tracking-wider mb-1"
                style={{ color: 'var(--subtle)' }}
              >
                Destination folder
              </label>
              <input
                ref={inputRef}
                type="text"
                value={folder}
                placeholder="(vault root)"
                onChange={(e) => setFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActiveIdx((i) => Math.min(i + 1, matches.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActiveIdx((i) => Math.max(i - 1, 0))
                  } else if (e.key === 'Tab' && matches[activeIdx] != null) {
                    e.preventDefault()
                    setFolder(matches[activeIdx])
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (matches[activeIdx] != null && matches[activeIdx] !== folder) {
                      setFolder(matches[activeIdx])
                    } else {
                      void submit()
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setOpen(false)
                  }
                }}
                className="w-full h-7 px-2 text-[12.5px] rounded outline-none"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)',
                }}
              />
              {matches.length > 0 && (
                <ul
                  className="mt-1 max-h-44 overflow-y-auto rounded text-[12px]"
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {matches.map((m, i) => {
                    const isActive = i === activeIdx
                    return (
                      <li
                        key={m + i}
                        className="px-2 py-1 flex items-center gap-1.5 cursor-pointer"
                        style={{
                          background: isActive ? 'var(--hover)' : undefined,
                          color: 'var(--fg)',
                        }}
                        onMouseEnter={() => setActiveIdx(i)}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setFolder(m)
                          inputRef.current?.focus()
                        }}
                      >
                        <Folder size={11} style={{ color: 'var(--subtle)' }} />
                        <span className="truncate">
                          {m || <span style={{ color: 'var(--subtle)' }}>(vault root)</span>}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <div
              className="text-[11px] truncate"
              style={{ color: 'var(--fg-subtle)' }}
              title={targetPath}
            >
              →&nbsp;{targetPath || '(enter a filename)'}
            </div>
            {error && (
              <div
                className="text-[11px] px-2 py-1 rounded"
                style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
              >
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <button
                className="btn-ghost h-7 px-2 text-[12px]"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="h-7 px-2.5 rounded text-[12px] inline-flex items-center gap-1 font-medium"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  opacity: busy ? 0.7 : 1,
                }}
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                Duplicate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
