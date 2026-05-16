import { useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'

type Entry = {
  ts: number
  actor: string
  action: string
  target?: string
  meta?: Record<string, any>
}

/**
 * Audit-log surface for a single file. Lives in the right-rail of the doc
 * viewer. Pulls /api/file/activity (auth-gated by read perms) and renders the
 * last N events. Refreshes when the path changes; not subscribed to SSE
 * because audit entries follow other writes that already trigger a refresh.
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

  return (
    <div className="text-[12.5px] flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-subtle text-[10.5px] uppercase tracking-wider font-semibold px-1">
        <History size={11} /> Activity
      </div>
      {entries == null && !error && (
        <div className="px-1 text-muted flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div className="px-1" style={{ color: '#BF2600' }}>
          {error}
        </div>
      )}
      {entries && entries.length === 0 && (
        <div className="px-1 text-muted">
          No recorded activity for this {kind === 'folder' ? 'folder' : 'file'}.
        </div>
      )}
      {entries && entries.length > 0 && (
        <ul className="space-y-1">
          {entries.map((e, i) => (
            <li
              key={i}
              className="px-2 py-1.5 rounded"
              style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-fg">{prettyAction(e.action)}</span>
                <span className="text-[10.5px] text-subtle whitespace-nowrap">
                  {timeAgo(e.ts)}
                </span>
              </div>
              <div className="text-[11.5px] text-muted mt-0.5">
                by <span className="text-fg">{e.actor}</span>
                {summarizeMeta(e.meta) && <span> · {summarizeMeta(e.meta)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function prettyAction(a: string): string {
  switch (a) {
    case 'vault.upload': return 'Uploaded'
    case 'vault.edit': return 'Edited on disk'
    case 'vault.replace': return 'Replaced'
    case 'vault.trash': return 'Moved to Trash'
    case 'vault.delete': return 'Deleted'
    case 'vault.move': return 'Moved'
    case 'vault.visibility': return 'Visibility changed'
    case 'vault.tags': return 'Tags updated'
    case 'vault.index': return 'Indexed'
    case 'vault.reindex': return 'Re-indexed'
    case 'trash.restore': return 'Restored'
    case 'trash.purge': return 'Purged'
    case 'vault.bulk-trash': return 'Trashed (bulk)'
    case 'vault.bulk-visibility': return 'Visibility (bulk)'
    case 'vault.folder-visibility': return 'Folder visibility changed'
    case 'vault.folder-tags': return 'Folder tags updated'
    case 'vault.share-with': return 'Shared with user'
    case 'vault.share-with-file': return 'Shared via folder'
    case 'vault.share-with-folder': return 'Shared via folder'
    case 'vault.share-revoke': return 'Share revoked'
    default: return a
  }
}

function summarizeMeta(meta: Record<string, any> | undefined): string {
  if (!meta) return ''
  if (typeof meta.public === 'boolean') {
    const base = meta.public ? 'made public' : 'made private'
    return meta.cascadedFrom
      ? `${base} via folder ${meta.cascadedFrom || '(root)'}`
      : base
  }
  if (typeof meta.recipient === 'string') {
    const edit = meta.canEdit ? ' (edit)' : ' (read-only)'
    return meta.cascadedFrom
      ? `with ${meta.recipient}${edit} via folder ${meta.cascadedFrom}`
      : `with ${meta.recipient}${edit}`
  }
  if (Array.isArray(meta.tags)) {
    if (meta.tags.length === 0) return '(no tags)'
    // Inline preview is only useful when you can scan all of it. Past 5 tags
    // the slice is alphabetical noise — just show the count.
    if (meta.tags.length <= 5) {
      return `${meta.tags.length} tag${meta.tags.length === 1 ? '' : 's'} (${meta.tags.join(', ')})`
    }
    return `${meta.tags.length} tags`
  }
  if (typeof meta.count === 'number') return `${meta.count} files`
  return ''
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
