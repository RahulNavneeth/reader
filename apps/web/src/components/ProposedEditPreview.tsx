import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Loader2, Check, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { ApiError, api, type ProposedEditOpDTO } from '../lib/api'
import { computeLineDiff, type DiffOp } from '../lib/lineDiff'
import { parseImageSize, resolveImageSrc } from '../lib/markdownAssetResolver'

type Props = {
  docId: string
  messageId: string
  parentDir: string
  callerOpts?: { owner?: string; password?: string }
  /** Closes the preview and returns to the normal doc view. */
  onExit: () => void
  /** Optional cached preview payload — skip fetch and render
   *  synchronously when re-opening the same preview. */
  seedData?: PreviewData | null
  /** Fires after the internal fetch completes so the parent can
   *  cache the result. */
  onLoaded?: (data: PreviewData) => void
  /** Bumped externally (e.g. after a successful per-op apply) so
   *  the preview re-fetches its data without a full unmount. */
  refreshKey?: number
  /** Called after any per-op apply or discard so the parent can
   *  refresh the chat history (the card needs to reflect the new
   *  pendingEdit array, or the Applied pill if it emptied). */
  onOpMutated?: () => void
  /** Called after a successful per-op apply so the parent can
   *  refetch the doc body (the underlying text just changed). */
  onDocChanged?: () => void
  /** Called when every op in the preview has reached a terminal
   *  state (accepted, rejected, or already-applied server-side).
   *  The parent uses this to exit preview mode and return to the
   *  normal doc viewer so the user isn't left staring at a fully
   *  resolved card. Fires once per resolution session, after a
   *  short delay so the final state flashes briefly first. */
  onAllResolved?: () => void
}

export type PreviewData = {
  current: string
  next: string
  opPreviews: Array<{
    op: ProposedEditOpDTO
    next: string
    error?: string
    /** Server-side flag: this op was accepted via the per-op flow
     *  earlier and shouldn't be rendered as a pending hunk. The
     *  inline `op.appliedAt` carries the same signal redundantly so
     *  either check is safe. */
    applied?: boolean
  }>
}

type OpInfo = {
  opIndex: number
  op: ProposedEditOpDTO
  /** Line range in the current doc that this op touches. Inclusive
   *  start, exclusive end. For pure insertions this is a zero-
   *  length range positioned just before the insertion point. */
  startLine: number
  endLine: number
  diff: DiffOp[]
  /** Original current-text lines in the hunk's range — what shows
   *  when the user rejects this edit (we just render what was
   *  there). */
  beforeText: string
  /** The op's new content reconstructed from the diff's eq+ins
   *  lines — what replaces the hunk visually after Accept. */
  afterText: string
  error?: string
}

/** Local per-op decision. Optimistic: the buttons commit to the
 *  server in the background but the visual flips immediately so
 *  the user sees the accepted text rendered inline (or the
 *  original kept in place on reject). On server failure we revert
 *  to 'pending' and surface the error. */
type Decision = 'pending' | 'accepted' | 'rejected'

/**
 * Cursor-style inline preview. Renders the doc as a sequence of
 * markdown segments interleaved with per-op diff hunks. Each hunk
 * has its own Apply / Discard buttons so the user can cherry-pick
 * which proposed edits to commit, instead of an all-or-nothing
 * apply. The chat card's Apply button keeps the atomic "apply all"
 * semantics for users who don't want to drill in.
 */
