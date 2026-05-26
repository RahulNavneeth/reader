import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar, Image as ImageIcon, FileText, Film } from 'lucide-react'
import { api } from '../lib/api'

type Item = Awaited<ReturnType<typeof api.accountOnThisDay>>['items'][number]

/**
 * "On this day" — surfaces docs whose created or updated MM-DD
 * matches today, from any prior year. Lands at the top of the
 * vault-root view as a horizontally-scrolling row; hidden when
 * there's nothing to show, so it doesn't take up space on a
 * young vault.
 *
 * Each card links to the doc viewer. The year + "N years ago"
 * label is the primary affordance — the title is secondary
 * (truncated) since the user already knows what they wrote on
 * this date.
 */
export function OnThisDayCard() {
  const [items, setItems] = useState<Item[] | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    api
      .accountOnThisDay()
      .then((r) => {
        if (!cancelled) setItems(r.items)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!items || items.length === 0) return null

  return (
    <div
      className="mb-4 rounded-lg overflow-hidden"
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        className="flex items-center gap-2 px-4 py-2 text-[12px] font-semibold"
        style={{ color: 'var(--subtle)', borderBottom: '1px solid var(--border)' }}
      >
        <Calendar size={12} />
        <span className="text-fg">On this day</span>
        <span>·</span>
        <span>
          {items.length} memory{items.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex overflow-x-auto gap-2 p-3">
        {items.map((it) => {
          const Icon =
            it.mimeKind === 'image' ? ImageIcon : it.mimeKind === 'video' ? Film : FileText
          const segs = it.storageKey.split('/').filter(Boolean).map(encodeURIComponent).join('/')
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => navigate(`/${segs}`)}
              className="shrink-0 w-44 text-left rounded-md px-3 py-2 transition-colors hover:bg-[var(--hover)]"
              style={{
                background: 'var(--surface-1)',
                border: '1px solid var(--border)',
              }}
              title={`${it.title} · ${it.year}`}
            >
              <div className="flex items-center gap-1.5 text-[11px] mb-1" style={{ color: 'var(--accent)' }}>
                <Icon size={11} />
                <span>
                  {it.yearsAgo === 1 ? '1 year ago' : `${it.yearsAgo} years ago`}
                </span>
                <span style={{ color: 'var(--subtle)' }}>· {it.year}</span>
              </div>
              <div className="text-[12.5px] text-fg truncate">{it.title}</div>
              <div
                className="text-[11px] truncate"
                style={{ color: 'var(--subtle)' }}
              >
                {it.storageKey}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
