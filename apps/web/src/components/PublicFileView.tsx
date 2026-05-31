import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, Globe, AlertCircle, Loader2, Lock } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import 'highlight.js/styles/github.css'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { setFaviconForFile } from '../lib/favicon'
import {
  parseImageSize,
  resolveImageSrc,
  resolveLinkHref,
} from '../lib/markdownAssetResolver'

type Props = {
  path: string
  /** Called when the file is not public — caller decides what to show (e.g. AuthScreen). */
  onNotPublic: () => void
}

/**
 * Anonymous viewer for public files. Public access now carries an optional
 * password and expiry (no more /s/<token> tokens), so this component also
 * handles:
 *
 *   - rendering an in-app password prompt when /api/file/meta says 401 +
 *     passwordRequired,
 *
 * No "expired" handling — the server's expiry sweep flips expired
 * publics back to private, so this view never has to render that
 * state explicitly. Expired links become normal not-public links.
 */
export function PublicFileView({ path, onNotPublic }: Props) {
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [passwordWrong, setPasswordWrong] = useState(false)
  const [password, setPassword] = useState('')
  const [submittedPwd, setSubmittedPwd] = useState<string>('')
  const mdRef = useRef<HTMLDivElement>(null)

  // Deep-link to a heading via URL fragment. Public docs are
  // fetched async, so the browser's initial hash-jump fires before
  // the markdown body exists in the DOM. After the body renders
  // we re-consume the hash + retry across ~2.5s while late-loading
  // images / PDFs / embeds reshape the layout, then bail out on
  // user interaction. Same recipe as PathViewer; fix needs to
  // live in both since public visitors come in via /<path>
  // without going through PathViewer.
  useEffect(() => {
    if (text == null) return
    const root = mdRef.current
    if (!root) return
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return
    let slug: string
    try {
      slug = decodeURIComponent(hash)
    } catch {
      slug = hash
    }
    let cancelled = false
    let settleTimer: number | null = null
    let done = false
    const tryScroll = () => {
      if (cancelled || done) return
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(slug)}`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      done = true
      stopReanchoring()
    }
    const markUnstable = () => {
      if (done || cancelled) return
      if (settleTimer != null) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(tryScroll, 120)
    }
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(markUnstable)
      ro.observe(root)
    }
    markUnstable()
    const ceiling = window.setTimeout(tryScroll, 1500)
    function stopReanchoring() {
      ro?.disconnect()
      ro = null
      if (settleTimer != null) window.clearTimeout(settleTimer)
      window.clearTimeout(ceiling)
      window.removeEventListener('wheel', stopReanchoring)
      window.removeEventListener('touchstart', stopReanchoring)
      window.removeEventListener('keydown', stopReanchoring)
    }
    window.addEventListener('wheel', stopReanchoring, { passive: true })
    window.addEventListener('touchstart', stopReanchoring, { passive: true })
    window.addEventListener('keydown', stopReanchoring)
    const onHashChange = () => {
      done = false
      markUnstable()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => {
      cancelled = true
      stopReanchoring()
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [text, path])

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
    setPasswordRequired(false)
    setPasswordWrong(false)
    const pwdOpt = submittedPwd ? { password: submittedPwd } : undefined
    api
      .fileMeta(path, pwdOpt)
      .then(async (r) => {
        if (cancelled) return
        if (!r.meta || !r.meta.public) {
          onNotPublic()
          return
        }
        setMeta(r.meta)
        if (isMarkdown || isText || isHtml || isOfficeDoc) {
          try {
            const t = await api.fileText(path, pwdOpt)
            if (!cancelled) setText(t.content)
          } catch (e) {
            if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
          }
        }
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError) {
          if (e.status === 401) {
            setPasswordRequired(true)
            if (submittedPwd) setPasswordWrong(true)
            return
          }
          if (e.status === 404) {
            onNotPublic()
            return
          }
          setError(e.message)
        } else {
          setError(String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, isMarkdown, isText, isHtml, isOfficeDoc, onNotPublic, submittedPwd])

  const filename = path.split('/').pop() || path
  const parentDir = useMemo(() => {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i)
  }, [path])

  if (passwordRequired) {
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
            This file is shared with a password.
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
          {passwordWrong && (
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
          <div className="text-fg font-semibold">Couldn't open this file</div>
          <div className="text-[13px] text-muted mt-1">{error}</div>
        </div>
      </div>
    )
  }

  if (!meta) return null

  const rawUrl = api.rawUrl(path, submittedPwd ? { password: submittedPwd } : undefined)
  const previewUrl = api.previewUrl(path, submittedPwd ? { password: submittedPwd } : undefined)

  return (
    <div className="h-full flex flex-col surface">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <FileText size={14} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg truncate">{filename}</div>
        <span className="btn-ghost cursor-default" style={{ color: '#00875A' }}>
          <Globe size={13} /> Public
        </span>
        <div className="flex-1" />
        <a className="btn-ghost" href={rawUrl} download={filename}>
          <Download size={14} />
          Download
        </a>
      </header>

      <div className="flex-1 overflow-y-auto">
        {isPdf && (
          <iframe
            src={rawUrl}
            title={filename}
            className="w-full h-full border-0"
            style={{ background: 'var(--panel)' }}
          />
        )}

        {isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <img
              src={needsPreview ? previewUrl : rawUrl}
              alt={filename}
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
          <div ref={mdRef} className="px-10 py-10">
            <article className="md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug, rehypeHighlight]}
                components={{
                  // Same as PathViewer used to do: resolve relative
                  // paths against the doc's folder. For public
                  // visitors the asset itself isn't public, but the
                  // server grants a transitive embed read when the
                  // request carries `via=<this doc>` — see
                  // `tryTransitiveEmbedGrant` on the server.
                  img: ({ src, alt, ...rest }) => {
                    const embedOpts = { via: path }
                    const resolved =
                      typeof src === 'string'
                        ? resolveImageSrc(parentDir, src, embedOpts)
                        : src
                    const { alt: cleanAlt, width, height } = parseImageSize(alt)
                    const style: React.CSSProperties = {}
                    if (width) style.width = width
                    if (height) style.height = height
                    return (
                      <img
                        src={resolved as string}
                        alt={cleanAlt || alt}
                        style={Object.keys(style).length ? style : undefined}
                        {...rest}
                      />
                    )
                  },
                  a: ({ href, children, ...rest }) => {
                    if (typeof href !== 'string')
                      return <a {...rest}>{children}</a>
                    const resolved = resolveLinkHref(parentDir, href)
                    return (
                      <a href={resolved} {...rest}>
                        {children}
                      </a>
                    )
                  },
                }}
              >
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
              <a className="btn-primary mt-3" href={rawUrl} download={filename}>
                <Download size={14} /> Download
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