export function ProposedEditPreview({
  docId,
  messageId,
  parentDir,
  callerOpts,
  onExit,
  seedData,
  onLoaded,
  refreshKey,
  onOpMutated,
  onDocChanged,
  onAllResolved,
}: Props) {
  const [data, setData] = useState<PreviewData | null>(seedData ?? null)
  const [error, setError] = useState<string | null>(null)
  /** Per-op in-flight state for the buttons. */
  const [busy, setBusy] = useState<Record<number, 'applying' | 'discarding' | null>>({})
  /** Local decision state per op. Set AFTER the server commit
   *  succeeds — flipping it before the await would render the
   *  accepted view, then snap back if the server returned a 409,
   *  which read as a glitchy "going bad" flash to the user. */
  const [decisions, setDecisions] = useState<Record<number, Decision>>({})
  /** Per-op error surfaced inline in the hunk (in place of the
   *  Accept / Reject buttons). Lets the user see WHICH hunk failed
   *  and why, without forcing them to read a banner at the top. */
  const [opErrors, setOpErrors] = useState<Record<number, string>>({})
  /** Bumped when an apply-op response says the server's pending-edit
   *  array is now stale (e.g. count shrank since we previewed) so the
   *  preview re-fetches and renders the actual current truth. */
  const [localRefreshTick, setLocalRefreshTick] = useState(0)
  /** One-shot guard so the all-resolved callback fires exactly once
   *  per preview session — without it the useEffect below would keep
   *  re-firing as React re-renders after the parent exits. */
  const allResolvedFiredRef = useRef(false)

  // Auto-exit once every op has a terminal decision (accepted /
  // rejected / already-applied server-side). The brief setTimeout
  // lets the accepted-state visual flash before the preview tears
  // down — without it the card resolves and disappears in the same
  // frame, which reads as a glitch.
  const onAllResolvedRef = useRef(onAllResolved)
  useEffect(() => {
    onAllResolvedRef.current = onAllResolved
  })
  useEffect(() => {
    if (allResolvedFiredRef.current) return
    if (!data || data.opPreviews.length === 0) return
    const allDone = data.opPreviews.every((op, i) => {
      if (op.applied || op.op.appliedAt) return true
      const d = decisions[i]
      return d === 'accepted' || d === 'rejected'
    })
    if (!allDone) return
    allResolvedFiredRef.current = true
    const t = window.setTimeout(() => onAllResolvedRef.current?.(), 600)
    return () => window.clearTimeout(t)
  }, [data, decisions])

  // Live refs for the callbacks + seedData. The useEffect below
  // intentionally OMITS these from its deps — PathViewer passes
  // fresh callback identities on every render (because it doesn't
  // memo them), so depending on them would re-run the fetch on
  // every parent re-render, including the ones triggered by our
  // own onDocChanged callback after Accept. That cascade is what
  // produced the "preview reloads after Accept" flicker.
  const seedDataRef = useRef(seedData)
  const onLoadedRef = useRef(onLoaded)
  useEffect(() => {
    seedDataRef.current = seedData
    onLoadedRef.current = onLoaded
  })

  useEffect(() => {
    if (seedDataRef.current && refreshKey == null) {
      setData(seedDataRef.current)
      return
    }
    let cancelled = false
    setData(null)
    setError(null)
    api
      .previewChatEdit(docId, messageId)
      .then((r) => {
        if (cancelled) return
        // Defensive: an older / mismatched server build might omit
        // opPreviews. Treat missing as empty so the iterator code
        // below doesn't crash; the user just sees "no pending
        // changes" instead of a render error.
        const payload: PreviewData = {
          current: r.current,
          next: r.next,
          opPreviews: Array.isArray(r.opPreviews) ? r.opPreviews : [],
        }
        setData(payload)
        onLoadedRef.current?.(payload)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [docId, messageId, refreshKey, localRefreshTick])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onExit])

  const opInfos = useMemo<OpInfo[] | null>(() => {
    if (!data) return null
    const currentLines = data.current.split('\n')
    const infos: OpInfo[] = []
    for (let i = 0; i < data.opPreviews.length; i++) {
      const opData = data.opPreviews[i]
      // Skip ops that are already applied. They show up in the
      // chat card as "Applied to <heading>" pills; rendering a
      // diff for them here would be misleading (they're not
      // pending and can't be re-applied / discarded).
      if (opData.applied || opData.op.appliedAt) continue
      if (opData.error) {
        infos.push({
          opIndex: i,
          op: opData.op,
          startLine: 0,
          endLine: 0,
          diff: [],
          beforeText: '',
          afterText: '',
          error: opData.error,
        })
        continue
      }
      const diff = computeLineDiff(data.current, opData.next)
      // Find first/last line in current that's touched by this op.
      let curLine = 0
      let first = -1
      let last = -1
      for (const op of diff) {
        if (op.kind === 'eq') {
          curLine++
        } else if (op.kind === 'del') {
          if (first < 0) first = curLine
          curLine++
          last = curLine
        } else {
          // ins — anchor at the current line index (no advance).
          if (first < 0) first = curLine
          if (last < curLine) last = curLine
        }
      }
      const startLine = first < 0 ? 0 : first
      const endLine = last < 0 ? 0 : last
      // beforeText: what's there now, in the hunk range.
      // afterText: what would replace it — we reconstruct from the
      // ins lines within the hunk's region (eq lines inside the
      // hunk stay as context, so include them too in the right
      // order). This way Accept can render the post-op slice as
      // pure markdown without re-running applyOp on the client.
      const beforeText = currentLines.slice(startLine, endLine).join('\n')
      const afterText = reconstructAfter(diff, startLine, endLine)
      infos.push({
        opIndex: i,
        op: opData.op,
        startLine,
        endLine,
        diff,
        beforeText,
        afterText,
      })
    }
    // Sort by startLine so we can weave segments left-to-right.
    infos.sort((a, b) => a.startLine - b.startLine)
    return infos
  }, [data])

  /** Build the segment list — alternating "unchanged" markdown
   *  ranges from the current doc and per-op "hunk" zones. */
  const segments = useMemo<Segment[] | null>(() => {
    if (!data || !opInfos) return null
    const lines = data.current.split('\n')
    const out: Segment[] = []
    let cursor = 0
    for (const info of opInfos) {
      if (info.startLine > cursor) {
        out.push({ kind: 'unchanged', text: lines.slice(cursor, info.startLine).join('\n') })
      }
      out.push({ kind: 'hunk', info })
      cursor = Math.max(cursor, info.endLine)
    }
    if (cursor < lines.length) {
      out.push({ kind: 'unchanged', text: lines.slice(cursor).join('\n') })
    }
    return out
  }, [data, opInfos])

  const stats = useMemo(() => {
    if (!opInfos) return null
    let added = 0
    let removed = 0
    for (const info of opInfos) {
      for (const op of info.diff) {
        if (op.kind === 'ins') added++
        else if (op.kind === 'del') removed++
      }
    }
    return { added, removed }
  }, [opInfos])

  const setOpBusy = (opIndex: number, v: 'applying' | 'discarding' | null) => {
    setBusy((cur) => ({ ...cur, [opIndex]: v }))
  }

  // Accept / Reject commit to the server FIRST, then flip the
  // local decision on success. The hunk keeps showing its diff
  // (with a spinner on the busy button) during the await — no
  // optimistic flash that snaps back on failure. Errors land in
  // `opErrors[opIndex]` which the hunk renders in place of the
  // Accept / Reject buttons, keeping the diff itself intact so
  // the user sees the change AND the reason it couldn't land.
  const setDecision = (opIndex: number, d: Decision) => {
    setDecisions((cur) => ({ ...cur, [opIndex]: d }))
  }
  const clearOpError = (opIndex: number) => {
    setOpErrors((cur) => {
      if (!(opIndex in cur)) return cur
      const next = { ...cur }
      delete next[opIndex]
      return next
    })
  }

  const handleApplyOp = async (opIndex: number) => {
    setOpBusy(opIndex, 'applying')
    clearOpError(opIndex)
    try {
      await api.applyChatEditOp(docId, messageId, opIndex)
      setDecision(opIndex, 'accepted')
      onDocChanged?.()
      onOpMutated?.()
    } catch (e) {
      const isStale =
        e instanceof ApiError && (e.body as { code?: string })?.code === 'pending_edits_stale'
      if (isStale) {
        // Server's pending-edit array no longer matches what we
        // previewed — re-fire the preview fetch so we render the
        // current truth instead of a forever-broken Retry.
        setLocalRefreshTick((t) => t + 1)
        onOpMutated?.()
      } else {
        setOpErrors((cur) => ({
          ...cur,
          [opIndex]: e instanceof ApiError ? e.message : String(e),
        }))
        onOpMutated?.()
      }
    } finally {
      setOpBusy(opIndex, null)
    }
  }

  const handleDiscardOp = async (opIndex: number) => {
    setOpBusy(opIndex, 'discarding')
    clearOpError(opIndex)
    try {
      await api.discardChatEditOp(docId, messageId, opIndex)
      setDecision(opIndex, 'rejected')
      onOpMutated?.()
    } catch (e) {
      setOpErrors((cur) => ({
        ...cur,
        [opIndex]: e instanceof ApiError ? e.message : String(e),
      }))
    } finally {
      setOpBusy(opIndex, null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div
        className="sticky top-0 z-10 px-3 h-11 flex items-center gap-3 border-b shrink-0"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0"
          onClick={onExit}
          title="Return to current view (Esc)"
          aria-label="Return to current view"
        >
          <ChevronLeft size={13} />
        </button>
        <div className="text-[12.5px] text-fg flex-1 min-w-0 truncate">
          <span className="text-subtle">
            {opInfos
              ? `Previewing ${opInfos.length} proposed edit${opInfos.length === 1 ? '' : 's'}`
              : 'Previewing proposed edit'}
          </span>
        </div>
        {stats && (
          <div className="text-[12px] font-semibold flex items-center gap-2 whitespace-nowrap tabular-nums">
            <span style={{ color: '#00875A' }}>+{stats.added}</span>
            <span style={{ color: 'var(--danger-fg)' }}>−{stats.removed}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-10 py-10">
        {!data && !error && (
          <div className="text-[12px] text-subtle flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" /> Computing preview…
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
        {segments && segments.length === 0 && (
          <div className="text-[12px] text-subtle">
            No textual changes proposed.
          </div>
        )}
        {segments && segments.length > 0 && (
          <article className="md">
            {segments.map((seg, i) =>
              seg.kind === 'unchanged' ? (
                <UnchangedSegment
                  key={`u${i}`}
                  text={seg.text}
                  parentDir={parentDir}
                  callerOpts={callerOpts}
                />
              ) : (
                <HunkSegment
                  key={`h${seg.info.opIndex}`}
                  info={seg.info}
                  parentDir={parentDir}
                  callerOpts={callerOpts}
                  busy={busy[seg.info.opIndex] ?? null}
                  decision={decisions[seg.info.opIndex] ?? 'pending'}
                  opError={opErrors[seg.info.opIndex] ?? null}
                  onApply={() => handleApplyOp(seg.info.opIndex)}
                  onDiscard={() => handleDiscardOp(seg.info.opIndex)}
                />
              ),
            )}
          </article>
        )}
      </div>
    </div>
  )
}

type Segment =
  | { kind: 'unchanged'; text: string }
  | { kind: 'hunk'; info: OpInfo }

/** Reconstruct the "after" slice that replaces the hunk's range
 *  on Accept. Walks the diff in order, tracking which current-text
 *  line we'd be on, and collects the lines that the post-op text
 *  contains within (or anchored to) the hunk's range — that's
 *  eq lines whose current-line falls in [startLine, endLine) plus
 *  all ins lines anchored to a position in or at the hunk edge.
 *  Edge case: for pure deletions afterText is empty (correct —
 *  the hunk area would be removed). */
function reconstructAfter(diff: DiffOp[], startLine: number, endLine: number): string {
  const out: string[] = []
  let curLine = 0
  for (const op of diff) {
    if (op.kind === 'eq') {
      if (curLine >= startLine && curLine < endLine) out.push(op.line)
      curLine++
    } else if (op.kind === 'del') {
      // Skip del lines — they're being removed.
      curLine++
    } else {
      // ins is anchored at curLine. Include when at or inside the
      // hunk's range (inclusive of endLine so insertions at the
      // boundary land).
      if (curLine >= startLine && curLine <= endLine) out.push(op.line)
    }
  }
  return out.join('\n')
}

const mdComponents = (
  parentDir: string,
  callerOpts?: { owner?: string; password?: string },
) => ({
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
})

function UnchangedSegment({
  text,
  parentDir,
  callerOpts,
}: {
  text: string
  parentDir: string
  callerOpts?: { owner?: string; password?: string }
}) {
  // Empty segment guard — splitting can produce a stray '' for
  // ranges that abut a hunk; ReactMarkdown on empty input is fine
  // but emits an unnecessary node. Skip.
  if (!text.trim()) return null
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSlug, rehypeHighlight]}
      components={mdComponents(parentDir, callerOpts)}
    >
      {text}
    </ReactMarkdown>
  )
}

function HunkSegment({
  info,
  parentDir,
  callerOpts,
  busy,
  decision,
  opError,
  onApply,
  onDiscard,
}: {
  info: OpInfo
  parentDir: string
  callerOpts?: { owner?: string; password?: string }
  busy: 'applying' | 'discarding' | null
  decision: Decision
  opError: string | null
  onApply: () => void
  onDiscard: () => void
}) {
  // Resolved decisions render as plain markdown inline (no diff
  // highlights, no buttons). Accept → the new content; Reject →
  // the original content (what was there before the model proposed
  // a change).
  if (decision === 'accepted') {
    return (
      <UnchangedSegment
        text={info.afterText}
        parentDir={parentDir}
        callerOpts={callerOpts}
      />
    )
  }
  if (decision === 'rejected') {
    return (
      <UnchangedSegment
        text={info.beforeText}
        parentDir={parentDir}
        callerOpts={callerOpts}
      />
    )
  }
  if (info.error) {
    return (
      <div
        className="my-3 px-3 py-2 rounded text-[12px]"
        style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
      >
        Couldn't preview this edit: {info.error}
      </div>
    )
  }
  // Coalesce diff ops into chunks for rendering. Same approach
  // VersionDiffView uses: each run of eq/ins/del becomes one
  // ReactMarkdown block with a left-bar tint.
  const chunks: Array<{ kind: 'eq' | 'ins' | 'del'; text: string }> = []
  let buf: string[] = []
  let cur: 'eq' | 'ins' | 'del' | null = null
  const flush = () => {
    if (cur && buf.length > 0) chunks.push({ kind: cur, text: buf.join('\n') })
    buf = []
  }
  for (const op of info.diff) {
    if (op.kind !== cur) {
      flush()
      cur = op.kind
    }
    buf.push(op.line)
  }
  flush()
  // No outer hunk border — each DiffChunk paints its own colored
  // left-bar (accent for ins, danger for del). An additional 3-px
  // hunk-wide bar on top of those produces a stacked "railroad"
  // look that the user flagged. The buttons + the `my-4` spacing
  // are enough visual scoping.
  return (
    <div className="my-4 relative">
      {/* Per-hunk Accept / Reject (Cursor style). Both buttons read
          as quiet text-affordances against transparent backgrounds.
          The accent / danger color of the text plus the leading icon
          carries the intent — no heavy shadow / outline competing
          with the diff highlight bars on the left. */}
      <div className="absolute -top-0.5 right-0 flex items-center gap-1 z-10">
        {opError ? (
          // Error swap-in: Accept / Reject get replaced with the
          // failure reason + a Retry that re-fires Accept. The diff
          // below stays visible so the user sees both the change and
          // why it couldn't land.
          <div className="flex items-center gap-1.5">
            <div
              className="text-[11px] font-medium px-2 py-0.5 rounded leading-snug whitespace-normal break-words"
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger-fg)',
                border: '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
              }}
              title={opError}
            >
              {opError}
            </div>
            <HunkButton
              icon={busy === 'applying' ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
              label={busy === 'applying' ? 'Retrying' : 'Retry'}
              color="var(--accent)"
              onClick={onApply}
              disabled={busy != null}
              title="Try applying this edit again"
            />
          </div>
        ) : (
          <>
            <HunkButton
              icon={busy === 'applying' ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
              label={busy === 'applying' ? 'Applying' : 'Accept'}
              color="var(--accent)"
              onClick={onApply}
              disabled={busy != null}
              title="Apply just this edit"
            />
            <HunkButton
              icon={busy === 'discarding' ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
              label={busy === 'discarding' ? 'Rejecting' : 'Reject'}
              color="var(--danger-fg)"
              onClick={onDiscard}
              disabled={busy != null}
              title="Discard just this edit"
            />
          </>
        )}
      </div>
      <div className="pt-7">
        {chunks.filter((c) => c.kind !== 'eq').map((g, i) => (
          <DiffChunk
            key={i}
            kind={g.kind as 'ins' | 'del'}
            text={g.text}
            parentDir={parentDir}
            callerOpts={callerOpts}
          />
        ))}
      </div>
    </div>
  )
}

function HunkButton({
  icon,
  label,
  color,
  onClick,
  disabled,
  title,
}: {
  icon: React.ReactNode
  label: string
  color: string
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-6 px-1.5 inline-flex items-center justify-center gap-1 rounded text-[11px] font-medium transition-colors disabled:opacity-40"
      style={{ color, background: 'transparent' }}
      onMouseEnter={(e) => {
        if (!disabled) {
          ;(e.currentTarget as HTMLButtonElement).style.background = `color-mix(in srgb, ${color} 12%, transparent)`
        }
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function DiffChunk({
  kind,
  text,
  parentDir,
  callerOpts,
}: {
  kind: 'ins' | 'del'
  text: string
  parentDir: string
  callerOpts?: { owner?: string; password?: string }
}) {
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
        components={mdComponents(parentDir, callerOpts)}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
