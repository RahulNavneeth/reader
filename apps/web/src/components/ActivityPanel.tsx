import { useEffect, useMemo, useState } from 'react'
import {
  History,
  Loader2,
  UploadCloud,
  Pencil,
  Trash2,
  Undo2,
  Move,
  Globe,
  Lock,
  Tag as TagIcon,
  Sparkles,
  Users,
  HardDrive,
  Check,
  X,
  FileSearch,
  AlertCircle,
  Camera,
  Pin,
  PinOff,
  MessageSquare,
  Brain,
  ThumbsDown,
  type LucideIcon,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Entry = {
  ts: number
  actor: string
  action: string
  target?: string
  meta?: Record<string, any>
}

type GroupedRow = {
  /** First event in the cluster — used for icon / actor / detail. */
  head: Entry
  /** Number of merged repeats including head. 1 = no dedup. */
  count: number
  /** Last (most-recent) event in the cluster — drives the timestamp
   *  shown to the user so a long toggle burst surfaces "just now"
   *  rather than the minutes-old first event. */
  tail: Entry
}

const CLUSTER_WINDOW_MS = 5 * 60 * 1000 // ≤ 5 min merges into one row
/** Wider window for inherently-noisy state-flip actions (toggling
 *  visibility, repeated tag changes during a tweak session). Stops
 *  the same action repeating 5+ times in the panel just because the
 *  user was experimenting with a setting. */
const NOISY_CLUSTER_WINDOW_MS = 60 * 60 * 1000
const NOISY_ACTIONS = new Set([
  'vault.visibility',
  'vault.folder-visibility',
  'vault.bulk-visibility',
])
function clusterWindowFor(action: string): number {
  return NOISY_ACTIONS.has(action) ? NOISY_CLUSTER_WINDOW_MS : CLUSTER_WINDOW_MS
}

/**
 * Per-document activity feed. Reads /api/file/activity (or
 * /api/folder/activity) and renders a Notion-style timeline.
 *
 * Design notes:
 *   - Day-grouped sections (Today / Yesterday / specific dates) so a
 *     long log scans like a journal instead of a flat dump.
 *   - Dedup: same actor + same action within CLUSTER_WINDOW_MS
 *     collapses into one row with an "N times" counter. Fixes the
 *     "made this public / private" repeated 9 times problem from
 *     rapid toggling.
 *   - Category icons + accent strip per row carry the action type
 *     at a glance.
 *   - Each row shows: actor verb + meta detail + precise local time
 *     (HH:MM). The day header carries the date so per-row time is
 *     uncluttered.
 *   - Watcher-attributed edits drop the actor name (no "system
 *     edited") and read as self-contained sentences.
 *   - "via MCP" / "via Reader AI" tags surface the source channel
 *     so the user can see whether the change came from the UI, an
 *     agent, or an external tool touching the file on disk.
 */
export function ActivityPanel({
  path,
  kind = 'file',
  owner,
}: {
  path: string
  kind?: 'file' | 'folder'
  /** Owner hint for cross-user reads. Threaded to the audit
   *  endpoint so share recipients get their permitted activity
   *  instead of 403 (the server side resolves via the same
   *  resolveReadContext the other read endpoints use). */
  owner?: string
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterId>('all')

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setError(null)
    const fetcher =
      kind === 'folder'
        ? api.folderActivity(path)
        : api.fileActivity(path, 50, owner ? { owner } : undefined)
    fetcher
      .then((r) => {
        if (!cancelled) setEntries(r.entries)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, kind, owner])

  // Filter + dedup pipeline. Filter first so the dedup window doesn't
  // accidentally cluster two unrelated actions because the matching
  // event between them got removed by the filter.
  const dayGroups = useMemo(() => {
    if (!entries) return null
    const filtered = filter === 'all'
      ? entries
      : entries.filter((e) => categoryOf(e.action) === filter)
    // Group consecutive same-actor-same-action events within window.
    const rows: GroupedRow[] = []
    for (const e of filtered) {
      const last = rows[rows.length - 1]
      const sameCluster =
        last &&
        last.head.actor === e.actor &&
        last.head.action === e.action &&
        Math.abs(last.tail.ts - e.ts) <= clusterWindowFor(e.action)
      if (sameCluster) {
        last.count++
        // Audit feed is newest-first. The "tail" of a cluster
        // (chronologically older) keeps drifting backwards as we
        // absorb more entries.
        last.tail = e
      } else {
        rows.push({ head: e, count: 1, tail: e })
      }
    }
    // Now bucket by calendar day. We use the cluster head's
    // timestamp (most recent within the cluster) as the bucket key
    // so a cluster that bridges midnight files under the day the
    // user most recently touched it.
    type Bucket = { key: string; label: string; rows: GroupedRow[] }
    const buckets: Bucket[] = []
    const byKey = new Map<string, Bucket>()
    for (const r of rows) {
      const key = dayKey(r.head.ts)
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { key, label: dayLabel(r.head.ts), rows: [] }
        byKey.set(key, bucket)
        buckets.push(bucket)
      }
      bucket.rows.push(r)
    }
    return buckets
  }, [entries, filter])

  // Counts per category for the filter chips (only shown when there's
  // enough variety to be useful — single-category feeds skip them).
  const counts = useMemo(() => {
    if (!entries) return null
    const c: Record<FilterId, number> = {
      all: entries.length,
      edit: 0,
      ai: 0,
      share: 0,
      visibility: 0,
      tags: 0,
      lifecycle: 0,
    }
    for (const e of entries) {
      const cat = categoryOf(e.action)
      if (cat in c) c[cat as FilterId]++
    }
    return c
  }, [entries])

  return (
    <div>
      {entries == null && !error && (
        <div className="px-3 py-3 text-[11.5px] text-muted flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div
          className="mx-3 my-2 px-2 py-1.5 text-[11.5px] rounded flex items-start gap-1.5"
          style={{
            background: 'var(--danger-bg)',
            color: 'var(--danger-fg)',
            border: '1px solid color-mix(in srgb, var(--danger-fg) 20%, transparent)',
          }}
        >
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {entries && entries.length === 0 && (
        <div className="px-3 py-4 text-[11.5px] text-muted">
          No recorded activity for this {kind === 'folder' ? 'folder' : 'file'} yet.
        </div>
      )}
      {entries && entries.length > 0 && counts && (
        <FilterRow filter={filter} setFilter={setFilter} counts={counts} />
      )}
      {dayGroups?.map((bucket) => (
        <div key={bucket.key} className="py-1">
          <div
            className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--fg-subtle)' }}
          >
            {bucket.label}
          </div>
          <ul className="px-1.5 py-0.5">
            {bucket.rows.map((row, i) => (
              <ActivityRow key={i} row={row} />
            ))}
          </ul>
        </div>
      ))}
      {dayGroups && dayGroups.length === 0 && entries && entries.length > 0 && (
        <div className="px-3 py-4 text-[11.5px] text-muted">
          No activity matching this filter.
        </div>
      )}
    </div>
  )
}

// ── Filter chips ───────────────────────────────────────────────────

type FilterId = 'all' | 'edit' | 'ai' | 'share' | 'visibility' | 'tags' | 'lifecycle'

const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'edit', label: 'Edits' },
  { id: 'ai', label: 'Reader AI' },
  { id: 'share', label: 'Sharing' },
  { id: 'visibility', label: 'Visibility' },
  { id: 'tags', label: 'Tags' },
  { id: 'lifecycle', label: 'Lifecycle' },
]

