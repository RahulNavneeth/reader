import { useEffect, useRef, useState } from 'react'
import { Plus, X, Trash2, Brain, FileText } from 'lucide-react'
import { api, type UserMemoryDTO, type DocMemoryDTO } from '../lib/api'

type Props = {
  docId: string
  /** Caller controls visibility. `anchorRef` (if provided) is used
   *  to position the popover; otherwise it floats centred. */
  open: boolean
  onClose: () => void
  anchorRef?: React.RefObject<HTMLElement | null>
}

/**
 * Memories management popover. Surfaces both tiers — permanent
 * (per-user, applies everywhere) and per-document (scoped to the
 * current doc + user). Adds + deletes via the AI-memories REST
 * endpoints; closes on outside click or Escape.
 *
 * Mirrors what a power user could otherwise achieve via the
 * `/remember` / `/forget` slash commands, but as a visual panel
 * for discoverability.
 */
export function MemoriesPopover({ docId, open, onClose, anchorRef }: Props) {
  const [userMemories, setUserMemories] = useState<UserMemoryDTO[]>([])
  const [docMemories, setDocMemories] = useState<DocMemoryDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userDraft, setUserDraft] = useState('')
  const [docDraft, setDocDraft] = useState('')
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [u, d] = await Promise.all([
        api.listUserMemories(),
        api.listDocMemories(docId),
      ])
      setUserMemories(u.memories)
      setDocMemories(d.memories)
    } catch (e) {
      setError((e as Error)?.message ?? 'failed to load memories')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    refresh()
  }, [open, docId])

  // Outside click + Esc dismiss.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      // Don't dismiss when the click landed on the toggle button
      // that opened the popover — the caller's onClick handles toggle.
      if (anchorRef?.current && anchorRef.current.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  const handleAddUser = async () => {
    const fact = userDraft.trim()
    if (!fact) return
    setUserDraft('')
    try {
      const r = await api.addUserMemory(fact)
      setUserMemories((cur) => [r.memory, ...cur])
    } catch (e) {
      setError((e as Error)?.message ?? 'failed to add memory')
    }
  }

  const handleAddDoc = async () => {
    const fact = docDraft.trim()
    if (!fact) return
    setDocDraft('')
    try {
      const r = await api.addDocMemory(docId, fact)
      setDocMemories((cur) => [r.memory, ...cur])
    } catch (e) {
      setError((e as Error)?.message ?? 'failed to add memory')
    }
  }

  const handleDelUser = async (id: string) => {
    setUserMemories((cur) => cur.filter((m) => m.id !== id))
    try {
      await api.deleteUserMemory(id)
    } catch (e) {
      // Re-fetch on failure so optimistic state matches truth.
      refresh()
      setError((e as Error)?.message ?? 'failed to delete memory')
    }
  }

  const handleDelDoc = async (id: string) => {
    setDocMemories((cur) => cur.filter((m) => m.id !== id))
    try {
      await api.deleteDocMemory(docId, id)
    } catch (e) {
      refresh()
      setError((e as Error)?.message ?? 'failed to delete memory')
    }
  }

  return (
    <div
      ref={popoverRef}
      className="absolute right-2 top-12 z-30 w-[300px] rounded-lg overflow-hidden flex flex-col"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
        maxHeight: 'calc(100vh - 120px)',
      }}
    >
      <div
        className="px-2.5 h-8 flex items-center gap-2 shrink-0"
        style={{ borderBottom: '1px solid var(--border-soft)' }}
      >
        <Brain size={11} className="text-accent shrink-0" />
        <span className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex-1">
          Memories
        </span>
        <button className="btn-ghost h-5 w-5 px-0" onClick={onClose} aria-label="Close">
          <X size={10} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div
            className="m-1.5 text-[11.5px] px-2 py-1 rounded"
            style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
          >
            {error}
          </div>
        )}

        <Section
          icon={<Brain size={10} className="text-muted" />}
          title="Permanent"
          items={userMemories}
          draft={userDraft}
          onDraftChange={setUserDraft}
          onAdd={handleAddUser}
          onDelete={handleDelUser}
          loading={loading && userMemories.length === 0}
          placeholder="Use ₹ for currency"
        />

        <div style={{ borderTop: '1px solid var(--border-soft)' }} />

        <Section
          icon={<FileText size={10} className="text-muted" />}
          title="This doc"
          items={docMemories}
          draft={docDraft}
          onDraftChange={setDocDraft}
          onAdd={handleAddDoc}
          onDelete={handleDelDoc}
          loading={loading && docMemories.length === 0}
          placeholder="PPFCF = Parag Parikh Flexi Cap"
        />
      </div>
    </div>
  )
}

function Section({
  icon,
  title,
  items,
  draft,
  onDraftChange,
  onAdd,
  onDelete,
  loading,
  placeholder,
}: {
  icon: React.ReactNode
  title: string
  items: Array<{ id: string; fact: string }>
  draft: string
  onDraftChange: (v: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
  loading: boolean
  placeholder: string
}) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5 px-1 mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-semibold text-subtle">
          {title}
        </span>
        {items.length > 0 && (
          <span className="text-[10px] text-subtle/70">· {items.length}</span>
        )}
      </div>
      {loading && (
        <div className="px-1 text-[11.5px] text-subtle">Loading…</div>
      )}
      {items.map((m) => (
        <div
          key={m.id}
          className="group flex items-center gap-1.5 px-1.5 h-7 text-[12px] rounded hover:bg-hover"
        >
          <span className="flex-1 truncate" title={m.fact}>{m.fact}</span>
          <button
            className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 inline-flex items-center justify-center h-5 w-5 rounded text-subtle hover:text-fg"
            onClick={() => onDelete(m.id)}
            title="Forget this"
            aria-label="Delete memory"
          >
            <Trash2 size={10} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1 mt-1">
        <input
          className="flex-1 text-[12px] px-2 h-7 rounded"
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            outline: 'none',
          }}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onAdd()
            }
          }}
        />
        <button
          className="h-7 w-7 inline-flex items-center justify-center rounded disabled:opacity-30"
          style={{
            background: draft.trim() ? 'var(--accent)' : 'var(--panel-2)',
            color: draft.trim() ? 'white' : 'var(--fg-subtle)',
          }}
          onClick={onAdd}
          disabled={!draft.trim()}
          aria-label="Add memory"
          title="Add memory"
        >
          <Plus size={11} />
        </button>
      </div>
    </div>
  )
}
