import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, X, AlertCircle, ExternalLink, Sparkles, RefreshCw, List, Globe, Lock } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import 'highlight.js/styles/github.css'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { setFaviconForFile } from '../lib/favicon'
import { PathBreadcrumb } from './PathBreadcrumb'
import { FileInfoButton } from './FileInfoButton'

type Props = {
  path: string
}

export function PathViewer({ path }: Props) {
  const navigate = useNavigate()
  const { setCurrentFolder } = useVault()
  const [text, setText] = useState<string | null>(null)
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)

  useEffect(() => {
    const i = path.lastIndexOf('/')
    setCurrentFolder(i < 0 ? '' : path.slice(0, i))
  }, [path, setCurrentFolder])

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

  const ext = useMemo(() => {
    const i = path.lastIndexOf('.')
    return i >= 0 ? path.slice(i).toLowerCase() : ''
  }, [path])

  const isMarkdown = ['.md', '.markdown', '.mdx'].includes(ext)
  const isText = ['.txt', '.csv', '.json', '.yaml', '.yml', '.toml'].includes(ext)
  const isHtml = ['.html', '.htm'].includes(ext)
  const isPdf = ext === '.pdf'
  const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)
  const isOfficeDoc = ['.docx', '.xlsx', '.xls'].includes(ext)
  const wantsExtractedText = isOfficeDoc

  useEffect(() => {
    setText(null)
    setMeta(null)
    setError(null)
    api.fileMeta(path).then((r) => setMeta(r.meta)).catch(() => null)
    if (isMarkdown || isText || isHtml || wantsExtractedText) {
      api
        .fileText(path)
        .then((r) => setText(r.content))
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404 && wantsExtractedText) {
            // Office doc not indexed yet — leave text null, show CTA below.
            setText(null)
          } else {
            setError(e instanceof ApiError ? e.message : String(e))
          }
        })
    }
  }, [path, isMarkdown, isText, isHtml, wantsExtractedText])

  const filename = path.split('/').pop() || path
  const parentDir = useMemo(() => {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i)
  }, [path])

  const goToFolder = (dir: string) => {
    setCurrentFolder(dir)
    navigate('/')
  }

  const indexNow = async () => {
    setIndexing(true)
    try {
      await api.indexFile(path)
      const r = await api.fileText(path).catch(() => null)
      if (r) setText(r.content)
      const m = await api.fileMeta(path).catch(() => null)
      if (m) setMeta(m.meta)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setIndexing(false)
    }
  }

  const headings = useMemo(() => {
    if (!isMarkdown || !text) return [] as Array<{ level: number; text: string; slug: string }>
    const lines = text.split('\n')
    const out: Array<{ level: number; text: string; slug: string }> = []
    let inFence = false
    for (const raw of lines) {
      if (/^```/.test(raw)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(raw)
      if (!m) continue
      const level = m[1].length
      const t = m[2].trim()
      const slug = t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
      out.push({ level, text: t, slug })
    }
    return out
  }, [isMarkdown, text])

  const showOutline = isMarkdown && headings.length > 1
  const contentRef = useRef<HTMLDivElement>(null)

  const jumpTo = (slug: string) => {
    const root = contentRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(slug)}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const needsReindex = !!meta && !meta.ingest.embedded
  const reindexLabel = meta?.ingest.status === 'ready' ? 'Re-index' : 'Index'

  const [visibilityBusy, setVisibilityBusy] = useState(false)
  const toggleVisibility = async () => {
    if (!meta) return
    setVisibilityBusy(true)
    try {
      const r = await api.setVisibility(path, !meta.public)
      setMeta(r.document)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setVisibilityBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0" style={{ background: 'var(--panel-2)' }}>
        <PathBreadcrumb
          dir={parentDir}
          currentName={filename}
          currentAction={<FileInfoButton path={path} meta={meta} />}
          onNavigate={goToFolder}
          onBack={() => goToFolder(parentDir)}
        />
        <div className="flex-1" />
        {needsReindex && (
          <button
            className="btn-ghost"
            disabled={indexing}
            onClick={indexNow}
            title="Run extraction + embedding so this file is searchable"
          >
            {indexing ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {indexing ? 'Indexing…' : reindexLabel}
          </button>
        )}
        <button
          className="btn-ghost"
          disabled={visibilityBusy}
          onClick={toggleVisibility}
          title={meta?.public ? 'Make private (requires auth)' : 'Make public (anyone with link can view)'}
          style={meta?.public ? { color: '#00875A' } : undefined}
        >
          {meta?.public ? <Globe size={13} /> : <Lock size={13} />}
          {meta?.public ? 'Public' : 'Private'}
        </button>
        <a className="btn-ghost" href={api.rawUrl(path)} download={filename}>
          <Download size={14} />
          Download
        </a>
        <button className="btn-ghost" onClick={() => navigate('/')} title="Close">
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-hidden flex">
       <div ref={contentRef} className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-10 py-10 text-muted">
            <div className="flex items-center gap-2 text-fg font-semibold mb-1">
              <AlertCircle size={16} style={{ color: '#BF2600' }} /> Couldn't open this file
            </div>
            <div className="text-[13px]">{error}</div>
          </div>
        )}

        {!error && isPdf && (
          <iframe
            src={api.rawUrl(path)}
            title={filename}
            className="w-full h-full border-0"
            style={{ background: 'var(--panel)' }}
          />
        )}

        {!error && isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <img src={api.rawUrl(path)} alt={filename} className="max-w-full max-h-full rounded shadow-card" />
          </div>
        )}

        {!error && isMarkdown && text != null && (
          <div className="px-10 py-10">
            <article className="md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[
                  rehypeSlug,
                  [rehypeAutolinkHeadings, { behavior: 'append', properties: { className: ['anchor'], 'aria-hidden': 'true', tabIndex: -1 }, content: { type: 'text', value: '#' } }],
                  rehypeHighlight,
                ]}
              >
                {text}
              </ReactMarkdown>
            </article>
          </div>
        )}

        {!error && isHtml && text != null && (
          <pre className="px-10 py-8 text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
        )}

        {!error && isText && text != null && (
          <pre className="px-10 py-8 text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
        )}

        {!error && wantsExtractedText && text != null && (
          <div className="px-10 py-10">
            <div className="text-[12px] uppercase tracking-wider font-semibold text-subtle mb-3">extracted text</div>
            <pre className="text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
          </div>
        )}

        {!error && wantsExtractedText && text == null && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md p-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3" style={{ background: 'var(--panel)' }}>
                <Sparkles size={22} className="text-accent" />
              </div>
              <div className="text-fg font-semibold">Not indexed yet</div>
              <div className="text-[13px] text-muted mt-1 mb-4">
                Index this file to extract its text and make it searchable for AI agents.
              </div>
              <button className="btn-primary" disabled={indexing} onClick={indexNow}>
                <Sparkles size={14} />
                {indexing ? 'Indexing…' : 'Index for search'}
              </button>
              <div className="mt-4">
                <a className="btn-ghost" href={api.rawUrl(path)} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  Open original
                </a>
              </div>
            </div>
          </div>
        )}

        {!error && !isPdf && !isImage && !isMarkdown && !isText && !isHtml && !wantsExtractedText && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-fg font-semibold mb-1">Preview unavailable</div>
              <div className="text-[13px] text-muted">Use Download to open it locally.</div>
            </div>
          </div>
        )}
       </div>

       {showOutline && (
         <aside
           className="w-[240px] shrink-0 border-l overflow-y-auto"
           style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
         >
           <div
             className="sticky top-0 px-3 py-2.5 border-b text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex items-center gap-1.5"
             style={{ background: 'var(--panel-2)', borderColor: 'var(--border-soft)' }}
           >
             <List size={11} /> Outline
           </div>
           <nav className="px-2 py-2">
             {headings.map((h, i) => (
               <button
                 key={i + h.slug}
                 onClick={() => jumpTo(h.slug)}
                 className="block w-full text-left px-2 py-1 rounded text-[12px] hover:bg-hover transition-colors text-fg truncate"
                 style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                 title={h.text}
               >
                 {h.text}
               </button>
             ))}
           </nav>
         </aside>
       )}
      </div>
    </div>
  )
}
