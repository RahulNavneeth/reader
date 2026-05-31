import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Layers,
  AlertCircle,
  Trash2,
  X,
  FileText,
  Play,
  Edit2,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { CollectionShareButton } from './CollectionShareButton'
import { CollectionPublicButton } from './CollectionPublicButton'
import { SmartCollectionEditor } from './SmartCollectionEditor'

type Detail = Awaited<ReturnType<typeof api.getCollection>>

/**
 * /c/:id — Collection detail.
 *
 * Shows the items as a grid (image thumbnails / video frames / file
 * tiles), plus a side strip of shares for the owner. Editors can
 * remove items and rename; non-editors get a read-only view.
 *
 * Items use the same kind-based rendering as the timeline: media
 * shows the thumbnail, "file" kind shows a FileText icon + name so
 * a mixed-media collection stays visually uniform.
 */
export function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [pendingName, setPendingName] = useState('')

  const refresh = async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const r = await api.getCollection(id)
      setData(r)
      setPendingName(r.collection.name)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const canEdit = data?.collection.role === 'owner' || data?.collection.role === 'editor'
  const isOwner = data?.collection.role === 'owner'

  const saveName = async () => {
    if (!data || !id) return
    const next = pendingName.trim()
    if (!next || next === data.collection.name) {
      setEditingName(false)
      setPendingName(data.collection.name)
      return
    }
    try {
      await api.patchCollection(id, { name: next })
      setEditingName(false)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const remove = async (docId: string) => {
    if (!id) return
    try {
      await api.removeCollectionItem(id, docId)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const deleteCollection = async () => {
    if (!id || !data) return
    const ok = await confirm({
      title: 'Delete collection',
      message: `"${data.collection.name}" will be deleted. The documents inside are not affected — they stay in their folders.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await api.deleteCollection(id)
      navigate('/collections')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  // Share / publish / unpublish / link-copy now live inside the
  // dedicated CollectionShareButton + CollectionPublicButton popovers
  // — the giant centered modal is gone. Both children call refresh()
  // through the onChanged prop.

  const openItem = (path: string) => {
    const segs = path.split('/').map(encodeURIComponent).join('/')
    navigate(`/${segs}`)
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ background: 'var(--rail)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        // `--surface-2` matches the breadcrumb header on every
        // other page (Archive, Trash, PathViewer, …); the previous
        // `--panel-2` was the lightest tier in dark mode and
        // popped as a brighter blue strip versus the surrounding
        // chrome.
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/collections')}
          title="Back to collections"
        >
          <ArrowLeft size={14} />
        </button>
        <Layers size={13} className="text-accent shrink-0" />

        {editingName ? (
          <input
            autoFocus
            className="input h-7 text-[13px] flex-1 max-w-[420px]"
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName()
              if (e.key === 'Escape') {
                setEditingName(false)
                setPendingName(data?.collection.name ?? '')
              }
            }}
            onBlur={saveName}
          />
        ) : (
          <div
            className="text-[13.5px] font-semibold text-fg flex items-center gap-1.5"
            title={data?.collection.name}
          >
            {data?.collection.name ?? '…'}
            {canEdit && (
              <button
                className="btn-ghost h-6 w-6 px-0"
                title="Rename"
                onClick={() => setEditingName(true)}
              >
                <Edit2 size={11} />
              </button>
            )}
          </div>
        )}

        {data?.collection.role && data.collection.role !== 'owner' && (
          <span
            className="text-[10.5px] px-1.5 h-5 rounded inline-flex items-center"
            style={{
              background: 'var(--bg)',
              color: 'var(--fg-subtle)',
              border: '1px solid var(--border)',
            }}
          >
            shared · {data.collection.role === 'editor' ? 'edit' : 'read-only'}
          </span>
        )}

        <div className="flex-1" />
        {data && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {data.items.length} {data.items.length === 1 ? 'item' : 'items'}
          </span>
        )}
        {isOwner && data && (
          <>
            <CollectionShareButton
              collectionId={data.collection.id}
              shares={data.shares.map((s) => ({
                recipient: s.recipient,
                canEdit: s.canEdit,
              }))}
              onChanged={refresh}
            />
            <CollectionPublicButton
              collectionId={data.collection.id}
              isPublic={data.collection.public}
              publicSlug={data.collection.publicSlug}
              publicExpiresAt={data.collection.publicExpiresAt}
              hasPassword={!!data.collection.hasPassword}
              onChanged={refresh}
            />
          </>
        )}
        {isOwner && (
          <button
            className="btn-ghost"
            onClick={deleteCollection}
            title="Delete collection"
            aria-label="Delete collection"
            style={{ color: '#BF2600' }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </header>


      <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col">
        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2"
            style={{ background: '#FFEBE6', color: '#BF2600' }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        <div className="w-full max-w-[1080px] mx-auto">
          {canEdit && data && id && (
            <SmartCollectionEditor
              collectionId={id}
              initialQuery={data.collection.query}
              onChanged={refresh}
            />
          )}
        </div>

        {!loading && data && data.items.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <div
              className="rounded-xl p-8 text-center max-w-md"
              style={{ background: 'var(--surface-2)', border: '1px dashed var(--border)' }}
            >
              <Layers size={22} className="text-subtle mx-auto mb-2" />
              <div className="text-[14px] text-fg font-medium">No items yet</div>
              <div className="text-[12px] text-muted mt-1.5">
                {data.collection.query
                  ? 'Nothing matches your query right now. Adjust the filters above, or add docs that fit.'
                  : 'Open any file and use "Add to collection" from its menu to drop it into this collection. Or click "Make smart" above to populate via a saved search.'}
              </div>
            </div>
          </div>
        )}

        <div className="w-full max-w-[1080px] mx-auto">
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
          >
            {data?.items.map((it) => (
              <div
                key={it.docId}
                className="group relative overflow-hidden rounded-md"
                style={{
                  aspectRatio: '1 / 1',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                }}
              >
                <button
                  onClick={() => openItem(it.path)}
                  className="absolute inset-0 w-full h-full"
                  title={it.title}
                >
                  {it.kind === 'file' ? (
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2"
                    >
                      <FileText size={28} className="text-subtle" strokeWidth={1.4} />
                      <div className="text-[11px] text-fg text-center leading-tight line-clamp-3 break-all">
                        {it.title}
                      </div>
                    </div>
                  ) : (
                    <>
                      <img
                        src={api.thumbnailUrl(it.path)}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                        onError={(e) => {
                          ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                        }}
                      />
                      {it.kind === 'video' && (
                        <div
                          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full inline-flex items-center justify-center"
                          style={{ background: 'rgba(0,0,0,0.55)' }}
                        >
                          <Play size={10} color="white" fill="white" />
                        </div>
                      )}
                    </>
                  )}
                </button>
                {canEdit && (
                  <button
                    className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full inline-flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ background: 'rgba(0,0,0,0.6)', color: 'white' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(it.docId)
                    }}
                    title="Remove from collection"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
