import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Layers,
  AlertCircle,
  Trash2,
  Users,
  X,
  Loader2,
  FileText,
  Play,
  Edit2,
  Globe,
  Copy,
  Check,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { copyText } from '../lib/clipboard'

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
  const [shareOpen, setShareOpen] = useState(false)
  const [shareRecipient, setShareRecipient] = useState('')
  const [shareCanEdit, setShareCanEdit] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [publishBusy, setPublishBusy] = useState(false)
  const [publishPassword, setPublishPassword] = useState('')
  // Preset-based expiry — string so we can carry the special
  // "never" sentinel alongside the numeric day-counts. Matches the
  // pattern used by MakePublicPopover for per-file public links.
  const [publishExpiry, setPublishExpiry] = useState<'1' | '7' | '30' | 'never'>('7')
  const [linkCopied, setLinkCopied] = useState(false)

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

  const addShare = async () => {
    if (!id) return
    const recipient = shareRecipient.trim()
    if (!recipient) return
    setShareBusy(true)
    setError(null)
    try {
      await api.shareCollection(id, { recipient, canEdit: shareCanEdit })
      setShareRecipient('')
      setShareCanEdit(false)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setShareBusy(false)
    }
  }

  const unshare = async (recipient: string) => {
    if (!id) return
    try {
      await api.unshareCollection(id, recipient)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const publish = async () => {
    if (!id) return
    setPublishBusy(true)
    setError(null)
    try {
      const expiresInSeconds =
        publishExpiry === 'never' ? null : Number(publishExpiry) * 24 * 60 * 60
      await api.publishCollection(id, {
        isPublic: true,
        expiresInSeconds,
        password: publishPassword || null,
      })
      setPublishPassword('')
      setPublishExpiry('7')
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setPublishBusy(false)
    }
  }

  const unpublish = async () => {
    if (!id) return
    setPublishBusy(true)
    setError(null)
    try {
      await api.publishCollection(id, { isPublic: false })
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setPublishBusy(false)
    }
  }

  const copyPublicLink = async () => {
    if (!data?.collection.publicSlug) return
    const url = `${window.location.origin}/pc/${data.collection.publicSlug}`
    const ok = await copyText(url)
    if (ok) {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 1500)
    } else {
      setError('Could not copy link automatically — select the URL above and copy manually.')
    }
  }

  const openItem = (path: string) => {
    const segs = path.split('/').map(encodeURIComponent).join('/')
    navigate(`/${segs}`)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden surface">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
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
              border: '1px solid var(--border-soft)',
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
        {isOwner && (
          <button
            className="btn-ghost"
            onClick={() => setShareOpen((v) => !v)}
            aria-expanded={shareOpen}
            style={shareOpen ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
          >
            <Users size={13} />
            Share
          </button>
        )}
        {isOwner && (
          <button
            className="btn-ghost"
            onClick={deleteCollection}
            title="Delete collection"
            style={{ color: '#BF2600' }}
          >
            <Trash2 size={13} />
            Delete
          </button>
        )}
      </header>

      {/* Share + Public link overlay. Centered modal portaled out
          to document.body so a transformed ancestor doesn't clamp
          its `position: fixed`. Two sections side-by-side in the
          body: user-share form + recipient list on top, public-link
          publish/copy/revoke at the bottom. */}
      {shareOpen && isOwner && data && createPortal(
        // Compacted: ~420px wide, smaller paddings, single
        // continuous body (no per-section divider), Done lives in
        // the top-right X — no separate footer row.
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4"
          style={{ background: 'rgba(9, 30, 66, 0.42)' }}
          onClick={() => {
            if (!shareBusy && !publishBusy) setShareOpen(false)
          }}
        >
          <div
            className="w-full max-w-[420px] rounded-lg shadow-card overflow-hidden flex flex-col"
            style={{ background: 'var(--panel)', maxHeight: 'calc(100vh - 18vh)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-3 h-10 border-b shrink-0"
              style={{ borderColor: 'var(--border-soft)' }}
            >
              <Users size={13} className="text-accent" />
              <div className="text-[12.5px] font-medium text-fg truncate">
                Share &ldquo;{data.collection.name}&rdquo;
              </div>
              <div className="flex-1" />
              <button
                className="btn-ghost h-6 w-6 px-0"
                onClick={() => setShareOpen(false)}
                disabled={shareBusy || publishBusy}
                title="Close"
              >
                <X size={12} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              {/* SECTION 1 — share with a user */}
              <div>
                <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1">
                  Share with a user
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    className="input h-7 text-[12px] flex-1"
                    placeholder="Username"
                    value={shareRecipient}
                    onChange={(e) => setShareRecipient(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addShare()}
                    disabled={shareBusy}
                  />
                  <button
                    className="btn-primary h-7"
                    disabled={shareBusy || !shareRecipient.trim()}
                    onClick={addShare}
                  >
                    {shareBusy ? <Loader2 size={11} className="animate-spin" /> : <Users size={11} />}
                    Share
                  </button>
                </div>
                <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-fg select-none">
                  <input
                    type="checkbox"
                    checked={shareCanEdit}
                    onChange={(e) => setShareCanEdit(e.target.checked)}
                  />
                  Allow this user to edit
                </label>
                {data.shares.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {data.shares.map((s) => (
                      <div
                        key={s.recipient}
                        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--bg)', border: '1px solid var(--border-soft)' }}
                      >
                        <Users size={10} className="text-subtle" />
                        <span className="text-[11.5px] text-fg flex-1 truncate">{s.recipient}</span>
                        <span
                          className="text-[10px] px-1 h-4 rounded inline-flex items-center"
                          style={{
                            background: s.canEdit ? 'var(--selected)' : 'transparent',
                            color: s.canEdit ? 'var(--accent)' : 'var(--fg-subtle)',
                            border: '1px solid var(--border-soft)',
                          }}
                        >
                          {s.canEdit ? 'edit' : 'read'}
                        </span>
                        <button
                          className="btn-ghost h-5 w-5 px-0"
                          onClick={() => unshare(s.recipient)}
                          title="Remove share"
                          style={{ color: '#BF2600' }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* SECTION 2 — public link. Same body, no big divider;
                  just the subtitle label re-introduces the topic. */}
              <div className="pt-2.5" style={{ borderTop: '1px solid var(--border-soft)' }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Globe size={11} className="text-subtle" />
                  <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                    Public link
                  </div>
                  {data.collection.public && (
                    <span
                      className="text-[10px] px-1 h-4 rounded inline-flex items-center"
                      style={{ background: 'var(--selected)', color: 'var(--accent)' }}
                    >
                      on
                    </span>
                  )}
                </div>
                {data.collection.public && data.collection.publicSlug ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <code
                        className="flex-1 px-1.5 py-1 rounded text-[11px] truncate"
                        style={{ background: 'var(--bg)', border: '1px solid var(--border-soft)' }}
                      >
                        {window.location.origin}/pc/{data.collection.publicSlug}
                      </code>
                      <button
                        className="btn-ghost h-7"
                        onClick={copyPublicLink}
                        title="Copy URL"
                      >
                        {linkCopied ? <Check size={11} className="text-accent" /> : <Copy size={11} />}
                        {linkCopied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="text-[10.5px] text-subtle">
                      {data.collection.hasPassword ? 'Password-gated · ' : ''}
                      {data.collection.publicExpiresAt
                        ? `expires ${new Date(data.collection.publicExpiresAt).toLocaleDateString()}`
                        : 'no expiry'}
                    </div>
                    <button
                      className="btn-ghost self-start h-6"
                      onClick={unpublish}
                      disabled={publishBusy}
                      style={{ color: '#BF2600' }}
                    >
                      {publishBusy ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
                      Revoke
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <input
                      className="input h-7 text-[12px]"
                      type="password"
                      placeholder="Password (optional)"
                      value={publishPassword}
                      onChange={(e) => setPublishPassword(e.target.value)}
                      disabled={publishBusy}
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-[11.5px] text-subtle">Expires</span>
                      <select
                        className="input h-7 text-[12px] flex-1"
                        value={publishExpiry}
                        onChange={(e) =>
                          setPublishExpiry(
                            e.target.value as '1' | '7' | '30' | 'never',
                          )
                        }
                        disabled={publishBusy}
                      >
                        <option value="1">in 1 day</option>
                        <option value="7">in 7 days</option>
                        <option value="30">in 30 days</option>
                        <option value="never">never</option>
                      </select>
                      <button
                        className="btn-primary h-7"
                        onClick={publish}
                        disabled={publishBusy}
                      >
                        {publishBusy ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Globe size={10} />
                        )}
                        Publish
                      </button>
                    </div>
                    <div className="text-[10.5px] text-subtle">
                      Anyone with the URL can view this collection.
                    </div>
                  </div>
                )}
              </div>
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

        {!loading && data && data.items.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div
              className="rounded-xl p-8 text-center max-w-md"
              style={{ background: 'var(--panel)', border: '1px dashed var(--border)' }}
            >
              <Layers size={22} className="text-subtle mx-auto mb-2" />
              <div className="text-[14px] text-fg font-medium">No items yet</div>
              <div className="text-[12px] text-muted mt-1.5">
                Open any file and use "Add to collection" from its menu to
                drop it into this collection.
              </div>
            </div>
          </div>
        )}

        <div className="max-w-[1080px] mx-auto">
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
                  background: 'var(--bg)',
                  border: '1px solid var(--border-soft)',
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
                      style={{ background: 'var(--panel)' }}
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
