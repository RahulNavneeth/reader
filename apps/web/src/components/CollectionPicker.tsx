import { useEffect, useMemo, useState } from 'react'
import { Layers, Check, Loader2, Plus, Search } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Props = {
  docId: string
}

/**
 * "Add to collection" picker, embedded in MetadataPanel.
 *
 * Fetches the user's own collections + which of them already contain
 * this doc, renders as a checklist. Toggling the checkbox adds or
 * removes the doc from the collection. Plus button below lets the
 * user create a new collection inline and immediately drop the doc
 * into it.
 *
 * Server-side authorization still gates everything — this just
 * surfaces the action UX.
 */
export function CollectionPicker({ docId }: Props) {
  const [collections, setCollections] = useState<
    Array<{ id: string; name: string }> | null
  >(null)
  const [containing, setContaining] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const refresh = async () => {
    try {
      // Fan out the two reads in parallel — neither depends on the
      // other and they tend to land in roughly the same RTT.
      const [list, byDoc] = await Promise.all([
        api.listCollections(),
        api.collectionsByDoc(docId),
      ])
      setCollections(list.mine.map((c) => ({ id: c.id, name: c.name })))
      setContaining(new Set(byDoc.collections.map((c) => c.id)))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const toggle = async (cid: string) => {
    setBusy(cid)
    setError(null)
    try {
      if (containing.has(cid)) {
        await api.removeCollectionItem(cid, docId)
        setContaining((prev) => {
          const next = new Set(prev)
          next.delete(cid)
          return next
        })
      } else {
        const r = await api.addCollectionItems(cid, { docIds: [docId] })
        if (r.skipped.length > 0 && r.added.length === 0) {
          setError(r.skipped[0]?.reason ?? 'could not add')
        } else {
          setContaining((prev) => new Set(prev).add(cid))
        }
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    try {
      const r = await api.createCollection({ name })
      await api.addCollectionItems(r.collection.id, { docIds: [docId] })
      setNewName('')
      setCreateOpen(false)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      {collections == null ? (
        <div className="text-[11.5px] text-muted flex items-center gap-1.5">
          <Loader2 size={11} className="animate-spin" /> Loading…
        </div>
      ) : collections.length === 0 && !createOpen ? (
        <div className="text-[11.5px] text-subtle">
          You don't have any collections yet.
          <button
            className="ml-2 text-accent hover:underline"
            onClick={() => setCreateOpen(true)}
          >
            Create one
          </button>
        </div>
      ) : (
        <CollectionList
          collections={collections!}
          containing={containing}
          busy={busy}
          filter={filter}
          onFilter={setFilter}
          onToggle={toggle}
          createOpen={createOpen}
          onCreateOpen={() => setCreateOpen(true)}
          newName={newName}
          onNewName={setNewName}
          creating={creating}
          onCreate={createAndAdd}
          onCreateCancel={() => {
            setCreateOpen(false)
            setNewName('')
          }}
        />
      )}
      {error && (
        <div className="text-[11px] mt-1.5" style={{ color: '#BF2600' }}>
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Bounded-height list of the caller's collections. Adds a filter
 * input when there are more than 5 entries, caps the scroll region
 * at ~200 px, and keeps the "New collection" trigger pinned beneath
 * the scroll area so it's always reachable. Important for sidebar
 * use — a 30-collection panel shouldn't push everything else out
 * of view.
 */
function CollectionList(props: {
  collections: Array<{ id: string; name: string }>
  containing: Set<string>
  busy: string | null
  filter: string
  onFilter: (v: string) => void
  onToggle: (id: string) => void
  createOpen: boolean
  onCreateOpen: () => void
  newName: string
  onNewName: (v: string) => void
  creating: boolean
  onCreate: () => void
  onCreateCancel: () => void
}) {
  const {
    collections,
    containing,
    busy,
    filter,
    onFilter,
    onToggle,
    createOpen,
    onCreateOpen,
    newName,
    onNewName,
    creating,
    onCreate,
    onCreateCancel,
  } = props
  const showFilter = collections.length > 5
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return collections
    return collections.filter((c) => c.name.toLowerCase().includes(q))
  }, [collections, filter])

  return (
    <div className="flex flex-col gap-1">
      {showFilter && (
        <div className="relative mb-0.5">
          <Search
            size={10}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
          />
          <input
            className="input pl-6 h-6 text-[11.5px]"
            placeholder={`Filter ${collections.length} collections…`}
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          />
        </div>
      )}
      <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto pr-0.5">
        {filtered.length === 0 ? (
          <div className="text-[11.5px] text-subtle px-2 py-1.5">
            No matches.
          </div>
        ) : (
          filtered.map((c) => {
            const inIt = containing.has(c.id)
            const isBusy = busy === c.id
            return (
              <button
                key={c.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-hover"
                onClick={() => onToggle(c.id)}
                disabled={isBusy}
              >
                <span
                  className="w-4 h-4 rounded inline-flex items-center justify-center shrink-0"
                  style={{
                    background: inIt ? 'var(--accent)' : 'transparent',
                    border: `1px solid ${inIt ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  {isBusy ? (
                    <Loader2 size={9} className="animate-spin" color="white" />
                  ) : inIt ? (
                    <Check size={9} color="white" strokeWidth={3} />
                  ) : null}
                </span>
                <Layers size={11} className="text-subtle" />
                <span className="text-[12px] text-fg truncate">{c.name}</span>
              </button>
            )
          })
        )}
      </div>
      {!createOpen ? (
        <button
          className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-hover text-subtle text-[12px]"
          onClick={onCreateOpen}
        >
          <Plus size={11} />
          New collection
        </button>
      ) : (
        <div className="flex items-center gap-1.5 mt-1">
          <input
            autoFocus
            className="input h-6 text-[12px] flex-1"
            placeholder="Collection name"
            value={newName}
            onChange={(e) => onNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreate()
              if (e.key === 'Escape') onCreateCancel()
            }}
            disabled={creating}
          />
          <button
            className="btn-primary h-6 px-2 text-[11px]"
            onClick={onCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? <Loader2 size={10} className="animate-spin" /> : 'Create'}
          </button>
        </div>
      )}
    </div>
  )
}
