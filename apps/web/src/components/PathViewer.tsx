import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, X, AlertCircle, ExternalLink, Sparkles, RefreshCw, List, Lock, Info } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import 'highlight.js/styles/github.css'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { setFaviconForFile } from '../lib/favicon'
import { PathBreadcrumb } from './PathBreadcrumb'
import { TagsButton } from './TagsButton'
import { ActivityButton } from './ActivityButton'
import { VersionsButton } from './VersionsButton'
import { PublicButton } from './PublicButton'
import { ShareWithUserButton } from './ShareWithUserButton'
import { CsvTable } from './CsvTable'
import { JsonView } from './JsonView'
import { MetadataPanel } from './MetadataPanel'
import { PinButton } from './PinButton'
import { MediaPlayer } from './MediaPlayer'

type Props = {
  path: string
  /** True for own-vault files, or shared paths where the recipient has
   *  canEdit. Drives which toolbar affordances render in shared
   *  views — read-only recipients see only navigation + Download. */
  canEdit?: boolean
}

export function PathViewer({ path, canEdit = true }: Props) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // When opened from a "Shared with me" entry the URL carries ?owner=<other
  // user>. All read API calls in this component thread it through so we
  // resolve under the right namespace instead of the requester's.
  const ownerOpt = searchParams.get('owner') || undefined
  const callerOpts = ownerOpt ? { owner: ownerOpt } : undefined
  const { setCurrentFolder, refresh } = useVault()
  const [text, setText] = useState<string | null>(null)
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    const i = path.lastIndexOf('/')
    setCurrentFolder(i < 0 ? '' : path.slice(0, i))
  }, [path, setCurrentFolder])

  // Poll meta while ingestion is mid-flight. When the file flips to embedded,
  // bump the global refresh nonce so the sidebar updates its sparkle indicator
  // without a manual refresh.
  useEffect(() => {
    if (!meta) return
    if (meta.ingest.embedded) return
    const terminal = meta.ingest.status === 'failed' || meta.ingest.status === 'no-text'
    if (terminal) return
    let cancelled = false
    const t = setInterval(async () => {
      try {
        const r = await api.fileMeta(path, callerOpts)
        if (cancelled || !r.meta) return
        const wasEmbedded = meta.ingest.embedded
        setMeta(r.meta)
        if (r.meta.ingest.embedded && !wasEmbedded) {
          clearInterval(t)
          refresh()
        } else if (
          r.meta.ingest.status === 'failed' ||
          r.meta.ingest.status === 'no-text'
        ) {
          clearInterval(t)
        }
      } catch {
        /* swallow — try again next tick */
      }
    }, 2500)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [path, meta?.ingest.status, meta?.ingest.embedded, refresh])

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
  const isCsv = ext === '.csv'
  const isJson = ext === '.json'
  const isText = ['.txt', '.yaml', '.yml', '.toml'].includes(ext)
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
  const isAudio = [
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma',
  ].includes(ext)
  // Server has to transcode these to JPEG — browsers won't render them
  // natively. /api/file/preview returns the JPEG for HEIC/TIFF/JXL, the raw
  // bytes for everything else (so it's safe to use for any image).
  const needsPreview = ['.heic', '.heif', '.tiff', '.tif', '.jxl'].includes(ext)
  const isOfficeDoc = ['.docx', '.xlsx', '.xls'].includes(ext)
  const wantsExtractedText = isOfficeDoc

  useEffect(() => {
    setText(null)
    setMeta(null)
    setError(null)
    api.fileMeta(path, callerOpts).then((r) => setMeta(r.meta)).catch(() => null)
    if (isMarkdown || isText || isCsv || isJson || isHtml || wantsExtractedText) {
      api
        .fileText(path, callerOpts)
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
  }, [path, isMarkdown, isText, isCsv, isJson, isHtml, wantsExtractedText, callerOpts?.owner])

  const filename = path.split('/').pop() || path
  const parentDir = useMemo(() => {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i)
  }, [path])

  const goToFolder = (dir: string) => {
    // Push the actual folder path to the URL so back / breadcrumb clicks
    // land at the right folder. Preserve `?owner=` so a recipient
    // browsing a shared subtree doesn't fall back into their own vault
    // when they hit the parent crumb.
    setCurrentFolder(dir)
    const segs = dir.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const suffix = ownerOpt ? `?owner=${encodeURIComponent(ownerOpt)}` : ''
    navigate(`${segs ? `/${segs}` : '/'}${suffix}`)
  }

  const indexNow = async () => {
    setIndexing(true)
    try {
      await api.indexFile(path)
      const r = await api.fileText(path, callerOpts).catch(() => null)
      if (r) setText(r.content)
      const m = await api.fileMeta(path, callerOpts).catch(() => null)
      if (m) setMeta(m.meta)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setIndexing(false)
    }
  }

  // Outline is built from the actual rendered DOM after react-markdown +
  // rehype-slug run, so the slug we click matches the heading's real id even
  // for tricky titles (parentheses, slashes, percent signs, etc.).
  const [headings, setHeadings] = useState<Array<{ level: number; text: string; slug: string }>>([])
  useEffect(() => {
    if (!isMarkdown || text == null) {
      setHeadings([])
      return
    }
    // Defer so react-markdown has finished committing the heading nodes.
    const id = requestAnimationFrame(() => {
      const root = contentRef.current
      if (!root) return
      const nodes = root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')
      const out: Array<{ level: number; text: string; slug: string }> = []
      nodes.forEach((n) => {
        const level = Number(n.tagName.slice(1))
        // rehypeAutolinkHeadings appends `<a class="anchor">#</a>` to every
        // heading; clone + strip so the outline label shows just the title.
        const clone = n.cloneNode(true) as HTMLElement
        clone.querySelectorAll('.anchor').forEach((a) => a.remove())
        out.push({ level, text: (clone.textContent ?? '').trim(), slug: n.id })
      })
      setHeadings(out)
    })
    return () => cancelAnimationFrame(id)
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

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0" style={{ background: 'var(--panel-2)' }}>
        <PathBreadcrumb
          dir={parentDir}
          currentName={filename}
          currentAction={
            <button
              className="btn-ghost h-6 w-6 px-0 shrink-0"
              onClick={() => setPanelOpen(true)}
              title="Details"
              aria-label="Open details panel"
            >
              <Info size={13} />
            </button>
          }
          onNavigate={goToFolder}
          onBack={() => goToFolder(parentDir)}
          ownerLabel={ownerOpt}
        />
        <div className="flex-1" />
        {/* Default rendering: visibility starts as "Private" (the safe
            default — most files are private) and flips to "Public" only
            after meta confirms. Tags/Sparkles render with empty/false state
            until meta arrives. */}
        {meta?.ingest.embedded && (
          <Sparkles size={13} className="text-accent shrink-0 mx-1" aria-label="indexed for AI search" />
        )}
        {/* Access affordances. The owner sees every owner-control
            (Tags / Activity / Versions / Share / Public). A
            share-recipient with edit grant additionally sees Tags +
            Activity (mutating the owner's metadata is what "edit"
            actually means in this app). Read-only recipients see
            only navigation + Download. */}
        {ownerOpt && (
          <span
            className="text-[10.5px] font-medium px-1.5 h-5 rounded inline-flex items-center"
            style={{
              background: canEdit ? 'var(--selected)' : 'var(--bg)',
              color: canEdit ? 'var(--accent)' : 'var(--fg-subtle)',
              border: '1px solid var(--border-soft)',
            }}
            title={canEdit ? 'You have edit access via share' : 'You have read-only access via share'}
          >
            {canEdit ? 'shared · edit' : 'shared · read-only'}
          </span>
        )}
        {!ownerOpt && needsReindex && (
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
        {(!ownerOpt || canEdit) && (
          <>
            <TagsButton
              path={path}
              tags={meta?.tags ?? []}
              owner={ownerOpt}
              onSaved={(next) => meta && setMeta({ ...meta, tags: next })}
            />
            <ActivityButton path={path} />
          </>
        )}
        {!ownerOpt && (
          <>
            <VersionsButton path={path} />
            {meta && <ShareWithUserButton paths={[path]} />}
            {meta ? (
              <PublicButton
                path={path}
                meta={meta}
                onSaved={(next) =>
                  setMeta((cur) =>
                    cur
                      ? {
                          ...cur,
                          public: next.public,
                          publicExpiresAt: next.publicExpiresAt ?? null,
                          publicPasswordHash: next.publicPasswordHash ?? null,
                        }
                      : cur,
                  )
                }
              />
            ) : (
              <button className="btn-ghost" disabled>
                <Lock size={13} />
                Private
              </button>
            )}
          </>
        )}
        <PinButton path={path} owner={ownerOpt} isFolder={false} onChanged={refresh} />
        <a className="btn-ghost" href={api.rawUrl(path, callerOpts)} download={filename}>
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
            <div className="text-[13px]">{prettyError(error)}</div>
          </div>
        )}

        {!error && isPdf && (
          <iframe
            src={api.rawUrl(path, callerOpts)}
            title={filename}
            className="w-full h-full border-0"
            style={{ background: 'var(--panel)' }}
          />
        )}

        {!error && isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--panel)' }}>
            <img
              src={needsPreview ? api.previewUrl(path, callerOpts) : api.rawUrl(path, callerOpts)}
              alt={filename}
              className="max-w-full max-h-full rounded shadow-card"
            />
          </div>
        )}

        {!error && isVideo && (
          <MediaPlayer
            kind="video"
            src={api.rawUrl(path, callerOpts)}
            poster={api.previewUrl(path, callerOpts)}
            filename={filename}
          />
        )}

        {!error && isAudio && (
          <MediaPlayer
            kind="audio"
            src={api.rawUrl(path, callerOpts)}
            filename={filename}
          />
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

        {!error && isCsv && text != null && (
          <div className="px-10 py-8">
            <CsvTable text={text} />
          </div>
        )}

        {!error && isJson && text != null && (
          <div className="px-10 py-8">
            <JsonView text={text} />
          </div>
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
                <a className="btn-ghost" href={api.rawUrl(path, callerOpts)} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  Open original
                </a>
              </div>
            </div>
          </div>
        )}

        {!error && !isPdf && !isImage && !isVideo && !isAudio && !isMarkdown && !isText && !isCsv && !isJson && !isHtml && !wantsExtractedText && (
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
      <MetadataPanel
        path={path}
        meta={meta}
        owner={ownerOpt}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      />
    </div>
  )
}

/** Translate raw API error messages into something the user can act on. */
function prettyError(raw: string): string {
  const low = raw.toLowerCase()
  if (low === 'forbidden' || low.includes('forbidden')) {
    return "You don't have access to this file. If someone shared a folder with you, you may have lost that grant — ask them to re-share."
  }
  if (low === 'file not found' || low.includes('not found')) {
    return "The file no longer exists at this path. It may have been moved, renamed, or deleted."
  }
  if (low.includes('link expired')) {
    return 'This public link has expired.'
  }
  if (low.includes('password')) {
    return 'A password is required to open this file.'
  }
  return raw
}



