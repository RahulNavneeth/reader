import { useEffect, useState } from 'react'
import { Tag, ChevronLeft, Loader2 } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../lib/api'

type Item = {
  path: string
  name: string
  ext: string
  docId: string
  tags: string[]
  public: boolean
}

export function TaggedFilesView() {
  const { tag = '' } = useParams()
  const navigate = useNavigate()
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    api
      .filesByTag(tag)
      .then((r) => {
        if (cancelled) return
        setItems(r.items)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [tag])

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header
        className="flex items-center gap-2 px-3 h-11 border-b shrink-0"
        style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
      >
        <button className="btn-ghost h-7 w-7 px-0" onClick={() => navigate('/')} title="Back to vault">
          <ChevronLeft size={14} />
        </button>
        <Tag size={13} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">#{tag}</span>
        <div className="flex-1" />
        <span className="text-[11.5px] text-subtle">
          {items ? `${items.length} match${items.length === 1 ? '' : 'es'}` : ''}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {items == null && !error && (
          <div className="flex items-center justify-center h-full text-muted text-[12.5px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        )}

        {error && (
          <div className="text-[12.5px]" style={{ color: '#BF2600' }}>
            {error}
          </div>
        )}

        {items && items.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-[12.5px] text-muted">No files tagged with #{tag}.</div>
          </div>
        )}

        {items && items.length > 0 && (
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.path}>
                <button
                  className="w-full text-left px-2 h-8 rounded hover:bg-hover flex items-center gap-2"
                  onClick={() =>
                    navigate('/docs/' + it.path.split('/').map(encodeURIComponent).join('/'))
                  }
                >
                  <span className="truncate text-[13px] text-fg">{it.name}</span>
                  <span className="text-[11px] text-subtle truncate">{it.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
