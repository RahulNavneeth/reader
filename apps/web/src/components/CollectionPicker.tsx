import { useEffect, useState } from 'react'
import { Layers, Check, Loader2, Plus } from 'lucide-react'
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
        const r = await api.addCollectionItems(cid, [docId])
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
      await api.addCollectionItems(r.collection.id, [docId])
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
        <div className="flex flex-col gap-1">
          {collections.map((c) => {
            const inIt = containing.has(c.id)
            const isBusy = busy === c.id
            return (
              <button
                key={c.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-hover"
                onClick={() => toggle(c.id)}
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
          })}
          {!createOpen ? (
            <button
              className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-hover text-subtle text-[12px]"
              onClick={() => setCreateOpen(true)}
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
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createAndAdd()
                  if (e.key === 'Escape') {
                    setCreateOpen(false)
                    setNewName('')
                  }
                }}
                disabled={creating}
              />
              <button
                className="btn-primary h-6 px-2 text-[11px]"
                onClick={createAndAdd}
                disabled={creating || !newName.trim()}
              >
                {creating ? <Loader2 size={10} className="animate-spin" /> : 'Create'}
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="text-[11px] mt-1.5" style={{ color: '#BF2600' }}>
          {error}
        </div>
      )}
    </div>
  )
}
