import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderPlus, Folder, Loader2, CornerDownLeft, X } from 'lucide-react'
import { ApiError, api } from '../lib/api'

/**
 * Centered overlay panel for creating a new folder. Mirrors the
 * UploadDialog's presentation — fixed-position card pinned near the
 * top of the viewport with a dimmed backdrop — so this action feels
 * like a deliberate creation step, not a tiny icon-anchored popover.
 *
 * Behaviors (same as the UploadDialog destination picker):
 *   - existing folders show in a filtered list below the input
 *   - typing filters the list
 *   - Tab autocompletes to the highlighted suggestion (so you can
 *     pick a parent, then keep typing "/sub" to create a nested
 *     folder in one shot)
 *   - ↑/↓ moves the highlight
 *   - Enter creates the folder at the typed path
 *   - Esc / click-on-backdrop / Cancel button closes
 *
 * The list always includes "" (vault root) as the first option, so
 * Tab + Enter from an empty input creates a top-level folder named
 * after whatever you type next.
 */
export function NewFolderButton({
  onCreated,
  open: openProp,
  onOpenChange,
  currentDir = '',
}: {
  onCreated: () => void
  /** Controlled-open. When omitted, the button manages its own
   *  open state. App.tsx passes both so the ⌘K palette can pop the
   *  popover open without the user having to re-click the icon. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Folder the user is currently browsing. The input pre-fills with
   *  `<currentDir>/` on open so the user just types the leaf name
   *  to create a sibling — matches Finder / VS Code behavior. */
  currentDir?: string
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = (next: boolean | ((cur: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next
    if (onOpenChange) onOpenChange(resolved)
    else setUncontrolledOpen(resolved)
  }
  const [name, setName] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [folderList, setFolderList] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch the folder list on first open. Re-fetch every open so a
  // folder created in another tab shows up in suggestions without
  // a page reload.
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

  // Open lifecycle: pre-fill with the current folder + trailing slash
  // so the caret lands right where the user types the leaf name, focus
  // the input, and bind Esc to close. Click-outside is handled by the
  // backdrop element itself, so no global doc-click listener is needed.
  useEffect(() => {
    if (!open) return
    const prefill = currentDir ? `${currentDir.replace(/\/+$/, '')}/` : ''
    setName(prefill)
    setError(null)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      // Place caret at the end so typing immediately appends the leaf.
      const len = prefill.length
      el.setSelectionRange(len, len)
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentDir])

  const clean = useMemo(() => name.trim().replace(/^\/+|\/+$/g, ''), [name])

  const matches = useMemo(() => {
    const q = clean.toLowerCase()
    if (!q) return folderList.slice(0, 8)
    return folderList.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }, [folderList, clean])

  useEffect(() => {
    setActiveIdx(0)
  }, [clean])

  const submit = async () => {
    if (!clean) return
    setBusy(true)
    setError(null)
    try {
      await api.mkdir(clean)
      setOpen(false)
      setName('')
      onCreated()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
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
        if (pick !== undefined) setName(pick)
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
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-hover text-subtle hover:text-fg transition-colors"
        title="New folder"
        aria-label="New folder"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <FolderPlus size={13} />
      </button>
      {open && createPortal(
        // Backdrop: dim the rest of the app + close on click-out.
        // Pinned near the top (16vh) instead of dead-center so the
        // panel stays visible alongside whatever folder grid the
        // user was browsing — matches the UploadDialog convention.
        //
        // Portaled into document.body because the toolbar wrapper up
        // the tree uses Tailwind's `-translate-y-1/2`. A transformed
        // ancestor becomes the containing block for `position:fixed`
        // descendants (CSS spec quirk), so a fixed `inset-0` inside
        // it would clamp the backdrop to that wrapper's bounds and
        // squash the panel into a thin column.
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] px-4"
          style={{ background: 'rgba(9, 30, 66, 0.42)' }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-[480px] rounded-lg shadow-card overflow-hidden flex flex-col"
            style={{ background: 'var(--panel)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2.5 px-4 h-12 border-b shrink-0"
              style={{ borderColor: 'var(--border-soft)' }}
            >
              <FolderPlus size={15} className="text-accent" />
              <div className="text-[13.5px] font-medium text-fg">New folder</div>
              <div className="flex-1" />
              <button
                className="btn-ghost h-7 w-7 px-0"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                <X size={13} />
              </button>
            </div>

            <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                Folder name
              </div>
              <div className="relative">
                <Folder size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
                <input
                  ref={inputRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="folder-name"
                  className="input pl-8 h-8 text-[13px]"
                  disabled={busy}
                />
              </div>
              <div className="text-[11px] text-subtle mt-1.5 flex items-center gap-2">
                <CornerDownLeft size={10} />
                <span>
                  Create <code className="text-fg">/{clean || '…'}</code> · Tab to autocomplete · ↑↓ to pick
                </span>
              </div>
            </div>

            {matches.length > 0 && (
              <div
                className="max-h-[220px] overflow-y-auto py-1 border-b"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                <div className="px-4 pt-1 pb-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                  Folders
                </div>
                {matches.map((f, i) => (
                  <div
                    key={f || '__root__'}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => {
                      setName(f)
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

            <div
              className="flex items-center gap-2 px-4 py-3"
              style={{ borderTop: '1px solid var(--border-soft)', background: 'var(--panel-2)' }}
            >
              <div
                className="flex-1 text-[11.5px]"
                style={error ? { color: '#BF2600' } : { color: 'var(--fg-subtle)' }}
              >
                {error ?? (clean ? `Creates /${clean}` : 'Type a name to create')}
              </div>
              <button className="btn-ghost h-7" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn-primary h-7"
                onClick={submit}
                disabled={busy || !clean}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
                Create
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
