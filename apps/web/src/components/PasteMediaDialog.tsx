import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder, ImageIcon, Loader2, X } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Props = {
  /** The file the user just pasted. */
  file: File
  /** Vault-relative path of the doc the user is editing. Used to
   *  derive sensible default destinations (the doc's parent dir
   *  + a `media/` subfolder there). */
  docPath: string
  /** Called with the uploaded file's vault path + the markdown
   *  snippet to insert at the cursor. The caller (CrdtEditor)
   *  dispatches the actual insertion. */
  onUploaded: (info: { vaultPath: string; markdown: string }) => void
  onCancel: () => void
}

/**
 * Modal that appears when the user pastes an image (or other
 * media) into the markdown editor. Lets them pick:
 *   1. Filename — pre-filled with a timestamped default so back-
 *      to-back pastes don't collide.
 *   2. Destination folder — typeahead over `api.folders()` with
 *      quick presets: vault-root `media/`, the doc's own
 *      `media/` subfolder, and a custom typeahead.
 *
 * On save: uploads via `api.upload(file, { dir })`, then bubbles
 * up the inserted-path + a markdown snippet (`![alt](path)` for
 * images, `[name](path)` otherwise). The caller inserts it at
 * the cursor.
 *
 * Esc cancels, Cmd/Ctrl-Enter saves.
 */
