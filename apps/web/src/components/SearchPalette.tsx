import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search as SearchIcon,
  Loader2,
  FileText,
  Sparkles,
  Type,
  FolderPlus,
  Folder,
  Upload,
  CornerDownLeft,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, type SearchHit } from '../lib/api'
import { useVault } from '../lib/vault-context'

type Mode = 'root' | 'new-folder'

type Action = {
  id: string
  label: string
  hint?: string
  icon: typeof FolderPlus
  match: (q: string) => boolean
  run: () => void
}

type Props = {
  open: boolean
  onClose: () => void
}

export function SearchPalette({ open, onClose }: Props) {
  const navigate = useNavigate()
  const { triggerUpload, refresh } = useVault()
  const [mode, setMode] = useState<Mode>('root')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [folderList, setFolderList] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const reset = useCallback(() => {
    setMode('root')
    setQuery('')
    setHits(null)
    setActiveIdx(0)
    setError(null)
    setBusy(false)
  }, [])

  useEffect(() => {
    if (open) {
      reset()
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open, reset])

  // Fetch the folder list once when the palette is opened; used by autocomplete
  // in new-folder mode.
  useEffect(() => {
    if (!open) return
    api.folders().then((r) => setFolderList(r.folders)).catch(() => setFolderList([]))
  }, [open])

  const folderMatches = useMemo(() => {
    if (mode !== 'new-folder') return [] as string[]
    const q = query.trim().toLowerCase()
    const all = folderList
    if (!q) return all.slice(0, 8)
    return all.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }, [mode, query, folderList])

  // Reset cursor on the suggestion list when the query changes.
  useEffect(() => {
    if (mode === 'new-folder') setActiveIdx(0)
  }, [mode, query])

  // Refocus the input whenever the mode changes (e.g. user clicked an action
  // with the mouse, which would otherwise leave focus on the button).
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
  }, [open, mode])

  // Escape handler — capture phase so we run BEFORE the browser's default
  // "blur input" action on Escape. preventDefault then suppresses the blur.
  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (mode !== 'root') reset()
      else onClose()
    }
    window.addEventListener('keydown', onEsc, { capture: true })
    return () => window.removeEventListener('keydown', onEsc, { capture: true })
  }, [open, mode, reset, onClose])

  const submitNewFolder = useCallback(
    async (name: string) => {
      const clean = name.trim().replace(/^\/+|\/+$/g, '')
      if (!clean) return
      setBusy(true)
      setError(null)
      try {
        await api.mkdir(clean)
        refresh()
        onClose()
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [refresh, onClose],
  )

  const actions: Action[] = useMemo(
    () => [
      {
        id: 'new-folder',
        label: 'New folder',
        hint: 'create a folder in the vault',
        icon: FolderPlus,
        match: (q) => /^(new|folder|mkdir|create)/i.test(q.trim()),
        run: () => {
          setMode('new-folder')
          setQuery('')
          setActiveIdx(0)
          setError(null)
        },
      },
      {
        id: 'upload',
        label: 'Upload files',
        hint: 'pick files from disk',
        icon: Upload,
        match: (q) => /^(upload|add|file)/i.test(q.trim()),
        run: () => {
          triggerUpload()
          onClose()
        },
      },
    ],
    [triggerUpload, onClose],
  )

  // Search effect — only in 'root' mode
  useEffect(() => {
    if (!open || mode !== 'root') {
      setHits(null)
      setSearching(false)
      return
    }
    if (!query.trim()) {
      setHits(null)
      setSearching(false)
      return
    }
    let cancel = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.searchKnowledge(query.trim(), 20)
        if (!cancel) {
          setHits(r.hits)
          setActiveIdx(0)
        }
      } catch (e) {
        if (!cancel) setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        if (!cancel) setSearching(false)
      }
    }, 180)
    return () => {
      cancel = true
      clearTimeout(t)
    }
  }, [query, open, mode])

  const openHit = useCallback(
    (hit: SearchHit) => {
      const href = '/docs/' + hit.path.split('/').map(encodeURIComponent).join('/')
      navigate(href)
      onClose()
    },
    [navigate, onClose],
  )

  // Compose the flat list the user navigates with arrow keys
  const flat = useMemo(() => {
    if (mode !== 'root') return [] as Array<{ kind: 'action' | 'hit'; idx: number }>
    const out: Array<{ kind: 'action' | 'hit'; idx: number }> = []
    const visibleActions = query.trim()
      ? actions.filter((a) => a.match(query) || a.label.toLowerCase().includes(query.trim().toLowerCase()))
      : actions
    visibleActions.forEach((_, i) => out.push({ kind: 'action', idx: i }))
    if (hits) hits.forEach((_, i) => out.push({ kind: 'hit', idx: i }))
    return out
  }, [actions, hits, query, mode])

  const visibleActions = useMemo(() => {
    if (mode !== 'root') return []
    return query.trim()
      ? actions.filter((a) => a.match(query) || a.label.toLowerCase().includes(query.trim().toLowerCase()))
      : actions
  }, [actions, query, mode])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape is handled by the capture-phase window listener above.
    if (mode === 'new-folder') {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitNewFolder(query)
        return
      }
      if (folderMatches.length > 0) {
        if (e.key === 'Tab') {
          e.preventDefault()
          const pick = folderMatches[activeIdx] ?? folderMatches[0]
          if (pick) setQuery(pick)
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIdx((i) => Math.min(folderMatches.length - 1, i + 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIdx((i) => Math.max(0, i - 1))
          return
        }
      }
      return
    }
    if (flat.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = flat[activeIdx]
      if (!pick) return
      if (pick.kind === 'action') visibleActions[pick.idx]?.run()
      else if (hits) openHit(hits[pick.idx])
    }
  }

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-pos="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  if (!open) return null

  const placeholder =
    mode === 'new-folder'
      ? 'Folder name (use "/" for nesting, e.g. notes/2026)'
      : 'Search vault, or type "new folder" or "upload"…'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
      style={{ background: 'rgba(9, 30, 66, 0.42)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[640px] rounded-lg shadow-card overflow-hidden flex flex-col"
        style={{ background: 'var(--panel)', maxHeight: '70vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2.5 px-4 h-12 border-b shrink-0"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          {mode === 'new-folder' ? (
            <FolderPlus size={15} className="text-accent shrink-0" />
          ) : (
            <SearchIcon size={15} className="text-subtle shrink-0" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent outline-none text-[14px] text-fg placeholder:text-subtle"
            disabled={busy}
          />
          {(searching || busy) && <Loader2 size={14} className="animate-spin text-subtle" />}
          <kbd
            className="text-[10.5px] px-1.5 py-0.5 rounded font-mono shrink-0"
            style={{ background: 'var(--panel-2)', color: 'var(--fg-subtle)', border: '1px solid var(--border-soft)' }}
          >
            esc
          </kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {error && (
            <div className="px-4 py-3 text-[12.5px]" style={{ color: '#BF2600' }}>
              {error}
            </div>
          )}

          {mode === 'new-folder' && !error && (
            <>
              <div className="px-4 py-2.5 text-[11.5px] text-muted flex items-center gap-2">
                <CornerDownLeft size={11} /> <span>Enter to create · Tab to autocomplete · ↑↓ to pick</span>
              </div>
              {folderMatches.length > 0 && (
                <Section title="Existing folders">
                  {folderMatches.map((f, i) => (
                    <div
                      key={f}
                      data-pos={i}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => {
                        setQuery(f)
                        inputRef.current?.focus()
                      }}
                      className="px-3 py-1.5 mx-1 rounded cursor-pointer flex items-center gap-2"
                      style={{ background: activeIdx === i ? 'var(--selected)' : 'transparent' }}
                    >
                      <Folder size={13} className="text-accent shrink-0" />
                      <span className="text-[12.5px] text-fg truncate">{f}</span>
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}


          {mode === 'root' && (
            <>
              {visibleActions.length > 0 && (
                <Section title="Actions">
                  {visibleActions.map((a, i) => {
                    const pos = i
                    const Icon = a.icon
                    return (
                      <div
                        key={a.id}
                        data-pos={pos}
                        onMouseEnter={() => setActiveIdx(pos)}
                        onClick={() => a.run()}
                        className="px-3 py-2 mx-1 rounded cursor-pointer flex items-center gap-2.5"
                        style={{ background: activeIdx === pos ? 'var(--selected)' : 'transparent' }}
                      >
                        <Icon size={14} className="text-accent shrink-0" />
                        <div className="flex-1 text-[13px] text-fg">{a.label}</div>
                        {a.hint && <div className="text-[11px] text-subtle">{a.hint}</div>}
                      </div>
                    )
                  })}
                </Section>
              )}

              {!error && query.trim() && hits != null && hits.length === 0 && !searching && (
                <div className="px-4 py-6 text-center text-[12.5px] text-subtle">
                  No matches for <span className="text-fg">{query}</span>.
                </div>
              )}

              {!error && hits && hits.length > 0 && (
                <Section title="Search results">
                  {hits.map((h, i) => {
                    const pos = visibleActions.length + i
                    return (
                      <HitRow
                        key={h.docId + (h.chunkIdx ?? 0)}
                        hit={h}
                        active={activeIdx === pos}
                        pos={pos}
                        onHover={() => setActiveIdx(pos)}
                        onClick={() => openHit(h)}
                      />
                    )
                  })}
                </Section>
              )}

              {!error && !query.trim() && (
                <div className="px-4 py-3 text-[11.5px] text-subtle">
                  <kbd className="px-1 py-0.5 rounded font-mono" style={{ background: 'var(--panel-2)' }}>↑</kbd>{' '}
                  <kbd className="px-1 py-0.5 rounded font-mono" style={{ background: 'var(--panel-2)' }}>↓</kbd>{' '}
                  to navigate ·{' '}
                  <kbd className="px-1 py-0.5 rounded font-mono" style={{ background: 'var(--panel-2)' }}>↵</kbd>{' '}
                  to run · type to search documents
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
        {title}
      </div>
      {children}
    </div>
  )
}

function HitRow({
  hit,
  active,
  pos,
  onHover,
  onClick,
}: {
  hit: SearchHit
  active: boolean
  pos: number
  onHover: () => void
  onClick: () => void
}) {
  const SourceIcon = hit.source === 'semantic' || hit.source === 'hybrid' ? Sparkles : Type
  return (
    <div
      data-pos={pos}
      onMouseEnter={onHover}
      onClick={onClick}
      className="px-3 py-2.5 mx-1 my-0.5 rounded cursor-pointer"
      style={{ background: active ? 'var(--selected)' : 'transparent' }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <FileText size={13} className="text-accent shrink-0" />
        <div className="text-[13px] font-medium text-fg truncate flex-1">{hit.title}</div>
        <SourceIcon size={11} className="text-subtle shrink-0" />
        <span className="text-[10.5px] text-subtle font-mono shrink-0">{hit.source}</span>
      </div>
      <div className="text-[11px] text-subtle truncate ml-[19px]">/{hit.path}</div>
      <div
        className="text-[12px] text-muted mt-1 ml-[19px] leading-relaxed"
        style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {hit.snippet}
      </div>
    </div>
  )
}
