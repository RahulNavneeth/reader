import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2,
  FileText,
  Sparkles,
  Type,
  FolderPlus,
  Upload,
  CornerDownLeft,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, type SearchHit } from '../lib/api'
import { useVault } from '../lib/vault-context'

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
  query: string
  onClose: () => void
  /** Ref to the header input so click-outside knows to ignore it. */
  inputRef: React.RefObject<HTMLInputElement>
}

export function SearchPalette({ open, query, onClose, inputRef }: Props) {
  const navigate = useNavigate()
  const { triggerUpload, triggerNewFolder, currentUsername } = useVault()
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  // The query string that actually produced the current `hits`. We render
  // against this — not the live `query` — so the dropdown stays on the last
  // settled state until a fresh search completes. No mid-typing flicker.
  const [settledQuery, setSettledQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset transient state whenever the palette opens.
  useEffect(() => {
    if (!open) return
    setHits(null)
    setSettledQuery('')
    setError(null)
    setActiveIdx(0)
  }, [open])

  // Debounced live search.
  useEffect(() => {
    if (!open) return
    if (!query.trim()) {
      setHits(null)
      setSettledQuery('')
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
          setSettledQuery(query.trim())
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
  }, [query, open])

  const openHit = useCallback(
    (hit: SearchHit) => {
      const segs = hit.path.split('/').map(encodeURIComponent).join('/')
      const suffix =
        hit.owner && hit.owner !== currentUsername
          ? `?owner=${encodeURIComponent(hit.owner)}`
          : ''
      navigate(`/${segs}${suffix}`)
      onClose()
    },
    [navigate, onClose, currentUsername],
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
          triggerNewFolder()
          onClose()
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
    [triggerNewFolder, triggerUpload, onClose],
  )

  // Show actions until we have settled hits to display. That covers two cases:
  //   1. Initial open with no query → actions are the only useful thing to show.
  //   2. User just started typing, first search still in flight (hits is null)
  //      → keep actions visible instead of leaving the dropdown empty.
  // Once `hits` is populated, the dropdown is purely results.
  const visibleActions = hits != null ? [] : actions

  // Flat list for keyboard navigation: actions first, then hits.
  const flat = useMemo(() => {
    const out: Array<{ kind: 'action' | 'hit'; idx: number }> = []
    visibleActions.forEach((_, i) => out.push({ kind: 'action', idx: i }))
    if (hits) hits.forEach((_, i) => out.push({ kind: 'hit', idx: i }))
    return out
  }, [visibleActions, hits])

  // Clamp activeIdx whenever the list changes.
  useEffect(() => {
    setActiveIdx((i) => Math.min(Math.max(0, i), Math.max(0, flat.length - 1)))
  }, [flat.length])

  // Keep active row in view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-pos="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  // Window keydown — handles Esc, arrows, Enter while the palette is open. The
  // header input keeps focus the whole time; we just listen at the window level
  // so the same shortcuts work regardless of which element is technically
  // active.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
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
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, flat, activeIdx, visibleActions, hits, openHit, onClose])

  // Click-outside: anything that's neither the header input nor the dropdown.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (rootRef.current?.contains(t)) return
      if (inputRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onClose, inputRef])

  if (!open) return null

  return (
    <div
      ref={rootRef}
      className="absolute top-full left-0 right-0 mt-1.5 z-50 rounded-md overflow-hidden"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 8px 24px -8px rgba(9,30,66,0.18)',
        maxHeight: '70vh',
      }}
    >
      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: '70vh' }}>
        {error && (
          <div className="px-4 py-3 text-[12.5px]" style={{ color: '#BF2600' }}>
            {error}
          </div>
        )}

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

        {!error && settledQuery && hits != null && hits.length === 0 && (
          <div className="px-4 py-6 text-center text-[12.5px] text-subtle">
            No matches for <span className="text-fg">{settledQuery}</span>.
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

        {!error && hits == null && (
          <div className="px-4 py-3 text-[11.5px] text-subtle flex items-center gap-2 border-t" style={{ borderColor: 'var(--border-soft)' }}>
            <CornerDownLeft size={11} />
            <span>
              <kbd className="px-1 py-0.5 rounded" style={{ background: 'var(--panel-2)' }}>↑</kbd>{' '}
              <kbd className="px-1 py-0.5 rounded" style={{ background: 'var(--panel-2)' }}>↓</kbd>{' '}
              navigate ·{' '}
              <kbd className="px-1 py-0.5 rounded" style={{ background: 'var(--panel-2)' }}>↵</kbd>{' '}
              run · {searching ? <Loader2 size={11} className="inline animate-spin" /> : 'type to search'}
            </span>
          </div>
        )}
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
      className="px-3 py-1.5 mx-1 rounded cursor-pointer"
      style={{ background: active ? 'var(--selected)' : 'transparent' }}
    >
      <div className="flex items-center gap-2">
        <FileText size={13} className="text-accent shrink-0" />
        <div className="text-[12.5px] font-medium text-fg truncate flex-1">{hit.title}</div>
        <span className="text-[10.5px] text-subtle truncate hidden sm:inline-block max-w-[180px]">
          {hit.path}
        </span>
        <SourceIcon size={11} className="text-subtle shrink-0" />
      </div>
      <div className="text-[11.5px] text-muted ml-[19px] truncate" title={hit.snippet}>
        {hit.snippet}
      </div>
    </div>
  )
}