export function PasteMediaDialog({ file, docPath, onUploaded, onCancel }: Props) {
  const isImage = useMemo(() => file.type.startsWith('image/'), [file])
  const ext = useMemo(() => {
    // Fallback chain for files dragged from screenshots / random
    // sources where `file.name` is "image.png" or just "blob".
    const fromName = file.name.includes('.')
      ? file.name.slice(file.name.lastIndexOf('.'))
      : ''
    if (fromName) return fromName
    const mime = file.type.toLowerCase()
    if (mime === 'image/png') return '.png'
    if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg'
    if (mime === 'image/webp') return '.webp'
    if (mime === 'image/gif') return '.gif'
    if (mime === 'image/svg+xml') return '.svg'
    if (mime.startsWith('video/')) return '.' + mime.split('/')[1]
    return ''
  }, [file])

  const docDir = useMemo(() => {
    const i = docPath.lastIndexOf('/')
    return i < 0 ? '' : docPath.slice(0, i)
  }, [docPath])

  // Presets — the user can pick one or type their own. Each
  // preset has a short label + the path that gets used, shown
  // separately so the user sees WHAT the choice does before
  // they pick it.
  const presets = useMemo(() => {
    const out: { id: string; label: string; hint: string; dir: string }[] = []
    if (docDir) {
      out.push({
        id: 'doc-media',
        label: 'Next to this doc',
        hint: `${docDir}/media/`,
        dir: `${docDir}/media`,
      })
    }
    out.push({
      id: 'vault-media',
      label: 'Vault root',
      hint: 'media/',
      dir: 'media',
    })
    if (docDir) {
      out.push({
        id: 'doc-here',
        label: 'Same folder as doc',
        hint: `${docDir}/`,
        dir: docDir,
      })
    }
    return out
  }, [docDir])

  // Default destination: the doc-adjacent media folder if we have
  // one, otherwise vault-root media.
  const [folder, setFolder] = useState<string>(() => presets[0]?.dir ?? 'media')
  const cleanFolder = useMemo(
    () => folder.trim().replace(/^\/+|\/+$/g, ''),
    [folder],
  )

  // Filename defaults to a timestamp so pastes don't clobber each
  // other if the user is sketching ideas fast.
  const defaultName = useMemo(() => {
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19)
    return `paste-${stamp}${ext}`
  }, [ext])
  const [filename, setFilename] = useState(defaultName)
  const [folderList, setFolderList] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filenameRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTimeout(() => filenameRef.current?.select(), 0)
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

  const matches = useMemo(() => {
    const q = cleanFolder.toLowerCase()
    if (!q) return folderList.slice(0, 6)
    return folderList.filter((f) => f.toLowerCase().includes(q)).slice(0, 6)
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
      setError('Filename is required')
      return
    }
    setBusy(true)
    try {
      const renamed = new File([file], safeName, { type: file.type })
      const result = await api.upload(renamed, { dir: cleanFolder })
      const vaultPath = result.path
      // Compute the markdown snippet. For images we prefer the
      // relative-to-doc path so the link survives a vault move
      // (relative to docDir). For non-images: same.
      const relPath = relativeFromDoc(docDir, vaultPath)
      const alt = safeName.replace(/\.[^.]+$/, '')
      const markdown = isImage
        ? `![${alt}](${relPath})`
        : `[${alt}](${relPath})`
      onUploaded({ vaultPath, markdown })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Esc + outside-click cancellation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const node = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, black 35%, transparent)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="rounded-md w-[420px] max-w-[92vw] overflow-hidden"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center gap-2 px-3 h-9"
          style={{
            background: 'var(--panel-2)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <ImageIcon size={13} style={{ color: 'var(--fg-muted)' }} />
          <span
            className="text-[12.5px] font-semibold flex-1"
            style={{ color: 'var(--fg)' }}
          >
            {isImage ? 'Paste image' : 'Paste file'}
          </span>
          <span className="text-[10.5px]" style={{ color: 'var(--subtle)' }}>
            {humanBytes(file.size)}
          </span>
          <button
            type="button"
            className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--hover)]"
            onClick={onCancel}
            aria-label="Cancel"
          >
            <X size={12} />
          </button>
        </div>

        {isImage && (
          <div
            className="flex items-center justify-center"
            style={{
              background: 'var(--surface-3)',
              borderBottom: '1px solid var(--border)',
              maxHeight: 180,
              overflow: 'hidden',
            }}
          >
            <img
              src={URL.createObjectURL(file)}
              alt=""
              style={{ maxHeight: 180, maxWidth: '100%', display: 'block' }}
              onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)}
            />
          </div>
        )}

        <div className="px-3 py-3 flex flex-col gap-3">
          <div>
            <label
              className="block text-[10.5px] uppercase tracking-wider mb-1"
              style={{ color: 'var(--subtle)' }}
            >
              Filename
            </label>
            <input
              ref={filenameRef}
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
              className="w-full h-7 px-2 text-[12.5px] rounded outline-none"
              style={{
                background: 'var(--surface-3)',
                border: '1px solid var(--border)',
                color: 'var(--fg)',
              }}
            />
          </div>

          <div>
            <label
              className="block text-[10.5px] uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--subtle)' }}
            >
              Save to
            </label>
            {/* Preset rows: each is a clear choice with the
                resolved path shown beneath. The active one has a
                dot indicator + accent treatment so the user knows
                at a glance where the file is going. */}
            <div className="flex flex-col gap-1 mb-1.5">
              {presets.map((p) => {
                const isActive = cleanFolder === p.dir
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setFolder(p.dir)}
                    className="w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 rounded transition-colors"
                    style={
                      isActive
                        ? {
                            background:
                              'color-mix(in srgb, var(--accent) 14%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
                          }
                        : {
                            background: 'var(--surface-3)',
                            border: '1px solid var(--border)',
                          }
                    }
                  >
                    <span
                      className="shrink-0 w-3 h-3 rounded-full inline-flex items-center justify-center"
                      style={{
                        border: `1.5px solid ${isActive ? 'var(--accent)' : 'var(--fg-subtle)'}`,
                      }}
                    >
                      {isActive && (
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: 'var(--accent)' }}
                        />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-[12px] font-medium"
                        style={{ color: 'var(--fg)' }}
                      >
                        {p.label}
                      </div>
                      <div
                        className="text-[10.5px] truncate"
                        style={{ color: 'var(--fg-subtle)' }}
                      >
                        {p.hint}
                      </div>
                    </div>
                  </button>
                )
              })}
              {/* Custom row — collapses the typeahead input into
                  the choice-list so the radio-style picker stays
                  visually consistent. Always shown so the user
                  knows custom paths (including brand-new folders)
                  are an option. */}
              <button
                type="button"
                onClick={() => {
                  setFolder('')
                  setTimeout(() => folderRef.current?.focus(), 0)
                }}
                className="w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 rounded transition-colors"
                style={
                  !presets.some((p) => p.dir === cleanFolder)
                    ? {
                        background:
                          'color-mix(in srgb, var(--accent) 14%, transparent)',
                        border:
                          '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
                      }
                    : {
                        background: 'var(--surface-3)',
                        border: '1px solid var(--border)',
                      }
                }
              >
                <span
                  className="shrink-0 w-3 h-3 rounded-full inline-flex items-center justify-center"
                  style={{
                    border: `1.5px solid ${
                      !presets.some((p) => p.dir === cleanFolder)
                        ? 'var(--accent)'
                        : 'var(--fg-subtle)'
                    }`,
                  }}
                >
                  {!presets.some((p) => p.dir === cleanFolder) && (
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: 'var(--accent)' }}
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12px] font-medium"
                    style={{ color: 'var(--fg)' }}
                  >
                    Custom folder
                  </div>
                  <div
                    className="text-[10.5px] truncate"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    Pick existing or type a new path to create
                  </div>
                </div>
              </button>
            </div>
            {/* Custom path input — only shows when the user is on
                the Custom row OR has manually typed a non-preset.
                Hidden during preset selection so the radio list
                stays the focal point. */}
            {!presets.some((p) => p.dir === cleanFolder) && (
              <div className="relative">
                <input
                  ref={folderRef}
                  type="text"
                  value={folder}
                  placeholder="e.g. assets/screenshots"
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 100)}
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
                    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                  className="w-full h-7 px-2 text-[12.5px] rounded outline-none"
                  style={{
                    background: 'var(--surface-3)',
                    border: '1px solid var(--border)',
                    color: 'var(--fg)',
                  }}
                />
                {/* Folder-creation hint — when typed path doesn't
                    match any existing folder, surface the fact
                    that we'll create it. */}
                {cleanFolder &&
                  !folderList.includes(cleanFolder) &&
                  showSuggestions && (
                    <div
                      className="absolute right-2 top-1 text-[10px]"
                      style={{ color: 'var(--accent)' }}
                    >
                      will be created
                    </div>
                  )}
                {showSuggestions && matches.length > 0 && (
                  <ul
                    className="mt-1 max-h-36 overflow-y-auto rounded text-[12px]"
                    style={{
                      background: 'var(--surface-3)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {matches.map((m, i) => (
                      <li
                        key={m + i}
                        className="px-2 py-1 flex items-center gap-1.5 cursor-pointer"
                        style={{
                          background: i === activeIdx ? 'var(--hover)' : undefined,
                          color: 'var(--fg)',
                        }}
                        onMouseEnter={() => setActiveIdx(i)}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setFolder(m)
                          folderRef.current?.focus()
                        }}
                      >
                        <Folder size={11} style={{ color: 'var(--subtle)' }} />
                        <span className="truncate">
                          {m || <span style={{ color: 'var(--subtle)' }}>(vault root)</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
              onClick={onCancel}
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
              Upload &amp; insert
            </button>
          </div>
          <div
            className="text-[10.5px]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            ⌘/Ctrl + Enter to save · Esc to cancel
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(node, document.body)
}

/** Path of `vaultPath` relative to `docDir`, suitable for an
 *  inline markdown link. Falls back to an absolute-from-root
 *  reference when the file isn't inside the doc's folder
 *  (`/foo/bar.png` syntax avoids ambiguity with the doc's own
 *  storageKey). */
function relativeFromDoc(docDir: string, vaultPath: string): string {
  if (!docDir) return vaultPath
  if (vaultPath.startsWith(docDir + '/')) {
    return vaultPath.slice(docDir.length + 1)
  }
  return '/' + vaultPath
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
