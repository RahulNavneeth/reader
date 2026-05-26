import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, X, AlertCircle, ExternalLink, Sparkles, RefreshCw, Lock, Info, Copy as CopyIcon, Trash2, Loader2, Check, MessageCircle, ArrowUp, Pencil } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import 'highlight.js/styles/github.css'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { useConfirm } from '../lib/confirm'
import { copyText } from '../lib/clipboard'
import {
  parseImageSize,
  resolveImageSrc,
  resolveLinkHref,
} from '../lib/markdownAssetResolver'
import { setFaviconForFile } from '../lib/favicon'
import { PathBreadcrumb } from './PathBreadcrumb'
import { TagsButton } from './TagsButton'
import { ActivityButton } from './ActivityButton'
import { FindSimilarButton } from './FindSimilarButton'
import { CollectionsToolbarButton } from './CollectionsToolbarButton'
import { DocRail } from './DocRail'
import { VersionDiffView } from './VersionDiffView'
import { ProposedEditPreview, type PreviewData } from './ProposedEditPreview'
import { PublicButton } from './PublicButton'
import { ShareWithUserButton } from './ShareWithUserButton'
import { CsvTable } from './CsvTable'
import { JsonView } from './JsonView'
import { MetadataPanel } from './MetadataPanel'
import { ChatDock } from './ChatDock'
import { SelectionPopover } from './SelectionPopover'
import { PinButton } from './PinButton'
import { ArchiveButton } from './ArchiveButton'
import { SaveAsTemplateButton } from './SaveAsTemplateButton'
import { RefreshTemplateButton } from './RefreshTemplateButton'
import { MediaPlayer } from './MediaPlayer'
import { useReaderEvents } from '../lib/events'
import { useCrdtBody } from '../lib/crdt/useCrdtBody'
import { CrdtEditor } from './CrdtEditor'
import { AwarenessPill } from './AwarenessPill'

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
  const { setCurrentFolder, refresh, chatEnabled } = useVault()
  const confirm = useConfirm()
  const [copyBusy, setCopyBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  // Edit mode: when true, the viewer renders <CrdtEditor> instead
  // of the read-only markdown render. Local typing flows into the
  // Y.Text via useCrdtBody.replace, which broadcasts to every
  // other connected viewer of this docId.
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  /** Outline section state inside the rail. When both this AND
   *  versionsOpen are false, the rail itself shrinks to 32 px
   *  with two stacked icons (outline + versions). Otherwise the
   *  rail is 240 px and shows headers for both sections, with
   *  each section's body visible only when its own flag is true. */
  const [outlineOpen, setOutlineOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:outlineOpen') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('reader:outlineOpen', outlineOpen ? '1' : '0') } catch { /* ignore */ }
  }, [outlineOpen])
  const [versionsOpen, setVersionsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:versionsRailOpen') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('reader:versionsRailOpen', versionsOpen ? '1' : '0') } catch { /* ignore */ }
  }, [versionsOpen])
  /** Active diff state. When non-null, the main content area
   *  swaps from rendered markdown to an inline line-by-line diff
   *  between this version's snapshot and the current text. */
  const [diffTs, setDiffTs] = useState<number | null>(null)
  /** Active proposed-edit preview. When set, the main content area
   *  swaps from rendered markdown to an inline diff between the
   *  current doc and what it would look like after applying this
   *  message's pending edit. */
  const [previewMessageId, setPreviewMessageId] = useState<string | null>(null)
  /** Cache of fetched preview payloads, keyed by messageId. Lets
   *  the user toggle preview ↔ back without re-fetching (and
   *  without showing the loading flicker on the second open). */
  const previewCacheRef = useRef<Map<string, PreviewData>>(new Map())
  // Tick state so React re-renders when cache fills. The ref is
  // the source of truth — we just need to nudge a render.
  const [, setPreviewCacheTick] = useState(0)
  /** Bumped on per-op apply / discard so ChatDock reloads its
   *  history and the proposed-edit card reflects the shrunken
   *  pendingEdit array (or flips to Applied if empty). */
  const [chatHistoryReloadKey, setChatHistoryReloadKey] = useState(0)
  /** Bumped when the user restores a version — DocRail re-fetches
   *  /api/file/versions so the new pre-restore snapshot row appears
   *  at the top of the list without a page reload. */
  const [versionsReloadKey, setVersionsReloadKey] = useState(0)
  // Clear diff view whenever the doc changes.
  useEffect(() => {
    setDiffTs(null)
    setPreviewMessageId(null)
    setEditing(false)
    previewCacheRef.current.clear()
  }, [path])
  // PathViewer is no longer keyed on path (so the chat sidebar
  // inside stays mounted across file switches without flicker), so
  // we now have to explicitly drop the things `key` used to wipe:
  // pending selection-driven chat triggers, scroll position. The
  // text / meta / error reset happens in their own fetch effect.
  useEffect(() => {
    setPendingChatMessage(null)
    setPendingChatQuote(null)
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [path])
  // Chat-open is global: opening Reader AI on one doc keeps it
  // open as the user navigates to others. PathViewer remounts per
  // path (it's keyed on `path` in VaultView) so component-local
  // state would reset; localStorage survives the remount.
  const [chatOpen, setChatOpenState] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:chatOpen') === '1' } catch { return false }
  })
  const setChatOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setChatOpenState((prev) => {
      const next = typeof v === 'function' ? (v as (p: boolean) => boolean)(prev) : v
      try { localStorage.setItem('reader:chatOpen', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])
  // Pending chat message coming from outside ChatDock (e.g. the
  // selection-popover "Explain with Reader AI" button). Consumed
  // by ChatDock via prop + useEffect, then cleared by the
  // onPendingConsumed callback.
  const [pendingChatMessage, setPendingChatMessage] = useState<string | null>(null)
  // Pending quote from the "Reply with Reader AI" button. Unlike
  // pendingChatMessage this is NOT auto-sent — it lands as a chip
  // above the composer so the user can type any follow-up against
  // the quoted selection.
  const [pendingChatQuote, setPendingChatQuote] = useState<string | null>(null)
  // Sticky copy of `meta` for ChatDock. The main fetch effect
  // resets `meta` to null between path changes (clears stale
  // toolbar state). ChatDock is rendered as `{chatOpen && meta &&
  // …}` so that null transition would unmount it for one frame
  // and flash the sidebar. Holding the previous meta until a new
  // one arrives keeps ChatDock continuously mounted across
  // navigation — it sees old → new without going through null.
  const [chatMeta, setChatMeta] = useState<DocumentMeta | null>(null)
  useEffect(() => {
    if (meta) setChatMeta(meta)
  }, [meta])

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
    // Any terminal status (incl. `ready` with embedded=false when
    // the embed backend was down at ingest time) means the
    // pipeline finished — polling further would spam the server
    // until the user clicks Re-index manually.
    const terminal =
      meta.ingest.status === 'ready' ||
      meta.ingest.status === 'failed' ||
      meta.ingest.status === 'no-text'
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

  // Path-scoped SSE refetch: when an MCP tool, chat apply-op, or an external
  // editor changes *this* file we want the viewer to update without the user
  // having to re-navigate. We watch for edit/ingest/visibility/tags/archive
  // events whose path matches the one we're rendering.
  const wantsBody = isMarkdown || isText || isCsv || isJson || isHtml || wantsExtractedText
  // Phase 3 CRDT body overlay: open a Y.Doc for markdown files
  // owned by the viewer. The hook handles the y-websocket
  // lifecycle + IndexedDB persistence; when the live text differs
  // from the fetched copy we render the CRDT version so changes
  // from other devices / agents land without a refetch.
  // Enable only for markdown docs the viewer owns. Cross-owner
  // / public viewers stay on the existing HTTP fetch path until
  // the server route grows non-owner ACL support.
  const crdtEnabled = isMarkdown && !ownerOpt && !!meta
  const crdt = useCrdtBody(meta?.id ?? null, crdtEnabled)
  // Prefer CRDT text once it's available AND synced — otherwise
  // a brand-new hook hasn't pulled the IDB cache yet and would
  // briefly overwrite our fetched text with the empty string.
  const displayText = (() => {
    if (!crdt) return text
    if (!crdt.synced && crdt.text === '') return text
    if (!crdt.text) return text
    return crdt.text
  })()
  const refetchForEvent = useCallback(
    (e: { type: string; path?: string; status?: string }) => {
      if (!e.path || e.path !== path) return
      // Meta always — covers tag/visibility/archive toggles + ingest status.
      api.fileMeta(path, callerOpts).then((r) => setMeta(r.meta)).catch(() => null)
      // Any content-changing event also drops a new version row, so kick
      // DocRail to refetch its versions list. Without this the rail keeps
      // showing the pre-edit list until manual reload.
      if (e.type === 'edit' || e.type === 'restore') {
        setVersionsReloadKey((k) => k + 1)
      }
      // Body bytes only on actual content changes. Skip the intermediate
      // ingest stages (extracting/embedding) so we don't thrash; the final
      // `ingest:ready` covers slow extractors, and `edit` covers fast MCP
      // / chat writes (they publish before the ingest pipeline kicks off).
      if (!wantsBody) return
      const shouldRefetch =
        e.type === 'edit' ||
        e.type === 'restore' ||
        (e.type === 'ingest' && e.status === 'ready')
      if (!shouldRefetch) return
      api
        .fileText(path, callerOpts)
        .then((r) => setText(r.content))
        .catch(() => null)
    },
    [path, callerOpts?.owner, wantsBody],
  )
  useReaderEvents(refetchForEvent)

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

  // DocRail is shown for any markdown doc so the version-history
  // section is reachable even when the outline list itself is
  // empty / single-heading. The OUTLINE section inside renders
  // conditionally on headings.length > 1; the VERSIONS section
  // hides itself when no snapshots exist.
  const showOutline = isMarkdown
  const hasOutlineList = isMarkdown && headings.length > 1
  const contentRef = useRef<HTMLDivElement>(null)
  /** Show the floating "back to top" button only after the user has
   *  scrolled past ~400px. Same threshold the Timeline uses so the
   *  affordance feels consistent across long-scroll surfaces. */
  const [showScrollTop, setShowScrollTop] = useState(false)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onScroll = () => setShowScrollTop(el.scrollTop > 400)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // Re-bind when the content body or path swaps — the ref points
    // at a new element across route changes inside the same viewer.
  }, [text, path])

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
      {/* No `overflow-x-auto` here even though buttons can wrap on
          narrow viewports. CSS spec: when one overflow axis is
          non-visible, the other clips too — and that silently chopped
          the Share / Private / Tags popovers off below the header.
          `flex-wrap` already handles narrow layouts by wrapping to a
          new row, so horizontal scroll is not needed. */}
      <header className="min-h-11 px-3 py-1.5 flex items-center gap-2 border-b border-app shrink-0 flex-wrap" style={{ background: 'var(--surface-2)' }}>
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
              border: '1px solid var(--border)',
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
            title={`${reindexLabel} — run extraction + embedding so this file is searchable`}
            aria-label={reindexLabel}
          >
            {indexing ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {/* Label stays visible only while indexing so the user
                gets progress feedback; idle state is icon-only to
                keep the toolbar compact. */}
            {indexing && <span>Indexing…</span>}
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
            {meta && <CollectionsToolbarButton docId={meta.id} path={meta.storageKey} />}
            {meta && <FindSimilarButton docId={meta.id} path={meta.storageKey} ownerHint={ownerOpt} />}
            <ActivityButton path={path} />
          </>
        )}
        {!ownerOpt && (
          <>
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
              <button className="btn-ghost" disabled title="Private" aria-label="Private">
                <Lock size={13} />
              </button>
            )}
          </>
        )}
        <PinButton path={path} owner={ownerOpt} isFolder={false} onChanged={refresh} />
        {!ownerOpt && meta && (
          <ArchiveButton
            path={path}
            meta={meta}
            onSaved={(next) =>
              setMeta((cur) =>
                cur ? { ...cur, archived: next.archived, archivedAt: next.archivedAt ?? null } : cur,
              )
            }
          />
        )}
        {!ownerOpt && isMarkdown && meta && (
          <SaveAsTemplateButton
            path={path}
            defaultTitle={meta.title || filename.replace(/\.[^.]+$/, '')}
          />
        )}
        {!ownerOpt && meta?.templateSource && (
          <RefreshTemplateButton
            meta={meta}
            onRefreshed={(next) => setMeta(next)}
          />
        )}
        {/* Live-collab edit toggle. Markdown + own-vault only —
            the CRDT WS route is owner-gated and other surfaces
            (PDFs, images, csv) don't have a sensible editor. */}
        {!ownerOpt && isMarkdown && meta && crdt && (
          <button
            className="btn-ghost"
            onClick={() => setEditing((v) => !v)}
            title={editing ? 'Done editing' : 'Edit document'}
            aria-label={editing ? 'Done editing' : 'Edit'}
            style={editing ? { color: 'var(--accent)', background: 'var(--selected)' } : undefined}
          >
            {editing ? <Check size={13} /> : <Pencil size={13} />}
          </button>
        )}
        {crdt?.awareness && <AwarenessPill awareness={crdt.awareness} />}
        {/* Copy the file's actual content to the system clipboard:
            text for markdown/csv/json/txt/html and any file we've
            extracted text for; PNG/JPEG/GIF/WebP go on as image
            blobs (via ClipboardItem) so they paste into chat /
            docs / image editors. Other binary types (PDF, audio,
            video, zips) can't be put on the clipboard meaningfully
            — the button is disabled with a tooltip in that case. */}
        {(() => {
          const isCopyableImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
          const hasCopyableText =
            isMarkdown || isText || isCsv || isJson || isHtml || wantsExtractedText
          const canCopy = isCopyableImage || (hasCopyableText && text != null)
          const titleMsg = canCopy
            ? isCopyableImage
              ? 'Copy image to clipboard'
              : 'Copy file contents to clipboard'
            : copySupportHint(ext)
          return (
            <button
              className="btn-ghost"
              disabled={copyBusy || !canCopy}
              onClick={async () => {
                if (copyBusy || !canCopy) return
                setCopyBusy(true)
                try {
                  if (isCopyableImage) {
                    // Fetch the raw bytes and write the matching MIME
                    // through ClipboardItem. Chrome/Safari accept
                    // PNG/JPEG/WebP/GIF; Firefox is PNG-only and will
                    // throw — we catch + surface the error rather than
                    // silently fall back, so the user knows nothing
                    // landed on the clipboard.
                    const res = await fetch(api.rawUrl(path, callerOpts), { credentials: 'include' })
                    if (!res.ok) throw new Error(`HTTP ${res.status}`)
                    const blob = await res.blob()
                    await navigator.clipboard.write([
                      new ClipboardItem({ [blob.type || 'image/png']: blob }),
                    ])
                  } else if (text != null) {
                    // copyText handles the modern API + a legacy
                    // execCommand fallback for http:// or
                    // Permissions-Policy-locked contexts.
                    const ok = await copyText(text)
                    if (!ok) throw new Error('clipboard write blocked by the browser')
                  }
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setCopyBusy(false)
                }
              }}
              title={titleMsg}
            >
              {copyBusy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : copied ? (
                <Check size={13} className="text-accent" />
              ) : (
                <CopyIcon size={13} />
              )}
            </button>
          )
        })()}
        <a
          className="btn-ghost"
          href={api.rawUrl(path, callerOpts)}
          download={filename}
          title="Download"
          aria-label="Download"
        >
          <Download size={14} />
        </a>
        {/* Move to Trash (30-day retention; user can restore). Hidden
            for share-recipients — they can't delete in the owner's
            vault. */}
        {!ownerOpt && (
          <button
            className="btn-ghost"
            onClick={async () => {
              if (deleteBusy) return
              const ok = await confirm({
                title: 'Move to Trash',
                message: `"${filename}" goes to Trash where it can still be restored. Purges automatically after 30 days.`,
                confirmLabel: 'Move to Trash',
                destructive: true,
              })
              if (!ok) return
              setDeleteBusy(true)
              try {
                await api.deleteFile(path)
                refresh()
                navigate(parentDir ? `/${parentDir.split('/').map(encodeURIComponent).join('/')}` : '/')
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e))
              } finally {
                setDeleteBusy(false)
              }
            }}
            disabled={deleteBusy}
            style={{ color: '#BF2600' }}
            title="Move to Trash"
          >
            {deleteBusy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
          </button>
        )}
        <button className="btn-ghost" onClick={() => navigate('/')} title="Close">
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-hidden flex">
       <div className="flex-1 relative min-w-0">
        <div ref={contentRef} className="h-full overflow-y-auto" style={{ background: 'var(--surface-3)' }}>
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
            style={{ background: 'var(--surface-3)' }}
          />
        )}

        {!error && isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--surface-3)' }}>
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
            hlsSrc={meta?.hlsReady ? api.hlsUrl(path, callerOpts) : undefined}
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

        {!error && isMarkdown && text != null && previewMessageId === null && diffTs !== null && (
          <VersionDiffView
            path={path}
            ts={diffTs}
            currentText={text}
            parentDir={parentDir}
            callerOpts={callerOpts}
            onExit={() => setDiffTs(null)}
            // Restore button always rendered for authed users; the
            // server enforces userCanEdit and returns 403 on a
            // read-only share, which surfaces as the inline error.
            onRestored={async () => {
              try {
                const [r, m] = await Promise.all([
                  api.fileText(path, callerOpts).catch(() => null),
                  api.fileMeta(path, callerOpts).catch(() => null),
                ])
                if (r) setText(r.content)
                if (m) setMeta(m.meta)
                // The restore wrote a fresh pre-restore snapshot;
                // bump the version list so it shows up.
                setVersionsReloadKey((k) => k + 1)
              } catch {
                /* swallow */
              }
            }}
          />
        )}

        {!error && isMarkdown && text != null && previewMessageId !== null && meta && (
          <ProposedEditPreview
            docId={meta.id}
            messageId={previewMessageId}
            parentDir={parentDir}
            callerOpts={callerOpts}
            seedData={previewCacheRef.current.get(previewMessageId) ?? null}
            onLoaded={(data) => {
              previewCacheRef.current.set(previewMessageId, data)
              setPreviewCacheTick((t) => t + 1)
            }}
            onOpMutated={() => {
              // A per-op apply or discard succeeded — the cached
              // preview for this message is stale (its op list
              // shrunk), and the chat card needs to refresh so
              // the stack of <ProposedEditCard>s reflects the
              // server's new pendingEdit.
              previewCacheRef.current.delete(previewMessageId)
              setChatHistoryReloadKey((k) => k + 1)
            }}
            onDocChanged={async () => {
              // The underlying doc just changed (an op was
              // applied). Refetch text + meta so the rest of
              // the doc state stays in sync.
              const [r, m] = await Promise.all([
                api.fileText(path, callerOpts).catch(() => null),
                api.fileMeta(path, callerOpts).catch(() => null),
              ])
              if (r) setText(r.content)
              if (m) setMeta(m.meta)
            }}
            onExit={() => setPreviewMessageId(null)}
            onAllResolved={() => setPreviewMessageId(null)}
          />
        )}

        {!error && isMarkdown && text != null && diffTs === null && previewMessageId === null && editing && crdt && (
          <div className="h-full">
            <CrdtEditor
              crdt={crdt}
              userLabel={meta?.owner ?? null}
              onExit={() => setEditing(false)}
            />
          </div>
        )}
        {!error && isMarkdown && text != null && diffTs === null && previewMessageId === null && !editing && (
          <div className="px-10 py-10">
            <article className="md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[
                  rehypeSlug,
                  [rehypeAutolinkHeadings, { behavior: 'append', properties: { className: ['anchor'], 'aria-hidden': 'true', tabIndex: -1 }, content: { type: 'text', value: '#' } }],
                  rehypeHighlight,
                ]}
                // Custom renderers that resolve relative URLs against
                // the doc's folder. Without these, `![](./img.jpg)`
                // and `[link](./other.md)` produced broken paths that
                // resolved relative to the SPA URL.
                components={{
                  img: ({ src, alt, ...rest }) => {
                    const resolved = typeof src === 'string'
                      ? resolveImageSrc(parentDir, src, callerOpts)
                      : src
                    // Obsidian-style sizing: `![photo|400](url)`,
                    // `![photo|400x300](url)`, `![photo|50%](url)`.
                    // Apply via inline style so the user's choice
                    // overrides the .md article CSS without needing
                    // a separate stylesheet hook.
                    const { alt: cleanAlt, width, height } = parseImageSize(alt)
                    const sizeStyle: React.CSSProperties = {}
                    if (width) sizeStyle.width = width
                    if (height) sizeStyle.height = height
                    return (
                      <img
                        src={resolved as string}
                        alt={cleanAlt || alt}
                        style={Object.keys(sizeStyle).length ? sizeStyle : undefined}
                        {...rest}
                      />
                    )
                  },
                  a: ({ href, children, ...rest }) => {
                    if (typeof href !== 'string') return <a {...rest}>{children}</a>
                    const resolved = resolveLinkHref(parentDir, href, callerOpts)
                    // External / fragment links keep default behavior.
                    // Internal vault links navigate via the SPA — we
                    // can't return a <Link> because react-markdown
                    // would warn about ref forwarding; setting href
                    // works fine since the SPA's pushState router
                    // intercepts same-origin paths on click.
                    if (resolved.startsWith('/') && !resolved.startsWith('//')) {
                      return (
                        <a
                          href={resolved}
                          onClick={(e) => {
                            // Spare modifier-clicks so cmd-click opens
                            // a new tab as expected.
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                            e.preventDefault()
                            navigate(resolved)
                          }}
                          {...rest}
                        >
                          {children}
                        </a>
                      )
                    }
                    return (
                      <a href={resolved} {...rest}>
                        {children}
                      </a>
                    )
                  },
                }}
              >
                {displayText}
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
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3" style={{ background: 'var(--viewer)' }}>
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
        {/* Floating action stack — back-to-top sits above the chat FAB
            when both are visible, slides into the corner alone when the
            chat panel is open. Single column so the two affordances
            never compete for the same visual slot. */}
        {(showScrollTop || (chatEnabled && !chatOpen && meta)) && (
          <div className="absolute bottom-5 right-5 z-30 flex flex-col items-end gap-2">
            {showScrollTop && (
              <button
                type="button"
                onClick={() => contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                className="h-11 w-11 rounded-full shadow-card inline-flex items-center justify-center transition-opacity hover:opacity-90"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  border: '1px solid var(--accent)',
                }}
                title="Back to top"
                aria-label="Back to top"
              >
                <ArrowUp size={18} />
              </button>
            )}
            {chatEnabled && !chatOpen && meta && (
              <button
                className="h-11 w-11 rounded-full inline-flex items-center justify-center transition-transform hover:scale-105"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  boxShadow: '0 8px 20px rgba(15, 23, 42, 0.18)',
                }}
                onClick={() => setChatOpen(true)}
                title="Ask Reader AI about this document"
                aria-label="Open Reader AI"
              >
                <MessageCircle size={18} />
              </button>
            )}
          </div>
        )}
        {/* Selection-driven "Explain with Reader AI" popover.
            Scoped to the doc content scroller via contentRef so
            selections in the chat sidebar / outline don't trigger
            it. The handler opens the chat and queues the selection
            as a pending message — ChatDock consumes it and auto-
            sends "Explain this: …" once mounted. Hidden alongside
            the chat dock when Reader AI is off. */}
        {chatEnabled && meta && (
          <SelectionPopover
            containerRef={contentRef}
            onExplain={(text) => {
              // Cap to ~3500 chars to leave room for the prefix
              // inside the server's 4000-char content limit.
              const trimmed = text.length > 3500 ? text.slice(0, 3500) + '…' : text
              setPendingChatMessage(`Explain this: "${trimmed}"`)
              setChatOpen(true)
            }}
            // Reply affordance is universal — even read-only viewers
            // can ask freeform questions against a quoted selection.
            // The Apply button on any resulting proposed_edit card
            // is the actual edit gate (server enforces write access).
            onReply={(text) => {
              const trimmed = text.length > 3500 ? text.slice(0, 3500) + '…' : text
              setPendingChatQuote(trimmed)
              setChatOpen(true)
            }}
          />
        )}
       </div>

       {/* AI chat sidebar — placed BEFORE the outline rail so it sits
           adjacent to the content. The natural reading flow is left
           → right; the active "ask" surface belongs next to the doc,
           not pushed past navigation chrome. */}
       {chatEnabled && chatOpen && chatMeta && (
         <ChatDock
           meta={chatMeta}
           onClose={() => setChatOpen(false)}
           pendingMessage={pendingChatMessage}
           onPendingConsumed={() => setPendingChatMessage(null)}
           pendingQuote={pendingChatQuote}
           onPendingQuoteConsumed={() => setPendingChatQuote(null)}
           onDocEdited={async () => {
             // The chat just applied a proposed edit to this doc.
             // Refetch the body + meta so the viewer reflects the
             // new content without a hard reload. Also drop any
             // active edit preview — it's now stale.
             setPreviewMessageId(null)
             try {
               const [r, m] = await Promise.all([
                 api.fileText(path, callerOpts).catch(() => null),
                 api.fileMeta(path, callerOpts).catch(() => null),
               ])
               if (r) setText(r.content)
               if (m) setMeta(m.meta)
             } catch {
               /* swallow — user can refresh manually */
             }
           }}
           onPreviewEdit={(messageId) =>
             setPreviewMessageId((cur) => (cur === messageId ? null : messageId))
           }
           previewingMessageId={previewMessageId}
           historyReloadKey={chatHistoryReloadKey}
         />
       )}
       {showOutline && (
         <DocRail
           path={path}
           text={text}
           headings={headings}
           hasOutlineList={hasOutlineList}
           outlineOpen={outlineOpen}
           setOutlineOpen={setOutlineOpen}
           versionsOpen={versionsOpen}
           setVersionsOpen={setVersionsOpen}
           jumpTo={jumpTo}
           activeDiffTs={diffTs}
           onPickVersion={(ts) => setDiffTs(ts)}
           versionsReloadKey={versionsReloadKey}
         />
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




/** Tooltip explaining why the Copy button is disabled for a given
 *  file type. The system clipboard only natively understands text
 *  and a handful of image MIMEs; PDFs / audio / video / archives
 *  have no clipboard representation. */
function copySupportHint(ext: string): string {
  if (ext === '.pdf') return 'Copy not supported for PDFs — use Download.'
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) {
    return 'Copy not supported for video — use Download.'
  }
  if (['.mp3', '.m4a', '.wav', '.flac', '.ogg'].includes(ext)) {
    return 'Copy not supported for audio — use Download.'
  }
  if (['.zip', '.tar', '.gz', '.7z'].includes(ext)) {
    return 'Copy not supported for archives — use Download.'
  }
  return 'Copy not supported for this file type — use Download.'
}