function FilterRow({
  filter,
  setFilter,
  counts,
}: {
  filter: FilterId
  setFilter: (f: FilterId) => void
  counts: Record<FilterId, number>
}) {
  // Hide filters with 0 hits (except "All") so the row stays tight
  // on small feeds. A single-category file ends up with just [All].
  const visible = FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0)
  if (visible.length <= 1) return null
  return (
    <div
      className="flex flex-wrap gap-1 px-2.5 py-2 border-b sticky top-0 z-10"
      style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
    >
      {visible.map((f) => {
        const active = filter === f.id
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className="px-1.5 h-5 rounded text-[10.5px] font-medium inline-flex items-center transition-colors"
            title={`${f.label} · ${counts[f.id]} ${counts[f.id] === 1 ? 'event' : 'events'}`}
            style={{
              background: active ? 'var(--selected)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--fg-muted)',
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'var(--hover)'
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
          >
            {f.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Row rendering ──────────────────────────────────────────────────

function ActivityRow({ row }: { row: GroupedRow }) {
  const { head, count, tail } = row
  const Icon = iconFor(head.action, head.meta)
  const color = colorFor(head.action, head.meta)
  const isExternal =
    (head.meta as Record<string, unknown> | undefined)?.source === 'watcher' ||
    head.actor === 'system'
  const title = titleFor(head, count)
  const detail = detailFor(head)
  const source = sourceTag(head)
  // Title line carries the full "what + when". Detail line is only
  // shown when meta adds genuinely new info (a recipient, a tag list,
  // a byte delta) — pure state changes like visibility skip it so
  // the panel stays scannable instead of repeating itself.
  return (
    <li
      className="group flex items-center gap-2 px-2 py-1 rounded transition-colors"
      style={{ background: 'transparent' }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLLIElement).style.background = 'var(--hover)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLLIElement).style.background = 'transparent'
      }}
      title={`${clockTime(tail.ts)} · ${timeAgo(tail.ts)}${count > 1 ? ` · ×${count} over ${spanLabel(head.ts, tail.ts)}` : ''}`}
    >
      <div
        className="w-5 h-5 rounded-full inline-flex items-center justify-center shrink-0"
        style={{
          background: `color-mix(in srgb, ${color} 14%, transparent)`,
          color,
        }}
      >
        <Icon size={11} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] leading-tight flex items-baseline gap-1.5 min-w-0">
          <span className="min-w-0 truncate">
            {isExternal ? (
              <span className="text-fg">{title}</span>
            ) : (
              <>
                <span className="font-medium text-fg">{head.actor}</span>{' '}
                <span style={{ color: 'var(--fg-muted)' }}>{title}</span>
              </>
            )}
          </span>
          {count > 1 && (
            <span
              className="px-1 rounded text-[9.5px] font-semibold tabular-nums shrink-0"
              style={{ background: 'var(--hover)', color: 'var(--fg-subtle)' }}
            >
              ×{count}
            </span>
          )}
          {source && (
            <span
              className="px-1 rounded text-[9.5px] font-semibold shrink-0"
              style={{
                background: `color-mix(in srgb, ${color} 14%, transparent)`,
                color,
              }}
            >
              {source}
            </span>
          )}
        </div>
        {detail && (
          <div className="text-[11px] text-subtle mt-0.5 truncate" title={detail}>
            {detail}
          </div>
        )}
      </div>
      <span
        className="text-[10.5px] tabular-nums shrink-0"
        style={{ color: 'var(--fg-subtle)' }}
      >
        {clockTime(tail.ts)}
      </span>
    </li>
  )
}

// ── Phrasing & meta extraction ─────────────────────────────────────

/** Sentence-completion verb for an action, used after the actor
 *  name. e.g. `<actor> applied a Reader AI edit`. Pure prose; the
 *  meta detail line carries any quantitative info (line counts,
 *  recipient, etc.). */
function titleFor(e: Entry, count: number): string {
  const { action, meta } = e
  const isExternal = meta?.source === 'watcher' || e.actor === 'system'
  const m = meta as Record<string, any> | undefined

  if (isExternal) {
    switch (action) {
      case 'vault.upload':
        return 'Detected new file on disk'
      case 'vault.edit':
        return 'Edited on disk by an external tool'
      case 'vault.replace':
        return 'Replaced on disk by an external tool'
      case 'vault.folder-visibility':
        // Background sweep flipped the folder private because its
        // public link's TTL passed. Self-contained so the user
        // doesn't read "system made this folder private".
        if (m?.reason === 'public-link-expired') return 'Public link expired — folder reverted to private'
        return 'Visibility changed'
      case 'pin.remove':
        if (m?.reason === 'target-missing') return 'Auto-removed a pin whose target no longer exists'
        return 'Pin removed'
      case 'version.prune':
        if (typeof m?.prunedCount === 'number') {
          return `Pruned ${m.prunedCount} older snapshot${m.prunedCount === 1 ? '' : 's'} (cap ${m?.cap ?? '?'})`
        }
        return 'Pruned older snapshots'
    }
  }

  switch (action) {
    // ── Edits ────────────────────────────────────────────────────
    case 'vault.upload':
      return 'uploaded this'
    case 'vault.edit':
      return 'edited this'
    case 'vault.replace':
      return 'replaced the contents'
    case 'mcp.upload_text':
      return 'wrote this'

    // ── Reader AI ────────────────────────────────────────────────
    case 'chat.apply_edit':
      if (Array.isArray(m?.ops) && m.ops.length === 1) return `applied a Reader AI edit`
      if (Array.isArray(m?.ops)) return `applied ${m.ops.length} Reader AI edits`
      return 'applied Reader AI edits'
    case 'chat.apply_edit_op':
      return 'applied a Reader AI edit'
    case 'chat.discard_edit':
      return 'discarded Reader AI edit'
    case 'chat.discard_edit_op':
      return 'discarded one Reader AI edit'
    case 'chat.feedback':
      return 'flagged a Reader AI reply'
    case 'chat.thread.create':
      return count > 1 ? 'started new chats' : 'started a new chat'
    case 'chat.thread.rename':
      return 'renamed a chat'
    case 'chat.thread.delete':
      return 'deleted a chat'

    // ── Memory ───────────────────────────────────────────────────
    case 'memory.user.add':
      return 'taught Reader AI a fact about themselves'
    case 'memory.user.delete':
      return 'forgot a user fact'
    case 'memory.doc.add':
      return 'taught Reader AI a fact about this doc'
    case 'memory.doc.delete':
      return 'forgot a doc fact'

    // ── Pins ─────────────────────────────────────────────────────
    case 'pin.add':
      return 'pinned this'
    case 'pin.remove':
      return 'unpinned this'

    // ── Versions ─────────────────────────────────────────────────
    case 'version.snapshot':
      return 'snapshotted a version'
    case 'version.prune':
      // System-only; isExternal path uses this same string via the
      // external branch below for the "no actor" wording.
      return 'pruned old snapshots'

    // ── Visibility ───────────────────────────────────────────────
    case 'vault.visibility':
      if (count > 1) return 'toggled visibility'
      if (typeof m?.public === 'boolean') {
        return m.public ? 'made this public' : 'made this private'
      }
      return 'changed visibility'
    case 'vault.bulk-visibility':
      return 'changed visibility on a selection'
    case 'vault.folder-visibility':
      if (typeof m?.public === 'boolean') {
        return m.public ? 'made this folder public' : 'made this folder private'
      }
      return 'changed folder visibility'

    // ── Tags ─────────────────────────────────────────────────────
    case 'vault.tags':
      if (Array.isArray(m?.tags)) {
        if (m.tags.length === 0) return 'cleared all tags'
        return 'updated tags'
      }
      return 'updated tags'
    case 'vault.bulk-tags':
      if (Array.isArray(m?.add) && m.add.length > 0) return 'added a tag'
      if (Array.isArray(m?.remove) && m.remove.length > 0) return 'removed a tag'
      return 'updated tags'
    case 'vault.folder-tags':
      return 'updated folder tags'
    case 'mcp.set_tags':
      if (Array.isArray(m?.tags) && m.tags.length === 0) return 'cleared all tags'
      return 'updated tags'

    // ── Sharing ──────────────────────────────────────────────────
    case 'vault.share-with':
    case 'vault.share-with-file':
    case 'vault.share-with-folder':
      return 'shared this'
    case 'vault.share-revoke':
      return 'revoked sharing'

    // ── Lifecycle ────────────────────────────────────────────────
    case 'vault.move':
      return 'moved this'
    case 'vault.trash':
      return 'moved this to Trash'
    case 'vault.delete':
      return 'permanently deleted this'
    case 'trash.restore':
      return 'restored this from Trash'
    case 'trash.purge':
      return 'permanently purged this'
    case 'vault.bulk-trash':
      return `moved ${m?.count ?? 'several files'} to Trash`
    case 'vault.index':
      return 'indexed this for search'
    case 'vault.reindex':
      return 're-indexed this'

    default:
      // Best-effort fallback so a freshly-emitted action still
      // reads as English instead of a developer log entry.
      if (action.startsWith('mcp.')) return action.slice(4).replace(/_/g, ' ')
      if (action.startsWith('vault.')) return action.slice(6).replace(/[-_]/g, ' ')
      if (action.startsWith('chat.')) return action.slice(5).replace(/_/g, ' ')
      return action
  }
}

/** Second line under the row title — quantitative / contextual
 *  info pulled from meta. e.g. `+5 −2 lines · Risks section`,
 *  `with alice (read-only)`, `#urgent, #draft`, `12 KB`. */
function detailFor(e: Entry): string | null {
  const { action, meta } = e
  const m = meta as Record<string, any> | undefined
  if (!m) return null
  switch (action) {
    case 'vault.upload':
    case 'mcp.upload_text':
      return typeof m.bytes === 'number' ? formatBytes(m.bytes) : null
    case 'vault.edit':
    case 'vault.replace': {
      const parts: string[] = []
      if (typeof m.before_bytes === 'number' && typeof m.after_bytes === 'number') {
        const delta = m.after_bytes - m.before_bytes
        const sign = delta >= 0 ? '+' : '−'
        parts.push(`${formatBytes(m.after_bytes)} (${sign}${formatBytes(Math.abs(delta))})`)
      } else if (typeof m.bytes === 'number') {
        parts.push(formatBytes(m.bytes))
      }
      return parts.length ? parts.join(' · ') : null
    }
    case 'chat.apply_edit':
      if (Array.isArray(m.ops)) {
        return `${m.ops.length} edit${m.ops.length === 1 ? '' : 's'} · ${m.ops.join(', ')}`
      }
      return null
    case 'chat.apply_edit_op':
      if (typeof m.op === 'string') return `${humanizeOp(m.op)}`
      return null
    case 'chat.discard_edit_op':
      if (typeof m.op === 'string') return `${humanizeOp(m.op)}`
      return null
    // Visibility's resulting state is already in the verb ("made
    // this public" / "made this private"). Repeating "Anyone with
    // the link can view" on the detail line just bulks the row up
    // — skip it.
    case 'vault.visibility':
    case 'vault.folder-visibility':
      return null
    case 'vault.tags':
    case 'mcp.set_tags':
      if (Array.isArray(m.tags) && m.tags.length > 0) return formatTagList(m.tags)
      return null
    case 'vault.bulk-tags':
      if (Array.isArray(m.add) && m.add.length > 0) return `Added: ${formatTagList(m.add)}`
      if (Array.isArray(m.remove) && m.remove.length > 0) return `Removed: ${formatTagList(m.remove)}`
      return null
    case 'vault.folder-tags':
      if (Array.isArray(m.tags) && m.tags.length > 0) return formatTagList(m.tags)
      return null
    case 'vault.share-with':
    case 'vault.share-with-file':
      if (typeof m.recipient === 'string') {
        const role = m.canEdit ? 'edit' : 'read-only'
        return m.cascadedFrom
          ? `with ${m.recipient} (${role}) · via folder ${m.cascadedFrom}`
          : `with ${m.recipient} (${role})`
      }
      return null
    case 'vault.share-with-folder':
      if (typeof m.recipient === 'string') {
        const role = m.canEdit ? 'edit' : 'read-only'
        return `Folder · with ${m.recipient} (${role})`
      }
      return null
    case 'vault.share-revoke':
      if (typeof m.recipient === 'string') return `from ${m.recipient}`
      return null
    case 'vault.move':
      if (typeof m.from === 'string' && typeof m.to === 'string') return `${m.from} → ${m.to}`
      return null
    // Memory previews — show the first ~80 chars so the user can
    // see what was memorized without opening the AI Memories tray.
    case 'memory.user.add':
    case 'memory.doc.add':
      if (typeof m.preview === 'string') return `"${m.preview}"`
      return null
    case 'chat.thread.create':
    case 'chat.thread.rename':
      if (typeof m.title === 'string') return m.title
      return null
    case 'pin.add':
      if (typeof m.label === 'string') return m.label
      return null
    case 'version.snapshot':
      if (typeof m.bytes === 'number') {
        const reason = typeof m.reason === 'string' ? ` · ${m.reason}` : ''
        return `${formatBytes(m.bytes)}${reason}`
      }
      return null
    case 'version.prune':
      if (typeof m.prunedCount === 'number' && typeof m.keptCount === 'number') {
        return `Kept ${m.keptCount} · removed ${m.prunedCount}`
      }
      return null
    default:
      return null
  }
}

function humanizeOp(op: string): string {
  switch (op) {
    case 'replace_section':
      return 'replaced a section'
    case 'insert_after':
      return 'inserted after a section'
    case 'delete_section':
      return 'deleted a section'
    case 'append_text':
      return 'appended text'
    case 'prepend_text':
      return 'prepended text'
    default:
      return op.replace(/_/g, ' ')
  }
}

/** Trailing source tag (small pill) — surfaces "via MCP",
 *  "via Reader AI", "from disk" so the user can see at a glance
 *  which channel produced the change. Returns null when the action
 *  is plain UI activity. */
function sourceTag(e: Entry): string | null {
  // Snapshot rows carry their own attribution via meta.source so
  // the user can see WHO triggered the version (watcher vs Reader
  // AI vs MCP vs manual write).
  if (e.action === 'version.snapshot') {
    if (e.meta?.source === 'reader-ai') return 'Reader AI'
    if (e.meta?.source === 'mcp') return 'MCP'
    if (e.meta?.source === 'watcher') return 'disk'
    return 'snapshot'
  }
  // System-driven sweeps (TTL expiry, pruning, auto-cleanup) get a
  // "system" pill so they're visually distinct from user actions.
  if (e.meta?.source === 'auto-expire') return 'system'
  if (e.meta?.source === 'auto-cleanup') return 'system'
  if (e.meta?.source === 'watcher') return 'disk'
  if (e.action.startsWith('mcp.')) return 'MCP'
  if (e.action.startsWith('chat.')) return 'Reader AI'
  if (e.action.startsWith('memory.')) return 'Memory'
  return null
}

// ── Categories (filter chips + colors) ─────────────────────────────

function categoryOf(action: string): FilterId {
  if (action.startsWith('chat.') || action.startsWith('memory.')) return 'ai'
  if (action.includes('share')) return 'share'
  if (action.includes('visibility')) return 'visibility'
  if (action.includes('tag')) return 'tags'
  if (
    action.includes('edit') ||
    action.includes('replace') ||
    action === 'vault.upload' ||
    action === 'mcp.upload_text' ||
    action === 'version.snapshot'
  ) {
    return 'edit'
  }
  return 'lifecycle'
}

function colorFor(action: string, meta?: Record<string, any>): string {
  if (action === 'version.snapshot') {
    // Mirror the snapshot's trigger: AI-driven snapshots share the
    // accent color with chat.apply_edit so the timeline reads as
    // one coherent "Reader AI edited + snapshotted" cluster.
    if (meta?.source === 'reader-ai') return 'var(--accent)'
    if (meta?.source === 'mcp') return 'var(--accent)'
    return '#8B5CF6'
  }
  if (meta?.source === 'watcher') return '#8B5CF6' // violet — external/disk
  if (action.startsWith('chat.') || action.startsWith('memory.')) return 'var(--accent)' // AI flows
  if (action === 'pin.add' || action === 'pin.remove') return '#F59E0B'
  if (action.includes('share')) return '#0EA5E9' // sky — sharing/collab
  if (action.includes('visibility')) return '#10B981' // green — privacy state
  if (action.includes('tag')) return '#F59E0B' // amber — taxonomy
  if (action.includes('trash') || action.includes('delete') || action.includes('purge')) {
    return 'var(--danger-fg)'
  }
  if (action.includes('restore')) return '#10B981'
  if (action.includes('move')) return '#6366F1'
  if (action.includes('edit') || action.includes('replace')) return 'var(--fg-muted)'
  if (action.includes('upload')) return 'var(--fg-muted)'
  if (action.includes('index')) return 'var(--accent)'
  return 'var(--fg-muted)'
}

function iconFor(action: string, meta?: Record<string, any>): LucideIcon {
  // Snapshots win over the source-based watcher icon — a snapshot
  // is a snapshot, regardless of whether the watcher or an
  // in-process apply triggered it.
  if (action === 'version.snapshot') return Camera
  if (action === 'version.prune') return Trash2
  if (meta?.source === 'watcher') return HardDrive
  if (action === 'pin.add') return Pin
  if (action === 'pin.remove') return PinOff
  if (action === 'chat.feedback') return ThumbsDown
  if (action.startsWith('chat.thread.')) return MessageSquare
  if (action.startsWith('memory.')) return Brain
  if (action === 'chat.apply_edit' || action === 'chat.apply_edit_op') return Check
  if (action === 'chat.discard_edit' || action === 'chat.discard_edit_op') return X
  if (action.startsWith('chat.')) return Sparkles
  if (action.startsWith('mcp.')) {
    if (action.includes('tag')) return TagIcon
    return Sparkles
  }
  if (action.includes('upload')) return UploadCloud
  if (action.includes('replace')) return Pencil
  if (action.includes('edit')) return Pencil
  if (action.includes('restore')) return Undo2
  if (action.includes('trash') || action.includes('delete')) return Trash2
  if (action.includes('move')) return Move
  if (action.includes('visibility')) {
    if (meta?.public === true) return Globe
    if (meta?.public === false) return Lock
    return Lock
  }
  if (action.includes('tag')) return TagIcon
  if (action.includes('share')) return Users
  if (action.includes('index') || action.includes('reindex')) return FileSearch
  return History
}

// ── Formatters ─────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatTagList(tags: string[]): string {
  if (tags.length <= 3) return tags.map((t) => `#${t}`).join(', ')
  return `${tags
    .slice(0, 3)
    .map((t) => `#${t}`)
    .join(', ')} +${tags.length - 3} more`
}

function clockTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.round(mo / 12)
  return `${y}y ago`
}

/** Calendar-day key (YYYY-MM-DD) used to bucket rows. */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Friendly day header: "Today · Tue, May 23", "Yesterday · Mon,
 *  May 22", or "Mon, May 20" for older days. The relative prefix
 *  helps eye-scan, the absolute suffix removes ambiguity. */
function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  const dateLabel = d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  if (sameDay(d, now)) return `Today · ${dateLabel}`
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (sameDay(d, yesterday)) return `Yesterday · ${dateLabel}`
  return dateLabel
}

/** Human-friendly span between two timestamps. Used to show the
 *  "spanning Xm" hint on multi-event clusters so the user knows
 *  the cluster's duration, not just its endpoint. */
function spanLabel(start: number, end: number): string {
  const s = Math.max(1, Math.round(Math.abs(start - end) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return `${h}h`
}
