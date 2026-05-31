import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Clock,
  Link as LinkIcon,
  List,
  Loader2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Quote,
  Trash2,
  Users,
} from 'lucide-react'
import { ApiError, api, type CommentDTO } from '../lib/api'
import { computeLineDiffCounts } from '../lib/lineDiff'
import { peerInitial, usePeers } from './AwarenessPill'

type Version = {
  ts: number
  sha256: string
  bytes: number
  title?: string
  hasText: boolean
}

type Heading = {
  level: number
  slug: string
  text: string
}

type Props = {
  path: string
  text: string | null
  headings: Heading[]
  hasOutlineList: boolean
  outlineOpen: boolean
  setOutlineOpen: (v: boolean) => void
  versionsOpen: boolean
  setVersionsOpen: (v: boolean) => void
  jumpTo: (slug: string) => void
  /** When set, this row's diff is currently being shown inline
   *  in the main viewer — DocRail highlights it as the active
   *  selection. */
  activeDiffTs?: number | null
  /** Tells the parent (PathViewer) to swap the main content
   *  area to an inline diff against this version's snapshot. */
  onPickVersion?: (ts: number) => void
  /** Bumped by the parent to force the version list to refetch —
   *  used after a restore so the just-created pre-restore snapshot
   *  shows up in the rail without a page reload. */
  versionsReloadKey?: number
  /** Optional Y.Doc awareness — when present, the rail surfaces a
   *  "Peers" section below the Clock icon (icon-strip mode) and an
   *  inline panel in the expanded aside (sidebar mode). */
  awareness?: import('y-protocols/awareness').Awareness | null
  peersOpen?: boolean
  setPeersOpen?: (v: boolean) => void
  /** Owner hint for cross-user reads. When the rail is rendered for
   *  a shared editor opening someone else's doc, the version list
   *  endpoints need the owner to scope the lookup (same storageKey
   *  can exist under multiple owners). Omitted = own doc. */
  ownerOpt?: string | null
  /** Comment thread for the open doc — owned by PathViewer so the
   *  floating "+ Comment" button can push new rows into the same
   *  store the rail reads from, no double round-trip. */
  comments?: CommentDTO[]
  commentsOpen?: boolean
  setCommentsOpen?: (v: boolean) => void
  /** Click a comment row → parent scrolls/highlights the anchor. */
  onScrollToComment?: (c: CommentDTO) => void
  /** Delete (author-or-admin) — parent handles auth + refresh. */
  onDeleteComment?: (c: CommentDTO) => void | Promise<void>
  /** Toggle resolved flag. Anyone with read access can flip this. */
  onResolveComment?: (c: CommentDTO, resolved: boolean) => void | Promise<void>
  /** Copy a deep-link to this comment to the clipboard. */
  onCopyCommentLink?: (c: CommentDTO) => void | Promise<void>
  /** Signed-in user — used to show the trash affordance only on the
   *  caller's own rows (admins can still delete; the server enforces
   *  the actual permission). */
  currentUsername?: string | null
  /** Comment whose row should be flashed + scrolled into view in the
   *  rail. Set by the parent when the user clicks an in-doc
   *  highlight; cleared on a timer so the flash auto-fades. */
  focusedCommentId?: string | null
}

/**
 * Single right-side rail that hosts both the Outline and Versions
 * sections in one column.
 *
 *   • Both sections collapsed → 32-px narrow strip with two
 *     stacked icons (List + Clock). Clicking either icon opens
 *     that section without disturbing the other.
 *   • Either section open → 240-px wide column rendering header
 *     bars for both sections. Each header has its own collapse
 *     toggle, so the user can independently hide either body
 *     without leaving the rail.
 *
 * Versions list is fetched on mount; the rail (and the section)
 * hide themselves entirely if there are no saved versions.
 */
