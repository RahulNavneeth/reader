import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Globe, AlertCircle, Loader2, Play, FileText, Lock } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Detail = Awaited<ReturnType<typeof api.publicCollection>>

/**
 * /pc/:slug — anonymous public-collection viewer.
 *
 * No auth required. Renders the collection metadata + item grid
 * using the public anonymous endpoints (/api/public-collections/*).
 * Clicking a non-image item opens its raw bytes inline; images open
 * a lightbox-ish full-screen view.
 *
 * Password-gated collections show a small inline form; the
 * password rides every subsequent request via the `?p=` query.
 */
export function PublicCollectionPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [search, setSearch] = useSearchParams()
  const passwordFromUrl = search.get('p') ?? ''
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [passwordInput, setPasswordInput] = useState(passwordFromUrl)
  const [lightbox, setLightbox] = useState<Detail['items'][number] | null>(null)

  const load = async (pwd: string) => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.publicCollection(slug, pwd || undefined)
      setData(r)
      setPasswordRequired(false)
    } catch (e) {
      if (e instanceof ApiError && (e.body as { passwordRequired?: boolean })?.passwordRequired) {
        setPasswordRequired(true)
      } else {
        setError(e instanceof ApiError ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(passwordFromUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  if (passwordRequired) {
    return (
      <div className="flex-1 flex items-center justify-center surface">
        <div
          className="rounded-xl p-6 w-full max-w-[400px]"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Lock size={16} className="text-accent" />
            <div className="text-[14px] font-semibold text-fg">Password required</div>
          </div>
          <div className="text-[12.5px] text-muted mb-3">
            This collection is gated by a password set by its owner.
          </div>
          <input
            className="input h-9 text-[13px] w-full"
            type="password"
            autoFocus
            placeholder="Password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setSearch({ p: passwordInput })
                load(passwordInput)
              }
            }}
          />
          {error && (
            <div className="text-[11px] mt-2" style={{ color: '#BF2600' }}>
              {error}
            </div>
          )}
          <button
            className="btn-primary w-full mt-3 h-9"
            onClick={() => {
              setSearch({ p: passwordInput })
              load(passwordInput)
            }}
          >
            Unlock
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center surface">
        <Loader2 size={18} className="animate-spin text-subtle" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center surface">
        <div
          className="rounded-xl p-6 max-w-[400px] text-center"
          style={{ background: 'var(--panel)', border: '1px dashed var(--border)' }}
        >
          <AlertCircle size={20} className="text-subtle mx-auto mb-2" />
          <div className="text-[14px] text-fg">{error ?? 'Collection unavailable'}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden surface">
      <header
        className="h-12 px-4 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <Globe size={14} className="text-accent shrink-0" />
        <div className="text-[14px] font-semibold text-fg truncate">
          {data.collection.name}
        </div>
        <div className="flex-1" />
        <span className="text-[11.5px] text-subtle">
          {data.items.length} {data.items.length === 1 ? 'item' : 'items'}
        </span>
        {data.collection.publicExpiresAt && (
          <span className="text-[11px] text-subtle">
            · expires {new Date(data.collection.publicExpiresAt).toLocaleDateString()}
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-[1080px] mx-auto">
          {data.collection.description && (
            <div className="text-[13px] text-muted mb-4">{data.collection.description}</div>
          )}
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
          >
            {data.items.map((it) => (
              <button
                key={it.docId}
                onClick={() => {
                  if (it.kind === 'image' || it.kind === 'video') setLightbox(it)
                  else window.open(api.publicCollectionRawUrl(slug, it.docId, passwordFromUrl), '_blank')
                }}
                className="group relative overflow-hidden rounded-md"
                style={{
                  aspectRatio: '1 / 1',
                  background: 'var(--bg)',
                  border: '1px solid var(--border-soft)',
                }}
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
                      src={api.publicCollectionThumbnailUrl(slug, it.docId, passwordFromUrl)}
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
            ))}
          </div>
        </div>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setLightbox(null)}
        >
          {lightbox.kind === 'video' ? (
            <video
              src={api.publicCollectionRawUrl(slug, lightbox.docId, passwordFromUrl)}
              controls
              autoPlay
              className="max-w-full max-h-full"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={api.publicCollectionPreviewUrl(slug, lightbox.docId, passwordFromUrl)}
              alt={lightbox.title}
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  )
}
