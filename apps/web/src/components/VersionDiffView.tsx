import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { ApiError, api } from '../lib/api'
import { computeLineDiff } from '../lib/lineDiff'
import { parseImageSize, resolveImageSrc } from '../lib/markdownAssetResolver'

type Props = {
  path: string
  ts: number
  currentText: string
  /** Doc's parent folder, used to resolve relative image / link
   *  paths the same way PathViewer does. Without it, images
   *  written as `![](./img.png)` would 404 because the SPA URL
   *  is not the doc's URL base. */
  parentDir: string
  callerOpts?: { owner?: string; password?: string }
  /** Closes the diff view — caller flips its own state back to
   *  the normal doc rendering. */
  onExit: () => void
}

/**
 * Inline diff view rendered in the doc viewer's main content
 * area. Shows the doc as fully-rendered markdown (tables, lists,
 * code fences, all of it) with green-tinted blocks for content
 * added since the chosen version and red-tinted blocks for
 * content removed.
 *
 * Strategy:
 *   1. Compute line-level LCS diff between the snapshot and the
 *      current text.
 *   2. Group consecutive ops by kind. eq runs render as the
 *      regular markdown view. ins runs render with a green bg
 *      strip. del runs render with a red bg strip + 80% opacity
 *      so the user reads them as "what was there before".
 *   3. Each chunk is its own ReactMarkdown block so the bg
 *      highlight lines up exactly with the changed content
 *      without needing custom mark spans inside the rendered
 *      output.
 *
 * Trade-off: a table whose rows span an ins+eq+ins region will
 * render as three smaller table fragments, not one continuous
 * table. Most edits don't cross block boundaries; when they do,
 * the user still sees the actual content with clear add/remove
 * tinting, just split.
 */
export function VersionDiffView({ path, ts, currentText, parentDir, callerOpts, onExit }: Props) {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSnapshot(null)
    setError(null)
    api
      .fileVersionText(path, ts)
      .then((r) => {
        if (!cancelled) setSnapshot(r.text ?? '')
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, ts])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onExit])

  const chunks = useMemo(() => {
    if (snapshot === null) return null
    const ops = computeLineDiff(snapshot, currentText)
    // Coalesce consecutive ops of the same kind into chunks. Each
    // chunk becomes one ReactMarkdown block in the rendered view.
    const groups: Array<{ kind: 'eq' | 'ins' | 'del'; text: string }> = []
    let buf: string[] = []
    let cur: 'eq' | 'ins' | 'del' | null = null
    const flush = () => {
      if (cur && buf.length > 0) {
        groups.push({ kind: cur, text: buf.join('\n') })
      }
      buf = []
    }
    for (const op of ops) {
      if (op.kind !== cur) {
        flush()
        cur = op.kind
      }
      buf.push(op.line)
    }
    flush()
    return groups
  }, [snapshot, currentText])

  const stats = useMemo(() => {
    if (!chunks) return null
    let added = 0
    let removed = 0
    for (const g of chunks) {
      const lines = g.text.split('\n').length
      if (g.kind === 'ins') added += lines
      else if (g.kind === 'del') removed += lines
    }
    return { added, removed }
  }, [chunks])

  return (
    <div className="flex flex-col h-full">
      {/* Sticky banner inside the doc viewer's scrollable area. Tells
          the user they're in a diff view and gives them a one-click
          exit back to the current rendering. */}
      <div
        className="sticky top-0 z-10 px-3 h-11 flex items-center gap-3 border-b shrink-0"
        style={{ background: 'var(--bg)', borderColor: 'var(--border-soft)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0"
          onClick={onExit}
          title="Return to current view (Esc)"
          aria-label="Return to current view"
        >
          <ChevronLeft size={13} />
        </button>
        <div className="text-[12.5px] text-fg min-w-0 truncate">
          <span className="text-subtle">Comparing with snapshot from </span>
          <span className="font-semibold">{formatFriendlyTimestamp(ts)}</span>
        </div>
        {stats && (
          <div className="text-[12px] font-semibold flex items-center gap-2 ml-auto whitespace-nowrap tabular-nums">
            <span style={{ color: '#00875A' }}>+{stats.added}</span>
            <span style={{ color: 'var(--danger-fg)' }}>−{stats.removed}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-10 py-10">
        {snapshot === null && !error && (
          <div className="text-[12px] text-subtle flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" /> Loading snapshot…
          </div>
        )}
        {error && (
          <div
            className="px-3 py-2 rounded text-[12px]"
            style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
          >
            {error}
          </div>
        )}
        {chunks && chunks.length === 0 && (
          <div className="text-[12px] text-subtle">
            No textual differences — the doc body is identical to this snapshot.
          </div>
        )}
        {chunks && chunks.length > 0 && (
          <article className="md">
            {chunks.map((g, i) => (
              <DiffChunk
                key={i}
                kind={g.kind}
                text={g.text}
                parentDir={parentDir}
                callerOpts={callerOpts}
              />
            ))}
          </article>
        )}
      </div>
    </div>
  )
}

function DiffChunk({
  kind,
  text,
  parentDir,
  callerOpts,
}: {
  kind: 'eq' | 'ins' | 'del'
  text: string
  parentDir: string
  callerOpts?: { owner?: string; password?: string }
}) {
  // Custom img renderer matches the main doc viewer's: resolves
  // relative paths via the markdownAssetResolver + applies any
  // Obsidian-style `|50%` size hint in alt text. Without this,
  // images written as `![](./img.png)` 404 because ReactMarkdown
  // would otherwise leave the relative URL untouched.
  const components = {
    img: ({ src, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const resolved = typeof src === 'string' ? resolveImageSrc(parentDir, src, callerOpts) : src
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
  }
  if (kind === 'eq') {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug, rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    )
  }
  // Restrained diff treatment: just a thin accent bar on the left
  // edge of the changed block — no bg fill, no rounded card. Keeps
  // the markdown rendering looking like the rest of the doc; the
  // bar is a marginal note, not a callout. Removed content is
  // dimmed so the reader's eye gravitates to current content.
  const isIns = kind === 'ins'
  return (
    <div
      style={{
        borderLeft: `2px solid ${isIns ? 'var(--accent)' : 'var(--danger-fg)'}`,
        paddingLeft: '12px',
        marginLeft: '-14px',
        opacity: isIns ? 1 : 0.6,
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug, rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** Banner-friendly timestamp. "Today at 12:09", "Yesterday at
 *  12:09", "May 20 at 12:09", or "May 20, 2024 at 12:09" depending
 *  on how distant the version is from now. Locale-aware for both
 *  the date and the clock. */
function formatFriendlyTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (sameDay(d, now)) return `Today at ${time}`
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, yesterday)) return `Yesterday at ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  const dateLabel = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${dateLabel} at ${time}`
}