export function DocRail({
  path,
  text,
  headings,
  hasOutlineList,
  outlineOpen,
  setOutlineOpen,
  versionsOpen,
  setVersionsOpen,
  jumpTo,
  activeDiffTs,
  onPickVersion,
  versionsReloadKey,
  awareness,
  peersOpen = false,
  setPeersOpen,
  ownerOpt,
  comments,
  commentsOpen = false,
  setCommentsOpen,
  onScrollToComment,
  onDeleteComment,
  onResolveComment,
  onCopyCommentLink,
  currentUsername,
  focusedCommentId,
}: Props) {
  const focusedRowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (!focusedCommentId) return
    // Defer to next frame so the list has rendered the row.
    const id = focusedCommentId
    const raf = requestAnimationFrame(() => {
      const el = focusedRowRef.current
      if (el && el.dataset.commentId === id) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [focusedCommentId])
  // Track which comment's link was just copied so we can flip
  // the link icon to a check briefly — gives the user explicit
  // visual confirmation that the click did something.
  const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null)
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  /** Per-version line-delta vs the chronologically older snapshot.
   *  Populated lazily by a background job once `versions` lands so
   *  the row renders an at-a-glance "+5 −2 lines" hint without
   *  waiting for the user to click into the diff modal. */
  const [deltaByTs, setDeltaByTs] = useState<Map<number, { added: number; removed: number }>>(
    new Map(),
  )

  // Stale-while-revalidate refetch. We only blank the list when
  // the user navigates to a different doc (or owner) — purely a
  // reload-key bump (after the user makes an edit) keeps the
  // existing list visible while the new one is fetched in the
  // background. Without this, every save flashed the list to its
  // loading skeleton and felt glitchy.
  const lastFetchKeyRef = useRef<string>('')
  useEffect(() => {
    let cancelled = false
    const docKey = `${path}::${ownerOpt ?? ''}`
    const isDocChange = lastFetchKeyRef.current !== docKey
    lastFetchKeyRef.current = docKey
    if (isDocChange) {
      // Different doc — old data isn't relevant. Clear so we don't
      // flash someone else's history for half a second.
      setVersions(null)
      setVersionsError(null)
      setDeltaByTs(new Map())
    }
    api
      .fileVersions(path, { owner: ownerOpt ?? undefined })
      .then((r) => {
        if (!cancelled) setVersions(r.versions)
      })
      .catch((e) => {
        if (!cancelled) setVersionsError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, versionsReloadKey, ownerOpt])

  // No grouping. Every snapshot is its own row — what you see in
  // the rail is exactly what's on disk. Display is newest-first so
  // index 0 is the latest snapshot.
  const rows = useMemo<RowVersion[]>(() => {
    if (!versions) return []
    return versions.map((v, i) => ({
      ts: v.ts,
      sha256: v.sha256,
      bytes: v.bytes,
      isLatest: i === 0,
    }))
  }, [versions])

  // Per-row delta = per-edit isolation (this snapshot → next
  // snapshot, or current for the latest). Each row shows ONLY the
  // changes introduced by its own edit, so the section that was
  // removed at 15:03 shows up only on 15:03's row — not on every
  // earlier row that happened to also contain it.
  useEffect(() => {
    if (rows.length === 0) return
    if (!versionsOpen) return
    if (text === null) return
    let cancelled = false
    const FETCH_LIMIT = 30
    const slice = rows.slice(0, FETCH_LIMIT)
    Promise.all(
      slice.map((v) =>
        api
          .fileVersionText(path, v.ts, { owner: ownerOpt ?? undefined })
          .then((r) => [v.ts, r.text ?? ''] as const)
          .catch(() => [v.ts, ''] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return
      const textByTs = new Map<number, string>(pairs)
      const map = new Map<number, { added: number; removed: number }>()
      for (let i = 0; i < slice.length; i++) {
        const v = slice[i]
        const snapText = textByTs.get(v.ts) ?? ''
        // Right side: the NEXT more recent snapshot's text (since
        // rows is desc, slice[i-1] is newer). For the latest row
        // (i === 0), compare to the live doc text.
        const afterText =
          i === 0 ? text : textByTs.get(slice[i - 1].ts) ?? ''
        if (!snapText && !afterText) continue
        map.set(v.ts, computeLineDiffCounts(snapText, afterText))
      }
      setDeltaByTs(map)
    })
    return () => {
      cancelled = true
    }
  }, [rows, versionsOpen, path, text, ownerOpt])

  const hasVersions = (versions?.length ?? 0) > 0 || !!versionsError
  // Mirror the versions auto-hide: when the doc has no headings to
  // outline, skip the Outline section entirely. Without this an
  // empty doc would still show a rail icon that opens an empty pane.
  const peers = usePeers(awareness ?? null)
  const hasPeers = peers.length > 0
  // Comments icon always shows when the parent passes a comments
  // array (even an empty one) — the rail is the only place to open
  // the panel + see history, so hiding the entry point when count=0
  // would also hide the route to past resolved threads.
  const hasComments = Array.isArray(comments)
  const eitherOpen =
    (outlineOpen && hasOutlineList) ||
    (versionsOpen && hasVersions) ||
    (peersOpen && hasPeers) ||
    (commentsOpen && hasComments)

  // Even without outline or versions, the rail still surfaces the
  // co-editing peers / comments sections — so it's only fully empty
  // if every track is unavailable.
  if (!hasOutlineList && !hasVersions && !hasPeers && !hasComments) return null
  const commentCount = comments?.length ?? 0
  const openCommentCount = comments?.filter((c) => !c.resolved).length ?? 0

  return (
    <>
      {!eitherOpen ? (
        <div
          className="w-8 shrink-0 border-l flex flex-col items-stretch"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          {hasOutlineList && (
            <RailIconButton
              label="Expand outline"
              icon={<List size={12} />}
              onClick={() => {
                // Mutually exclusive across all three sections.
                setVersionsOpen(false)
                setPeersOpen?.(false)
                setOutlineOpen(true)
              }}
            />
          )}
          {hasVersions && (
            <RailIconButton
              label="Expand versions"
              icon={<Clock size={12} />}
              onClick={() => {
                setOutlineOpen(false)
                setPeersOpen?.(false)
                setVersionsOpen(true)
              }}
            />
          )}
          {hasPeers && (
            <RailIconButton
              label={`Peers · ${peers.length}`}
              icon={
                <span className="relative inline-flex">
                  <Users size={12} />
                  <span
                    className="absolute -top-1 -right-1.5 inline-flex items-center justify-center text-[8.5px] font-semibold rounded-full leading-none"
                    style={{
                      background: 'var(--accent)',
                      color: 'white',
                      minWidth: 10,
                      height: 10,
                      padding: '0 2px',
                    }}
                  >
                    {peers.length}
                  </span>
                </span>
              }
              onClick={() => {
                setOutlineOpen(false)
                setVersionsOpen(false)
                setCommentsOpen?.(false)
                setPeersOpen?.(true)
              }}
            />
          )}
          {hasComments && (
            <RailIconButton
              label={
                openCommentCount > 0
                  ? `Comments · ${openCommentCount} open`
                  : commentCount > 0
                    ? `Comments · ${commentCount} resolved`
                    : 'Comments'
              }
              icon={
                <span className="relative inline-flex">
                  <MessageSquare size={12} />
                  {openCommentCount > 0 && (
                    <span
                      className="absolute -top-1 -right-1.5 inline-flex items-center justify-center text-[8.5px] font-semibold rounded-full leading-none"
                      style={{
                        background: 'var(--accent)',
                        color: 'white',
                        minWidth: 10,
                        height: 10,
                        padding: '0 2px',
                      }}
                    >
                      {openCommentCount}
                    </span>
                  )}
                </span>
              }
              onClick={() => {
                setOutlineOpen(false)
                setVersionsOpen(false)
                setPeersOpen?.(false)
                setCommentsOpen?.(true)
              }}
            />
          )}
        </div>
      ) : (
        <aside
          className="w-[300px] shrink-0 border-l overflow-y-auto"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          {outlineOpen && hasOutlineList && (
            <>
              <SectionHeader
                icon={<List size={11} />}
                label="Outline"
                open={true}
                onToggle={() => setOutlineOpen(false)}
              />
              {hasOutlineList && (
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
              )}
            </>
          )}
          {versionsOpen && hasVersions && (
            <>
              <SectionHeader
                icon={<Clock size={11} />}
                label="Versions"
                count={versions?.length ?? undefined}
                open={true}
                onToggle={() => setVersionsOpen(false)}
              />
              <div className="px-2 py-2">
                  {versions === null && !versionsError && (
                    <div className="px-2 py-1.5 text-[11.5px] text-subtle flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" /> Loading…
                    </div>
                  )}
                  {versionsError && (
                    <div
                      className="px-2 py-1.5 text-[11px] rounded"
                      style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
                    >
                      {versionsError}
                    </div>
                  )}
                  {(() => {
                    if (!versions) return null
                    // No collapsing — each snapshot is its own row.
                    // Grouped only by calendar day for visual scan.
                    return groupedByDay(rows).map((group) => (
                      <div key={group.dayKey} className="mb-2">
                        <div className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider font-semibold text-subtle">
                          {group.dayLabel}
                        </div>
                        {group.items.map((v) => (
                          <button
                            key={v.ts}
                            onClick={() => {
                              if (text === null) return
                              onPickVersion?.(v.ts)
                            }}
                            disabled={text === null}
                            className="block w-full text-left px-2 py-2 mb-0.5 rounded text-[12px] hover:bg-hover transition-colors text-fg disabled:opacity-50 disabled:hover:bg-transparent"
                            style={
                              activeDiffTs === v.ts
                                ? { background: 'var(--selected)', color: 'var(--accent)' }
                                : undefined
                            }
                            title={
                              text === null
                                ? 'Loading doc…'
                                : `Show diff — ${new Date(v.ts).toLocaleString()}`
                            }
                          >
                            <div className="flex items-center gap-1.5 leading-tight">
                              <span className="text-[12px] font-medium tabular-nums">
                                {formatRowTime(v.ts)}
                              </span>
                              {v.isLatest && (
                                <span
                                  className="text-[12px] leading-none font-semibold"
                                  style={{ color: 'var(--accent)' }}
                                  aria-label="Latest snapshot"
                                  title="Latest snapshot"
                                >
                                  *
                                </span>
                              )}
                            </div>
                            <div className="text-[10.5px] mt-1 leading-tight flex items-center gap-1.5 text-subtle">
                              <span>{formatRelative(v.ts)}</span>
                              <span>·</span>
                              <span>{formatBytes(v.bytes)}</span>
                              {(() => {
                                const d = deltaByTs.get(v.ts)
                                if (!d) return null
                                if (d.added === 0 && d.removed === 0) {
                                  return <span className="ml-auto">no line change</span>
                                }
                                return (
                                  <span className="ml-auto inline-flex items-baseline gap-1">
                                    {d.added > 0 && (
                                      <span style={{ color: '#00875A' }}>+{d.added}</span>
                                    )}
                                    {d.removed > 0 && (
                                      <span style={{ color: 'var(--danger-fg)' }}>
                                        −{d.removed}
                                      </span>
                                    )}
                                  </span>
                                )
                              })()}
                            </div>
                          </button>
                        ))}
                      </div>
                    ))
                  })()}
              </div>
            </>
          )}
          {peersOpen && hasPeers && (
            <>
              <SectionHeader
                icon={<Users size={11} />}
                label="Peers"
                count={peers.length}
                open={true}
                onToggle={() => setPeersOpen?.(false)}
              />
              <ul
                className="divide-y"
                style={{ borderColor: 'var(--border)' }}
              >
                {peers.map((p) => (
                  <li
                    key={p.clientId}
                    className="flex items-center gap-2 px-3 py-2 text-[12px]"
                  >
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold text-white shrink-0"
                      style={{ background: p.color }}
                    >
                      {peerInitial(p.name)}
                    </span>
                    <span className="text-fg truncate flex-1">{p.name}</span>
                  </li>
                ))}
              </ul>
              <div
                className="px-3 py-2 text-[10.5px]"
                style={{
                  color: 'var(--fg-subtle)',
                  borderTop: '1px solid var(--border)',
                }}
              >
                Their cursors are coloured inline in the editor — open
                Edit mode to see live caret + selection.
              </div>
            </>
          )}
          {commentsOpen && hasComments && (
            <>
              <SectionHeader
                icon={<MessageSquare size={11} />}
                label="Comments"
                count={commentCount || undefined}
                open={true}
                onToggle={() => setCommentsOpen?.(false)}
              />
              {commentCount === 0 ? (
                <div
                  className="px-3 py-3 text-[11.5px]"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  Select text in the doc and use the floating
                  <span
                    className="mx-1 inline-flex items-center"
                    style={{ color: 'var(--accent)' }}
                  >
                    Comment
                  </span>
                  button to start a thread.
                </div>
              ) : (
                <ul className="py-1">
                  {comments!.map((c, idx) => {
                    const mine = !!currentUsername && c.author === currentUsername
                    const focused = focusedCommentId === c.id
                    const isLast = idx === comments!.length - 1
                    return (
                      <li
                        key={c.id}
                        ref={focused ? focusedRowRef : undefined}
                        data-comment-id={c.id}
                        className="group px-3 py-3 text-[12px] transition-colors cursor-pointer hover:bg-[var(--hover)]"
                        style={{
                          opacity: c.resolved ? 0.55 : 1,
                          background: focused
                            ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
                            : undefined,
                          // Hair-thin divider in the theme's own
                          // border color — not the Tailwind divide-y
                          // default that was reading as harsh white
                          // in dark mode.
                          borderBottom: isLast
                            ? 'none'
                            : '1px solid var(--border)',
                        }}
                        // Whole-row click jumps to the doc anchor.
                        // Trash/Resolve buttons stop propagation so
                        // they don't also fire this.
                        onClick={() => onScrollToComment?.(c)}
                        title="Jump to comment anchor"
                      >
                        <div>
                          <div
                            className="flex items-center gap-1.5 mb-1.5 text-[11.5px]"
                            style={{ color: 'var(--fg-subtle)' }}
                          >
                            <Quote size={10} className="shrink-0" />
                            <span
                              className="flex-1 min-w-0 truncate italic"
                              title={c.quote}
                            >
                              {c.quote}
                            </span>
                          </div>
                          <div
                            className="whitespace-pre-wrap break-words leading-snug"
                            style={{
                              color: 'var(--fg)',
                              textDecoration: c.resolved ? 'line-through' : 'none',
                            }}
                          >
                            {c.text}
                          </div>
                        </div>
                        <div
                          className="mt-2 flex items-center gap-1.5 text-[10.5px] min-w-0"
                          style={{ color: 'var(--fg-subtle)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="truncate min-w-0">{c.author}</span>
                          <span aria-hidden className="shrink-0">·</span>
                          <span className="shrink-0 whitespace-nowrap">
                            {formatTimestamp(c.createdAt)}
                          </span>
                          <div className="flex-1" />
                          {/* Action group — trash, copy-link, resolve.
                              Fixed-width container so columns line up
                              across every row regardless of perms. */}
                          <div
                            className="shrink-0 flex items-center justify-end gap-1"
                            style={{ width: 78 }}
                          >
                            <button
                              type="button"
                              className="comment-action-btn h-6 w-6 rounded inline-flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed"
                              style={{
                                color: mine ? 'var(--danger-fg)' : 'var(--fg-subtle)',
                                opacity: mine ? 1 : 0.35,
                              }}
                              onClick={() => mine && void onDeleteComment?.(c)}
                              disabled={!mine}
                              title={
                                mine ? 'Delete comment' : 'Only the author can delete this'
                              }
                              aria-label="Delete comment"
                            >
                              <Trash2 size={11} />
                            </button>
                            <button
                              type="button"
                              className="comment-action-btn h-6 w-6 rounded inline-flex items-center justify-center transition-colors cursor-pointer"
                              style={{
                                color:
                                  copiedCommentId === c.id
                                    ? 'var(--accent)'
                                    : 'var(--fg-subtle)',
                              }}
                              onClick={async () => {
                                await onCopyCommentLink?.(c)
                                setCopiedCommentId(c.id)
                                window.setTimeout(() => {
                                  setCopiedCommentId((cur) =>
                                    cur === c.id ? null : cur,
                                  )
                                }, 1500)
                              }}
                              title={
                                copiedCommentId === c.id
                                  ? 'Link copied!'
                                  : 'Copy link to this comment'
                              }
                              aria-label="Copy comment link"
                            >
                              {copiedCommentId === c.id ? (
                                <Check size={11} />
                              ) : (
                                <LinkIcon size={11} />
                              )}
                            </button>
                            <button
                              type="button"
                              className="comment-action-btn h-6 w-6 rounded inline-flex items-center justify-center transition-colors cursor-pointer"
                              style={{
                                color: c.resolved ? 'var(--accent)' : 'var(--fg-subtle)',
                              }}
                              onClick={() =>
                                void onResolveComment?.(c, !c.resolved)
                              }
                              title={c.resolved ? 'Re-open this comment' : 'Mark resolved'}
                              aria-label={c.resolved ? 'Re-open' : 'Resolve'}
                            >
                              <Check size={12} />
                            </button>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </aside>
      )}
    </>
  )
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diffMin = Math.floor((now - ts) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}h ago`
  return d.toLocaleDateString()
}

function RailIconButton({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      className="h-11 w-full inline-flex items-center justify-center border-b transition-[background-color] hover:bg-hover"
      style={{ borderColor: 'var(--border)', color: 'var(--fg-subtle)' }}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  )
}

function SectionHeader({
  icon,
  label,
  count,
  open,
  onToggle,
}: {
  icon: React.ReactNode
  label: string
  count?: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <div
      className="sticky top-0 h-11 px-3 border-b text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex items-center gap-1.5"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {typeof count === 'number' && (
        <span className="text-[10.5px] text-subtle font-normal">{count}</span>
      )}
      <button
        className="btn-ghost h-6 w-6 px-0"
        onClick={onToggle}
        title={open ? `Collapse ${label.toLowerCase()}` : `Expand ${label.toLowerCase()}`}
        aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      >
        {open ? <PanelRightClose size={12} /> : <PanelRightOpen size={12} />}
      </button>
    </div>
  )
}

/** A version row in the rendered list — derived from the raw
 *  Version[] by collapsing identical consecutive sha256 runs and
 *  attaching the byte-delta vs the chronologically previous
 *  snapshot. */
type RowVersion = {
  ts: number
  sha256: string
  bytes: number
  isLatest: boolean
}

type DayGroup = { dayKey: string; dayLabel: string; items: RowVersion[] }

/** Group rows by local-calendar day. Day labels use friendly names
 *  for today/yesterday so the user scans the timeline by date,
 *  not by raw timestamps. */
function groupedByDay(rows: RowVersion[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const r of rows) {
    const d = new Date(r.ts)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const existing = groups[groups.length - 1]
    if (existing && existing.dayKey === dayKey) {
      existing.items.push(r)
    } else {
      groups.push({ dayKey, dayLabel: formatDayLabel(d), items: [r] })
    }
  }
  return groups
}

function formatDayLabel(d: Date): string {
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(d, now)) return 'Today'
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, yesterday)) return 'Yesterday'
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Per-row clock time — always HH:mm so adjacent versions are
 *  visually distinct even when they're on the same day. */
function formatRowTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Short "N min ago / N hr ago / N d ago" style for the secondary
 *  detail line. Falls back to a localized date for older entries
 *  so the user gets useful context regardless of age. */
function formatRelative(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  const s = Math.floor(delta / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Render a file-size in human units. Bytes for very small files,
 *  KB / MB beyond. Used in the version-list secondary line so the
 *  user gets a sense of the snapshot's heft at a glance. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

