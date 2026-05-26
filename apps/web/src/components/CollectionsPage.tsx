import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Layers,
  Plus,
  Users,
  AlertCircle,
  Loader2,
  X,
  FileText,
  Play,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'

type CollectionMine = Awaited<ReturnType<typeof api.listCollections>>['mine'][number]
type CollectionShared = Awaited<ReturnType<typeof api.listCollections>>['shared'][number]

/**
 * /collections — index page listing the user's own collections plus
 * collections shared with them. New collection inline via a small
 * popover at the top right; clicking a collection routes to /c/:id.
 *
 * Cover-image rendering is light: we fall back to a folder-icon tile
 * when the collection has no explicit coverDocId. A future round can
 * resolve the first member's thumbnail and render that as a real
 * preview; for now the icon tile keeps the page render-cheap.
 */
export function CollectionsPage() {
  const navigate = useNavigate()
  const [mine, setMine] = useState<CollectionMine[]>([])
  const [shared, setShared] = useState<CollectionShared[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.listCollections()
      setMine(r.mine)
      setShared(r.shared)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    try {
      const r = await api.createCollection({ name })
      setNewOpen(false)
      setNewName('')
      navigate(`/c/${r.collection.id}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ background: 'var(--surface-3)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/')}
          title="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <Layers size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Collections</div>
        <div className="flex-1" />
        <button
          className="btn-ghost"
          onClick={() => setNewOpen((v) => !v)}
          aria-expanded={newOpen}
          style={newOpen ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
        >
          <Plus size={13} />
          New collection
        </button>
      </header>

      {newOpen && createPortal(
        // Centered overlay — same shape as New Folder / Upload.
        // Portaled into document.body so any transformed ancestor
        // (the App header's translate row) doesn't clamp position:
        // fixed.
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] px-4"
          style={{ background: 'var(--scrim)' }}
          onClick={() => {
            if (!creating) {
              setNewOpen(false)
              setNewName('')
            }
          }}
        >
          <div
            className="w-full max-w-[480px] rounded-lg shadow-card overflow-hidden flex flex-col"
            style={{ background: 'var(--panel)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2.5 px-4 h-12 border-b shrink-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <Layers size={15} className="text-accent" />
              <div className="text-[13.5px] font-medium text-fg">New collection</div>
              <div className="flex-1" />
              <button
                className="btn-ghost h-7 w-7 px-0"
                onClick={() => {
                  setNewOpen(false)
                  setNewName('')
                }}
                disabled={creating}
              >
                <X size={13} />
              </button>
            </div>
            <div className="px-4 py-4">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                Name
              </div>
              <input
                className="input h-9 text-[13px] w-full"
                placeholder="e.g. Best of 2026"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create()
                  if (e.key === 'Escape') {
                    setNewOpen(false)
                    setNewName('')
                  }
                }}
                disabled={creating}
              />
              <div className="text-[11px] text-subtle mt-2">
                Collections are flat — you can drop any document into them from
                the file panel later.
              </div>
            </div>
            <div
              className="flex items-center justify-end gap-2 px-4 py-3 border-t"
              style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
            >
              <button
                className="btn-ghost h-7"
                onClick={() => {
                  setNewOpen(false)
                  setNewName('')
                }}
                disabled={creating}
              >
                Cancel
              </button>
              <button
                className="btn-primary h-7"
                onClick={create}
                disabled={creating || !newName.trim()}
              >
                {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Create
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2"
            style={{ background: '#FFEBE6', color: '#BF2600' }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {!loading && mine.length === 0 && shared.length === 0 && !error && (
          <div className="h-full flex items-center justify-center">
            <div
              className="rounded-xl p-8 text-center max-w-md"
              style={{ background: 'var(--viewer)', border: '1px dashed var(--border)' }}
            >
              <Layers size={22} className="text-subtle mx-auto mb-2" />
              <div className="text-[14px] text-fg font-medium">No collections yet</div>
              <div className="text-[12px] text-muted mt-1.5">
                Collections are flat, virtual groupings of documents — a doc can
                live in many collections without being copied or moved. Create
                one above to get started.
              </div>
            </div>
          </div>
        )}

        <div className="max-w-[1080px] mx-auto space-y-8">
          {mine.length > 0 && (
            <Section title="Your collections">
              <Grid>
                {mine.map((c) => (
                  <CollectionCard key={c.id} c={c} />
                ))}
              </Grid>
            </Section>
          )}
          {shared.length > 0 && (
            <Section title="Shared with you">
              <Grid>
                {shared.map((c) => (
                  <CollectionCard key={c.id} c={c} sharedFrom={c.owner} role={c.role} />
                ))}
              </Grid>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="px-1 mb-3 text-[12px] uppercase tracking-wider font-semibold text-subtle">
        {title}
      </div>
      {children}
    </section>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
    >
      {children}
    </div>
  )
}

function CollectionCard({
  c,
  sharedFrom,
  role,
}: {
  c: CollectionMine | CollectionShared
  sharedFrom?: string
  role?: 'editor' | 'viewer'
}) {
  return (
    <Link
      to={`/c/${c.id}`}
      /* No `transition-colors`: the card's bg + border come from
         CSS vars that flip on theme swap; a colour transition would
         animate the card ~150ms behind the rest of the chrome.
         Hover-affordance lives on the inner cover/title via their
         own subtle treatments instead. */
      className="group block rounded-md overflow-hidden no-underline"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        <CoverArt preview={c.preview} memberCount={c.memberCount} />
      </div>
      <div className="px-2.5 py-2" style={{ background: 'var(--surface-2)' }}>
        <div className="text-[12.5px] font-medium text-fg truncate" title={c.name}>
          {c.name}
        </div>
        <div className="text-[11px] text-subtle mt-0.5 flex items-center gap-1.5">
          <span>
            {c.memberCount} {c.memberCount === 1 ? 'item' : 'items'}
          </span>
          {sharedFrom && (
            <>
              <span>·</span>
              <Users size={9} />
              <span className="truncate" title={`shared by ${sharedFrom}`}>
                {sharedFrom}
              </span>
              {role === 'viewer' && (
                <span
                  className="px-1 rounded text-[9px] uppercase tracking-wider"
                  style={{ background: 'var(--bg)', color: 'var(--fg-subtle)' }}
                >
                  read
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </Link>
  )
}

/**
 * Cover art for a collection card. Three modes:
 *   - 4+ items: 2×2 mosaic of the first four members' thumbnails
 *   - 1–3 items: single thumbnail filling the square
 *   - 0 items: gradient + faint Layers glyph (visual identity that
 *     doesn't read as "broken / empty placeholder")
 *
 * Square (1:1) aspect — denser cards feel more like a real album
 * grid than the prior 16:10 letterbox.
 */
function CoverArt({
  preview,
  memberCount,
}: {
  preview: Array<{ docId: string; path: string; kind: 'image' | 'video' | 'file' }>
  memberCount: number
}) {
  if (preview.length === 0) {
    return (
      <div
        className="w-full aspect-square flex items-center justify-center"
        style={{ background: 'var(--surface-2)' }}
      >
        <Layers size={26} className="text-subtle" strokeWidth={1.4} />
      </div>
    )
  }
  if (preview.length < 4) {
    const it = preview[0]!
    return (
      <div
        className="relative w-full aspect-square overflow-hidden"
        style={{ background: 'var(--surface-2)' }}
      >
        <CoverTile item={it} mode="single" />
        {memberCount > 1 && (
          <div
            className="absolute bottom-1.5 right-1.5 px-1.5 h-5 rounded inline-flex items-center text-[10px] font-semibold"
            style={{ background: 'rgba(0,0,0,0.65)', color: 'white' }}
          >
            +{memberCount - 1}
          </div>
        )}
      </div>
    )
  }
  return (
    <div
      className="grid w-full aspect-square overflow-hidden"
      style={{
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 1,
        background: 'var(--border)',
      }}
    >
      {preview.slice(0, 4).map((it) => (
        <div key={it.docId} className="relative overflow-hidden" style={{ background: 'var(--surface-2)' }}>
          <CoverTile item={it} mode="mosaic" />
        </div>
      ))}
    </div>
  )
}

function CoverTile({
  item,
  mode,
}: {
  item: { docId: string; path: string; kind: 'image' | 'video' | 'file' }
  mode: 'single' | 'mosaic'
}) {
  if (item.kind === 'file') {
    // Filename inferred from the path's last segment. Without it the
    // tile reads as a blank doc icon and the user can't tell two
    // file-kind collections apart at a glance.
    const filename = item.path.split('/').pop() ?? item.path
    if (mode === 'mosaic') {
      return (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: 'var(--surface-2)' }}
        >
          <FileText size={18} className="text-subtle" strokeWidth={1.4} />
        </div>
      )
    }
    // Single-tile mode: bigger icon + filename so the card has
    // real identity. Plain neutral background — earlier attempts at
    // a tinted gradient read as "out of place" against the rest of
    // the app's neutral palette.
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3"
        style={{ background: 'var(--surface-2)' }}
      >
        <FileText size={36} className="text-subtle" strokeWidth={1.3} />
        <div className="text-[11.5px] text-fg text-center font-medium leading-tight line-clamp-2 break-all">
          {filename}
        </div>
      </div>
    )
  }
  return (
    <>
      <img
        src={api.thumbnailUrl(item.path)}
        alt=""
        className="absolute inset-0 w-full h-full object-cover"
        onError={(e) => {
          ;(e.currentTarget as HTMLImageElement).style.display = 'none'
        }}
      />
      {item.kind === 'video' && (
        <div
          className="absolute top-1 right-1 w-4 h-4 rounded-full inline-flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)' }}
        >
          <Play size={8} color="white" fill="white" />
        </div>
      )}
    </>
  )
}
