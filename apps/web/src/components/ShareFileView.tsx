import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, Lock, AlertCircle, Loader2, Share2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import 'highlight.js/styles/github.css'
import { useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../lib/api'
import { setFaviconForFile } from '../lib/favicon'

type ShareInfo = {
  id: string
  filename: string
  ext: string
  mime: string
  label?: string
  hasPassword: boolean
  expiresAt: number | null
}

type Props = { id: string }

/**
 * Anonymous share-link viewer. Mounts on /s/:id. Resolves the share via
 * /api/share/:id/info (which may demand a password), then renders the file
 * with the same rich viewer used for public files — markdown is parsed,
 * images get inline thumbnails, video plays via <video>, etc.
 *
 * Download links go through /s/:id?raw=1 so users always get the original
 * bytes, regardless of any server-side preview transcoding.
 */
export function ShareFileView({ id }: Props) {
  const [search] = useSearchParams()
  const initialPwd = search.get('p') || ''

  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [password, setPassword] = useState(initialPwd)
  const [submittedPwd, setSubmittedPwd] = useState<string>(initialPwd)
  const [needsPassword, setNeedsPassword] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const ext = useMemo(() => info?.ext ?? '', [info])
  const isMarkdown = ['.md', '.markdown', '.mdx'].includes(ext)
  const isText = ['.txt', '.csv', '.json', '.yaml', '.yml', '.toml'].includes(ext)
  const isHtml = ['.html', '.htm'].includes(ext)
  const isPdf = ext === '.pdf'
  const isImage = [
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
  ].includes(ext)
  const isVideo = [
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
    '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
    '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
  ].includes(ext)
  const isOfficeDoc = ['.docx', '.xlsx', '.xls'].includes(ext)

  useEffect(() => {
    if (!info) return
    const prevTitle = document.title
    document.title = `${info.filename} — Reader`
    const restoreFavicon = setFaviconForFile(info.filename)
    return () => {
      document.title = prevTitle
      restoreFavicon()
    }
  }, [info])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNeedsPassword(false)
    api
      .shareInfo(id, submittedPwd || undefined)
      .then(async (i) => {
        if (cancelled) return
        setInfo(i)
        const fetchText = ['.md', '.markdown', '.mdx', '.txt', '.csv', '.json', '.yaml', '.yml', '.toml', '.html', '.htm', '.docx', '.xlsx', '.xls'].includes(
          i.ext,
        )
        if (fetchText) {
          try {
            const t = await api.shareText(id, submittedPwd || undefined)
            if (!cancelled) setText(t.content)
          } catch (e) {
            if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
          }
        }
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 401) {
          setNeedsPassword(true)
        } else if (e instanceof ApiError && e.status === 410) {
          setError('This share link has expired.')
        } else if (e instanceof ApiError && e.status === 404) {
          setError('This share link is invalid or has been revoked.')
        } else {
          setError(e instanceof ApiError ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, submittedPwd])

  // Build URLs once info is known. Bytes endpoints carry the password too.
  const rawUrl = useMemo(() => api.shareRawUrl(id, submittedPwd || undefined), [id, submittedPwd])
  const previewUrl = useMemo(
    () => api.sharePreviewUrl(id, submittedPwd || undefined),
    [id, submittedPwd],
  )
  const downloadUrl = useMemo(
    () => api.shareDownloadUrl(id, submittedPwd || undefined),
    [id, submittedPwd],
  )
  const needsServerPreview = ['.heic', '.heif', '.tiff', '.tif', '.jxl'].includes(ext)

  if (needsPassword) {
    return (
      <div className="h-full min-h-screen flex items-center justify-center surface">
        <form
          className="w-[340px] p-6 rounded-lg shadow-card"
          style={{ background: 'var(--panel)' }}
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedPwd(password)
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Lock size={16} className="text-accent" />
            <div className="text-fg font-semibold">Password required</div>
          </div>
          <div className="text-[12.5px] text-muted mb-3">
            This share link is password-protected.
          </div>
          <input
            type="password"
            className="input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <button className="btn-primary w-full mt-3" type="submit">
            <Lock size={14} /> Open file
          </button>
          {submittedPwd && password === submittedPwd && (
            <div className="text-[12px] mt-2" style={{ color: '#BF2600' }}>
              Incorrect password. Try again.
            </div>
          )}
        </form>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full min-h-screen flex items-center justify-center surface">
        <div className="text-[13px] text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    )
  }

  if (error || !info) {
    return (
      <div className="h-full min-h-screen flex items-center justify-center surface">
        <div className="text-center max-w-md p-6">
          <AlertCircle size={20} style={{ color: '#BF2600' }} className="mx-auto mb-2" />
          <div className="text-fg font-semibold">Couldn't open this share</div>
          <div className="text-[13px] text-muted mt-1">{error ?? 'Unknown error'}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col surface">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <Share2 size={14} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg truncate">{info.filename}</div>
        <span className="text-[11.5px] text-subtle">
          {info.label ? `· ${info.label}` : ''}
        </span>
        <div className="flex-1" />
        <a className="btn-ghost" href={downloadUrl} download={info.filename}>
          <Download size={14} />
          Download
        </a>
      </header>

      <div className="flex-1 overflow-y-auto">
        {isPdf && (
          <iframe
            src={rawUrl}
            title={info.filename}
            className="w-full h-full border-0"
            style={{ background: 'var(--panel)' }}
          />
        )}

        {isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <img
              src={needsServerPreview ? previewUrl : rawUrl}
              alt={info.filename}
              className="max-w-full max-h-full rounded shadow-card"
            />
          </div>
        )}

        {isVideo && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <video
              src={rawUrl}
              poster={previewUrl}
              controls
              playsInline
              preload="metadata"
              className="max-w-full max-h-full rounded shadow-card"
            />
          </div>
        )}

        {isMarkdown && text != null && (
          <div className="px-10 py-10">
            <article className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug, rehypeHighlight]}>
                {text}
              </ReactMarkdown>
            </article>
          </div>
        )}

        {(isText || isHtml) && text != null && (
          <pre className="px-10 py-8 text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
        )}

        {isOfficeDoc && text != null && (
          <div className="px-10 py-10">
            <div className="text-[12px] uppercase tracking-wider font-semibold text-subtle mb-3">
              extracted text
            </div>
            <pre className="text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
          </div>
        )}

        {!isPdf && !isImage && !isVideo && !isMarkdown && !isText && !isHtml && !isOfficeDoc && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <FileText size={36} className="text-muted mx-auto mb-3" />
              <div className="text-fg font-semibold mb-1">Preview unavailable</div>
              <a className="btn-primary mt-3" href={downloadUrl} download={info.filename}>
                <Download size={14} /> Download
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
