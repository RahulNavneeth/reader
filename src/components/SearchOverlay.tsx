import { useEffect, useRef, useState } from 'react'
import { Search, FileText, X } from 'lucide-react'
import { api } from '../lib/api'
import type { SearchHit } from '../types'

type Props = {
  root: string
  onClose: () => void
  onPick: (path: string) => void
}

export function SearchOverlay({ root, onClose, onPick }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.search(root, q.trim())
        if (!cancelled) {
          setResults(r.results)
          setActiveIndex(0)
          setError(null)
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q, root])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[activeIndex]
      if (r) onPick(r.path)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4" onClick={onClose} style={{ background: 'rgba(9,30,66,0.45)' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-lg shadow-raised overflow-hidden"
        style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-app" style={{ borderColor: 'var(--border-soft)' }}>
          <Search size={16} className="text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search across all markdown files…"
            className="flex-1 bg-transparent outline-none text-[14px] text-fg placeholder:text-subtle"
          />
          <span className="text-[11px] text-subtle">{loading ? 'Searching…' : results.length ? `${results.length}` : ''}</span>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {error && <div className="px-4 py-3 text-[13px] text-muted">{error}</div>}
          {!error && q.trim() && results.length === 0 && !loading && (
            <div className="px-4 py-6 text-[13px] text-muted text-center">No matches.</div>
          )}
          {!q.trim() && (
            <div className="px-4 py-6 text-[13px] text-muted text-center">Type to search file contents.</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.path}
              onClick={() => onPick(r.path)}
              onMouseEnter={() => setActiveIndex(i)}
              className="w-full text-left px-4 py-2.5 flex flex-col gap-0.5 transition-colors"
              style={{ background: i === activeIndex ? 'var(--hover)' : 'transparent' }}
            >
              <div className="flex items-center gap-2">
                <FileText size={13} className="text-muted shrink-0" />
                <span className="text-[13px] font-medium text-fg truncate">{r.name}</span>
                <span className="text-[11.5px] text-subtle truncate">{r.path.replace(root, '').replace(/^\/+/, '')}</span>
              </div>
              {r.matches.slice(0, 2).map((m, j) => (
                <div key={j} className="text-[12px] text-muted pl-5 truncate">
                  <span className="text-subtle mr-2">L{m.line}</span>
                  {highlight(m.text, q)}
                </div>
              ))}
            </button>
          ))}
        </div>
        <div className="px-4 h-9 border-t border-soft flex items-center gap-3 text-[11px] text-subtle" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="flex items-center gap-1"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span className="flex items-center gap-1"><span className="kbd">↵</span> open</span>
          <span className="flex items-center gap-1"><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  )
}

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: 'var(--accent-bg)', color: 'var(--fg)', padding: 0 }}>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}
