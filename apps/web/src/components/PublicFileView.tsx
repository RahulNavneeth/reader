import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, Globe, AlertCircle, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import 'highlight.js/styles/github.css'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { setFaviconForFile } from '../lib/favicon'

type Props = {
  path: string
  /** Called when the file is not public — caller decides what to show (e.g. AuthScreen). */
  onNotPublic: () => void
}

export function PublicFileView({ path, onNotPublic }: Props) {
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const ext = useMemo(() => {
    const i = path.lastIndexOf('.')
    return i >= 0 ? path.slice(i).toLowerCase() : ''
  }, [path])

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
  const needsPreview = ['.heic', '.heif', '.tiff', '.tif', '.jxl'].includes(ext)
  const isOfficeDoc = ['.docx', '.xlsx', '.xls'].includes(ext)

  useEffect(() => {
    const fname = path.split('/').pop() || path
    const prevTitle = document.title
    document.title = `${fname} — Reader`
    const restoreFavicon = setFaviconForFile(fname)
    return () => {
      document.title = prevTitle
      restoreFavicon()
    }
  }, [path])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .fileMeta(path)
      .then((r) => {
        if (cancelled) return
        if (!r.meta || !r.meta.public) {
          onNotPublic()
          return
        }
        setMeta(r.meta)
        if (isMarkdown || isText || isHtml || isOfficeDoc) {
          return api
            .fileText(path)
            .then((t) => {
              if (!cancelled) setText(t.content)
            })
            .catch((e) => {
              if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
            })
        }
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
          onNotPublic()
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
  }, [path, isMarkdown, isText, isHtml, isOfficeDoc, onNotPublic])

  const filename = path.split('/').pop() || path

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-[13px] text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-center max-w-md p-6">
          <AlertCircle size={20} style={{ color: '#BF2600' }} className="mx-auto mb-2" />
          <div className="text-fg font-semibold">Couldn’t open this file</div>
          <div className="text-[13px] text-muted mt-1">{error}</div>
        </div>
      </div>
    )
  }

  if (!meta) return null

  return (
    <div className="h-full flex flex-col surface">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <FileText size={14} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg truncate">{filename}</div>
        <span
          className="btn-ghost cursor-default"
          style={{ color: '#00875A' }}
        >
          <Globe size={13} /> Public
        </span>
        <div className="flex-1" />
        <a className="btn-ghost" href={api.rawUrl(path)} download={filename}>
          <Download size={14} />
          Download
        </a>
      </header>

      <div className="flex-1 overflow-y-auto">
        {isPdf && (
          <iframe
            src={api.rawUrl(path)}
            title={filename}
            className="w-full h-full border-0"
            style={{ background: 'var(--panel)' }}
          />
        )}

        {isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <img
              src={needsPreview ? api.previewUrl(path) : api.rawUrl(path)}
              alt={filename}
              className="max-w-full max-h-full rounded shadow-card"
            />
          </div>
        )}

        {isVideo && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <video
              src={api.rawUrl(path)}
              poster={api.previewUrl(path)}
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
            <div className="text-[12px] uppercase tracking-wider font-semibold text-subtle mb-3">extracted text</div>
            <pre className="text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
          </div>
        )}

        {!isPdf && !isImage && !isVideo && !isMarkdown && !isText && !isHtml && !isOfficeDoc && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-fg font-semibold mb-1">Preview unavailable</div>
              <a className="btn-primary mt-3" href={api.rawUrl(path)} download={filename}>
                <Download size={14} /> Download
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
