import { useEffect, useMemo, useState } from 'react'
import {
  History,
  Loader2,
  UploadCloud,
  Pencil,
  Trash2,
  Undo2,
  Move,
  Lock,
  Tag as TagIcon,
  Sparkles,
  Users,
  HardDrive,
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

/**
 * Audit-log surface for a single file. Lives inside the toolbar's
 * Activity popover. Pulls /api/file/activity (auth-gated by read
 * perms) and renders the last N events grouped by relative date
 * with an action-typed icon on each row.
 *
 * Refreshes when the path changes; not subscribed to SSE because
 * audit entries follow other writes that already trigger a refresh.
 */
export function ActivityPanel({
  path,
  kind = 'file',
}: {
  path: string
  kind?: 'file' | 'folder'
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setError(null)
    const fetcher = kind === 'folder' ? api.folderActivity(path) : api.fileActivity(path)
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
  }, [path, kind])

  // Group entries into Today / Yesterday / This week / Earlier so
  // long histories scan at a glance instead of as a flat list of
  // timestamps.
  const groups = useMemo(() => {
    if (!entries) return null
    const buckets: Array<{ label: string; entries: Entry[] }> = [
      { label: 'Today', entries: [] },
      { label: 'Yesterday', entries: [] },
      { label: 'This week', entries: [] },
      { label: 'Earlier', entries: [] },
    ]
    const now = Date.now()
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const todayMs = startOfDay.getTime()
    const yesterdayMs = todayMs - 24 * 60 * 60 * 1000
    const weekAgoMs = todayMs - 7 * 24 * 60 * 60 * 1000
    for (const e of entries) {
      if (e.ts >= todayMs) buckets[0].entries.push(e)
      else if (e.ts >= yesterdayMs) buckets[1].entries.push(e)
      else if (e.ts >= weekAgoMs) buckets[2].entries.push(e)
      else buckets[3].entries.push(e)
    }
    void now
    return buckets.filter((b) => b.entries.length > 0)
  }, [entries])

  return (
    <div>
      {entries == null && !error && (
        <div className="px-3 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div className="px-3 py-2 text-[11.5px]" style={{ color: '#BF2600' }}>
          {error}
        </div>
      )}
      {entries && entries.length === 0 && (
        <div className="px-3 py-3 text-[11.5px] text-muted">
          No recorded activity for this {kind === 'folder' ? 'folder' : 'file'} yet.
        </div>
      )}
      {groups?.map((g) => (
        <div key={g.label} className="py-1">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold text-subtle">
            {g.label}
          </div>
          <ul className="space-y-0.5 px-1.5">
            {g.entries.map((e, i) => {
              const Icon = iconFor(e.action, e.meta)
              // Watcher-attributed edits (source: 'watcher', actor:
              // 'system') represent on-disk changes made outside
              // Reader. Render with no actor name — leading with
              // "system" reads like a backend message, not an
              // external-edit signal. The sentence stands on its
              // own ("Edited on disk by an external tool · 5m ago").
              const isExternal =
                (e.meta as Record<string, unknown> | undefined)?.source === 'watcher' ||
                e.actor === 'system'
              return (
                <li
                  key={i}
                  className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-hover"
                >
                  <div
                    className="mt-0.5 w-5 h-5 rounded-full inline-flex items-center justify-center shrink-0"
                    style={{ background: 'var(--bg)', color: 'var(--fg-subtle)' }}
                  >
                    <Icon size={11} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-fg leading-tight">
                      {isExternal ? (
                        <span className="text-fg">
                          {phraseFor(e.action, e.meta, true)}
                        </span>
                      ) : (
                        <>
                          <span className="font-medium">{e.actor}</span>{' '}
                          <span className="text-muted">
                            {phraseFor(e.action, e.meta, false)}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="text-[10.5px] text-subtle mt-0.5">
                      {timeAgo(e.ts)}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * Natural-language verbalization of an audit action. Embeds the
 * meta-derived noun phrase ("with alice", "to public", "3 tags") so
 * each row reads as a sentence: "alice uploaded the file" rather
 * than "alice — vault.upload".
 *
 * `external` flips upload/edit/replace into self-contained sentences
 * for the watcher case where there's no human actor to lead with.
 */
function phraseFor(
  action: string,
  meta: Record<string, any> | undefined,
  external = false,
): string {
  // External (watcher-attributed) variants — read as full sentences,
  // no leading actor name needed.
  if (external) {
    switch (action) {
      case 'vault.upload':
        return 'Detected new file on disk'
      case 'vault.edit':
        return 'Edited on disk by an external tool'
      case 'vault.replace':
        return 'Replaced on disk by an external tool'
      // Fall through to the normal phrasing for anything else —
      // the watcher only writes upload/edit/replace right now, but
      // any future emit will still render in English.
    }
  }
  switch (action) {
    case 'vault.upload':
      return 'uploaded this'
    case 'vault.edit':
      return 'edited on disk'
    case 'vault.replace':
      return 'replaced the contents'
    case 'vault.trash':
      return 'moved this to Trash'
    case 'vault.delete':
      return 'permanently deleted this'
    case 'vault.move':
      return 'moved this'
    case 'vault.visibility':
      if (typeof meta?.public === 'boolean') {
        return meta.public ? 'made this public' : 'made this private'
      }
      return 'changed visibility'
    case 'vault.tags':
      if (Array.isArray(meta?.tags)) {
        if (meta.tags.length === 0) return 'cleared all tags'
        return `set tags to ${formatTagList(meta.tags as string[])}`
      }
      return 'updated tags'
    case 'vault.bulk-tags':
      if (Array.isArray(meta?.add) && meta.add.length > 0) {
        return `added tag ${formatTagList(meta.add as string[])}`
      }
      if (Array.isArray(meta?.remove) && meta.remove.length > 0) {
        return `removed tag ${formatTagList(meta.remove as string[])}`
      }
      return 'updated tags'
    case 'vault.index':
      return 'indexed this for search'
    case 'vault.reindex':
      return 're-indexed this'
    case 'trash.restore':
      return 'restored this from Trash'
    case 'trash.purge':
      return 'permanently purged this'
    case 'vault.bulk-trash':
      return `moved ${meta?.count ?? 'several files'} to Trash`
    case 'vault.bulk-visibility':
      return 'changed visibility on a selection'
    case 'vault.folder-visibility':
      if (typeof meta?.public === 'boolean') {
        return meta.public ? 'made this folder public' : 'made this folder private'
      }
      return 'changed folder visibility'
    case 'vault.folder-tags':
      if (Array.isArray(meta?.tags)) {
        if (meta.tags.length === 0) return 'cleared the folder tags'
        return `set the folder tags to ${formatTagList(meta.tags as string[])}`
      }
      return 'updated folder tags'
    case 'vault.share-with':
    case 'vault.share-with-file':
      if (typeof meta?.recipient === 'string') {
        const role = meta.canEdit ? 'edit' : 'read-only'
        return meta.cascadedFrom
          ? `shared this with ${meta.recipient} (${role}) via folder ${meta.cascadedFrom}`
          : `shared this with ${meta.recipient} (${role})`
      }
      return 'shared this'
    case 'vault.share-with-folder':
      if (typeof meta?.recipient === 'string') {
        const role = meta.canEdit ? 'edit' : 'read-only'
        return `shared the folder with ${meta.recipient} (${role})`
      }
      return 'shared the folder'
    case 'vault.share-revoke':
      if (typeof meta?.recipient === 'string') {
        return `revoked sharing with ${meta.recipient}`
      }
      return 'revoked sharing'
    // MCP-tool writes. Same author attribution as the rest (the
    // audit entry's `actor` is already the token user); we just need
    // the phrasing to read like normal English and not "mcp.set_tags".
    case 'mcp.upload_text':
      return `wrote this via MCP${meta?.bytes ? ` (${formatBytes(meta.bytes as number)})` : ''}`
    case 'mcp.set_tags':
      if (Array.isArray(meta?.tags)) {
        if (meta.tags.length === 0) return 'cleared all tags via MCP'
        return `set tags to ${formatTagList(meta.tags as string[])} via MCP`
      }
      return 'updated tags via MCP'
    default:
      // Last-ditch readability for actions we haven't explicitly
      // phrased yet. Turns "mcp.foo_bar" into "foo bar (via MCP)"
      // and "vault.foo_bar" into "foo bar" so an un-handled new
      // action doesn't read like a developer log entry.
      if (action.startsWith('mcp.')) {
        return `${action.slice(4).replace(/_/g, ' ')} (via MCP)`
      }
      if (action.startsWith('vault.')) {
        return action.slice(6).replace(/[-_]/g, ' ')
      }
      return action
  }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function iconFor(action: string, meta?: Record<string, any>): LucideIcon {
  // Watcher-attributed edits (the file changed on disk outside
  // Reader) get the HardDrive glyph — visually distinct from
  // in-app edits so a vim/Obsidian touch is obvious at a glance.
  if (meta?.source === 'watcher') return HardDrive
  // MCP-attributed actions get the Sparkles icon so agent edits are
  // visually distinct from user edits at a glance — same convention
  // the rest of the app uses for "AI-touched" affordances.
  if (action.startsWith('mcp.')) {
    if (action.includes('tag')) return TagIcon
    return Sparkles
  }
  if (action.includes('upload')) return UploadCloud
  if (action.includes('edit') || action.includes('replace')) return Pencil
  if (action.includes('trash') || action.includes('delete')) return Trash2
  if (action.includes('restore')) return Undo2
  if (action.includes('move')) return Move
  if (action.includes('visibility')) return Lock
  if (action.includes('tag')) return TagIcon
  if (action.includes('index')) return Sparkles
  if (action.includes('share')) return Users
  return History
}

function formatTagList(tags: string[]): string {
  if (tags.length <= 3) return tags.map((t) => `#${t}`).join(', ')
  return `${tags
    .slice(0, 3)
    .map((t) => `#${t}`)
    .join(', ')} +${tags.length - 3}`
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
