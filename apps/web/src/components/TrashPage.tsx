import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Trash2,
  RotateCcw,
  Loader2,
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  X,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { useConfirm } from '../lib/confirm'
import { SelectIndicator } from './SelectIndicator'

type Entry = {
  id: string
  /** 'file' (default, legacy) or 'folder' when the whole subtree
   *  was trashed as one unit. */
  kind?: 'file' | 'folder'
  storageKey: string
  filename: string
  docId?: string
  bytes: number
  trashedAt: number
  trashedBy: string
  /** Folder-only: per-file manifest (just used here for a count). */
  children?: Array<{ storageKey: string; docId?: string; bytes: number }>
}

/** Tree node for the per-folder-entry expand view. The server stores
 *  children as a flat array of file paths; we group them back into
 *  the original directory structure so a deeply-nested vault doesn't
 *  read as a wall of full paths. */
type TreeNode =
  | { kind: 'file'; storageKey: string; bytes: number }
  | { kind: 'dir'; name: string; pathKey: string; children: TreeNode[] }

function buildTree(
  rootKey: string,
  files: Array<{ storageKey: string; bytes: number }>,
): TreeNode[] {
  type Bucket = { dirs: Map<string, Bucket>; files: typeof files }
  const root: Bucket = { dirs: new Map(), files: [] }
  const prefix = rootKey.replace(/\/$/, '') + '/'
  for (const f of files) {
    const rel = f.storageKey.startsWith(prefix)
      ? f.storageKey.slice(prefix.length)
      : f.storageKey
    const parts = rel.split('/').filter(Boolean)
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]
      let next = cur.dirs.get(dir)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        cur.dirs.set(dir, next)
      }
      cur = next
    }
    cur.files.push(f)
  }
  function toNodes(bucket: Bucket, basePath: string): TreeNode[] {
    const out: TreeNode[] = []
    const dirNames = Array.from(bucket.dirs.keys()).sort()
    for (const d of dirNames) {
      const childPath = basePath ? `${basePath}/${d}` : d
      out.push({
        kind: 'dir',
        name: d,
        pathKey: childPath,
        children: toNodes(bucket.dirs.get(d)!, childPath),
      })
    }
    const sortedFiles = bucket.files
      .slice()
      .sort((a, b) => a.storageKey.localeCompare(b.storageKey))
    for (const f of sortedFiles) {
      out.push({ kind: 'file', storageKey: f.storageKey, bytes: f.bytes })
    }
    return out
  }
  return toNodes(root, '')
}

/**
 * Per-user trash bin. The server scopes the trash list to the caller
 * already; this page just renders it with restore + purge actions.
 * Admins still get the wider table in /settings; users get this.
 */
export function TrashPage() {
  const navigate = useNavigate()
  const { refresh } = useVault()
  const confirm = useConfirm()
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = () =>
    api
      .trashList()
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    load()
  }, [])

  const restore = async (e: Entry) => {
    const ok = await confirm({
      title: e.kind === 'folder' ? 'Restore folder?' : 'Restore?',
      message:
        e.kind === 'folder'
          ? `"${e.filename}/" and every file inside will be returned to ${e.storageKey}.`
          : `"${e.filename}" will be returned to ${e.storageKey}.`,
      confirmLabel: 'Restore',
    })
    if (!ok) return
    setBusyId(e.id)
    setError(null)
    try {
      const r = await api.trashRestore(e.id)
      await load()
      refresh()
      // Folder restores can land partially when some destination
      // paths are already in use (often the case after the user
      // restored individual children first). Surface the conflicts
      // so they know what to clear before retrying.
      if (r.conflicts && r.conflicts.length > 0) {
        const preview = r.conflicts.slice(0, 5).join('\n• ')
        const more =
          r.conflicts.length > 5
            ? `\n…and ${r.conflicts.length - 5} more`
            : ''
        setError(`${r.message ?? 'Some files could not be restored.'}\n• ${preview}${more}`)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (e: Entry) => {
    const ok = await confirm({
      title: 'Permanently delete',
      message: `"${e.filename}" will be erased from disk. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      destructive: true,
    })
    if (!ok) return
    setBusyId(e.id)
    setError(null)
    try {
      await api.trashPurge(e.id)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  // Per-folder-entry expand state. Folder entries get a chevron;
  // clicking it reveals each trashed child file with its own
  // Restore button so users can cherry-pick instead of being
  // forced to restore the whole subtree.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // Keyed by `${entry.id}::${child.storageKey}` so two folder
  // entries with overlapping child paths don't share spinners.
  const [childBusy, setChildBusy] = useState<string | null>(null)
  // Subfolder restore — client-side fan-out across the per-child
  // endpoint. Keeps the server simple (no new endpoint) and lets the
  // user cherry-pick at any depth: "restore everything under
  // investments/amcs/" but not the rest of investments/.
  const [dirBusy, setDirBusy] = useState<string | null>(null)
  const restoreDir = async (
    entry: Entry,
    dirPath: string,
    fileKeys: string[],
  ) => {
    if (fileKeys.length === 0) return
    const ok = await confirm({
      title: 'Restore folder?',
      message: `${fileKeys.length} file${fileKeys.length === 1 ? '' : 's'} under "${dirPath}/" will be returned to ${entry.storageKey}/${dirPath}/. The rest of "${entry.filename}/" stays in Trash.`,
      confirmLabel: 'Restore',
    })
    if (!ok) return
    const dirKey = `${entry.id}::dir::${dirPath}`
    setDirBusy(dirKey)
    setError(null)
    const conflicts: string[] = []
    let restored = 0
    try {
      for (const sk of fileKeys) {
        try {
          await api.trashRestoreChild(entry.id, sk)
          restored++
        } catch (err) {
          // Per-file conflict (target exists) shouldn't abort the
          // batch — keep going and surface the partials below.
          const msg = err instanceof ApiError ? err.message : String(err)
          if (msg.toLowerCase().includes('in use')) conflicts.push(sk)
          else conflicts.push(`${sk} — ${msg}`)
        }
      }
      await load()
      refresh()
      if (conflicts.length > 0) {
        const preview = conflicts.slice(0, 5).join('\n• ')
        const more =
          conflicts.length > 5 ? `\n…and ${conflicts.length - 5} more` : ''
        setError(
          `Restored ${restored} file${restored === 1 ? '' : 's'}. ${conflicts.length} couldn't be restored:\n• ${preview}${more}`,
        )
      }
    } finally {
      setDirBusy(null)
    }
  }

  const restoreChild = async (entry: Entry, storageKey: string) => {
    const ok = await confirm({
      title: 'Restore?',
      message: `"${storageKey.split('/').pop()}" will be returned to ${storageKey}. The rest of "${entry.filename}/" stays in Trash.`,
      confirmLabel: 'Restore',
    })
    if (!ok) return
    const key = `${entry.id}::${storageKey}`
    setChildBusy(key)
    setError(null)
    try {
      await api.trashRestoreChild(entry.id, storageKey)
      await load()
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setChildBusy(null)
    }
  }

  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const toggleSelected = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelection(new Set())
  const bulkRestore = async () => {
    if (selection.size === 0) return
    setBulkBusy(true)
    setError(null)
    try {
      const results = await Promise.allSettled(
        Array.from(selection).map((id) => api.trashRestore(id)),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      await load()
      refresh()
      if (failed > 0) setError(`${failed} item(s) failed to restore`)
      clearSelection()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBulkBusy(false)
    }
  }
  const bulkPurge = async () => {
    if (selection.size === 0) return
    const ok = await confirm({
      title: `Permanently delete ${selection.size} item(s)`,
      message: 'They will be erased from disk. This cannot be undone.',
      confirmLabel: 'Delete forever',
      destructive: true,
    })
    if (!ok) return
    setBulkBusy(true)
    setError(null)
    try {
      const results = await Promise.allSettled(
        Array.from(selection).map((id) => api.trashPurge(id)),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      await load()
      if (failed > 0) setError(`${failed} item(s) failed to delete`)
      clearSelection()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ background: 'var(--surface-3)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/')}
          title="Back to vault"
          aria-label="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <Trash2 size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Trash</div>
        {entries && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {entries.length} {entries.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </header>
      {selection.size > 0 && (
        <div
          className="h-10 px-3 flex items-center gap-2 border-b shrink-0"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
        >
          <div className="text-[12.5px] font-medium text-fg">
            {selection.size} selected
          </div>
          <button
            className="btn-ghost h-7"
            onClick={bulkRestore}
            disabled={bulkBusy}
          >
            {bulkBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCcw size={12} />
            )}
            Restore
          </button>
          <button
            className="btn-ghost-danger h-7"
            onClick={bulkPurge}
            disabled={bulkBusy}
          >
            <Trash2 size={12} />
            Delete forever
          </button>
          <button
            className="btn-ghost h-7 ml-auto"
            onClick={clearSelection}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X size={12} />
            Clear
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1080px] mx-auto px-8 py-6">

        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] flex items-start gap-2 whitespace-pre-wrap"
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-fg)',
              border: '1px solid color-mix(in srgb, var(--danger-fg) 30%, transparent)',
            }}
          >
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0">{error}</span>
          </div>
        )}

        {!entries ? null : entries.length === 0 ? (
          <div
            className="rounded-md p-8 text-center"
            style={{ background: 'var(--surface-2)', border: '1px dashed var(--border)' }}
          >
            <div className="text-[14px] text-fg font-medium">Trash is empty</div>
            <div className="text-[12px] text-muted mt-1.5">
              Anything you delete from the vault will show up here.
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {entries.map((e) => {
              const lastSlash = e.storageKey.lastIndexOf('/')
              const parentDir = lastSlash >= 0 ? e.storageKey.slice(0, lastSlash) : ''
              const isSel = selection.has(e.id)
              const inSelectionMode = isSel || selection.size > 0
              const isFolder = e.kind === 'folder'
              const childCount = e.children?.length ?? 0
              const isExpanded = isFolder && expanded.has(e.id)
              return (
                <div
                  key={e.id}
                  className="rounded transition-colors"
                  style={{
                    background: isSel ? 'var(--selected)' : 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    outline: isSel ? '1px solid var(--accent)' : undefined,
                    outlineOffset: isSel ? '-1px' : undefined,
                  }}
                >
                  <div
                    className="group flex items-center gap-3 px-3 py-2"
                    onClick={(evt) => {
                      if (evt.metaKey || evt.ctrlKey || selection.size > 0) {
                        evt.preventDefault()
                        toggleSelected(e.id)
                      }
                    }}
                  >
                  {/* Chevron sits to the left of the icon for folder
                      entries. Click to expand/collapse the child list. */}
                  {isFolder && !inSelectionMode ? (
                    <button
                      type="button"
                      className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded hover:bg-[var(--hover)] transition-transform"
                      onClick={(evt) => {
                        evt.stopPropagation()
                        toggleExpanded(e.id)
                      }}
                      title={isExpanded ? 'Hide contents' : 'Show contents'}
                      aria-expanded={isExpanded}
                      style={{
                        transform: isExpanded ? 'rotate(90deg)' : undefined,
                      }}
                    >
                      <ChevronRight size={12} className="text-muted" />
                    </button>
                  ) : null}
                  {inSelectionMode ? (
                    <span className="shrink-0 relative w-4 h-4">
                      <SelectIndicator
                        checked={isSel}
                        position={{ top: 0, left: 0 }}
                        onClick={(evt) => {
                          evt.stopPropagation()
                          toggleSelected(e.id)
                        }}
                      />
                    </span>
                  ) : isFolder ? (
                    <Folder size={14} className="text-muted shrink-0" />
                  ) : (
                    <FileText size={14} className="text-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-fg truncate">
                      {e.filename}
                      {isFolder && (
                        <span className="ml-1 opacity-70">/</span>
                      )}
                    </div>
                    <div className="text-[11px] text-subtle truncate">
                      {parentDir && (
                        <>
                          <span className="opacity-80">{parentDir}/</span>
                          <span className="mx-1.5 opacity-60">·</span>
                        </>
                      )}
                      {isFolder && (
                        <>
                          <span>
                            {childCount} item{childCount === 1 ? '' : 's'}
                          </span>
                          <span className="mx-1.5 opacity-60">·</span>
                        </>
                      )}
                      <span className="tabular-nums">{formatBytes(e.bytes)}</span>
                      <span className="mx-1.5 opacity-60">·</span>
                      <span>deleted {timeAgo(e.trashedAt)}</span>
                      <span className="mx-1.5 opacity-60">·</span>
                      <span style={{ color: deletionColor(e.trashedAt) }}>
                        {deletionCountdown(e.trashedAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn-ghost shrink-0"
                    onClick={() => restore(e)}
                    disabled={busyId === e.id}
                    title="Restore to original location"
                  >
                    {busyId === e.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCcw size={12} />
                    )}
                    Restore
                  </button>
                  <button
                    className="btn-ghost-danger shrink-0"
                    onClick={() => purge(e)}
                    disabled={busyId === e.id}
                    title="Permanently delete"
                    aria-label="Permanently delete"
                  >
                    <Trash2 size={12} />
                  </button>
                  </div>
                  {isExpanded && e.children && e.children.length > 0 && (
                    <div
                      className="px-3 pb-2 pt-1"
                      style={{ borderTop: '1px solid var(--border)' }}
                    >
                      <TreeView
                        entry={e}
                        nodes={buildTree(e.storageKey, e.children)}
                        depth={0}
                        childBusy={childBusy}
                        dirBusy={dirBusy}
                        onRestoreFile={restoreChild}
                        onRestoreDir={restoreDir}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

/**
 * Recursive tree view for a folder trash entry's expanded panel.
 * Directories are click-to-expand; files have a Restore button
 * that calls the per-child server endpoint. Indentation comes
 * from `depth` rather than nested padding so the right-side
 * column lines up across levels.
 */
/** Walk a tree node and collect every file leaf's storageKey.
 *  Used by the per-subfolder Restore button to fan out across
 *  every file under a directory. */
function collectFileKeys(node: TreeNode, out: string[] = []): string[] {
  if (node.kind === 'file') {
    out.push(node.storageKey)
  } else {
    for (const c of node.children) collectFileKeys(c, out)
  }
  return out
}

function TreeView({
  entry,
  nodes,
  depth,
  childBusy,
  dirBusy,
  onRestoreFile,
  onRestoreDir,
}: {
  entry: Entry
  nodes: TreeNode[]
  depth: number
  childBusy: string | null
  dirBusy: string | null
  onRestoreFile: (entry: Entry, storageKey: string) => void
  onRestoreDir: (entry: Entry, dirPath: string, fileKeys: string[]) => void
}) {
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => {
    // Default: top-level dirs open; everything below collapsed.
    // Keeps deeply-nested trees scannable on first expand without
    // making the user click 5 chevrons to see anything.
    if (depth !== 0) return new Set()
    const s = new Set<string>()
    for (const n of nodes) if (n.kind === 'dir') s.add(n.pathKey)
    return s
  })
  const toggleDir = (pathKey: string) =>
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(pathKey)) next.delete(pathKey)
      else next.add(pathKey)
      return next
    })
  // Each indentation step is 18px — enough to be obviously nested,
  // not so much that the right column gets squeezed.
  const indentPx = 8 + depth * 18
  return (
    <div>
      {nodes.map((n) => {
        if (n.kind === 'dir') {
          const isOpen = openDirs.has(n.pathKey)
          const dirKey = `${entry.id}::dir::${n.pathKey}`
          const dBusy = dirBusy === dirKey
          // Pre-collect every file under this dir node so the
          // Restore button knows what to fan out across.
          const fileKeys = collectFileKeys(n, [])
          return (
            <div key={n.pathKey}>
              <div
                className="flex items-center gap-2 py-1.5 rounded hover:bg-[var(--hover)]"
                style={{ paddingLeft: indentPx }}
              >
                <button
                  type="button"
                  className="inline-flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                  onClick={() => toggleDir(n.pathKey)}
                  title={isOpen ? 'Hide contents' : 'Show contents'}
                >
                  <ChevronRight
                    size={11}
                    className="text-muted shrink-0 transition-transform"
                    style={{ transform: isOpen ? 'rotate(90deg)' : undefined }}
                  />
                  <Folder size={13} className="text-muted shrink-0" />
                  <span className="text-[12.5px] text-fg truncate">
                    {n.name}
                    <span className="opacity-70">/</span>
                    <span className="ml-1.5 text-[11px] text-subtle">
                      {fileKeys.length} file{fileKeys.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
                <button
                  className="btn-ghost shrink-0"
                  onClick={() => onRestoreDir(entry, n.pathKey, fileKeys)}
                  disabled={dBusy || fileKeys.length === 0}
                  title={`Restore everything under ${n.pathKey}/`}
                >
                  {dBusy ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RotateCcw size={12} />
                  )}
                  Restore
                </button>
              </div>
              {isOpen && (
                <TreeView
                  entry={entry}
                  nodes={n.children}
                  depth={depth + 1}
                  childBusy={childBusy}
                  dirBusy={dirBusy}
                  onRestoreFile={onRestoreFile}
                  onRestoreDir={onRestoreDir}
                />
              )}
            </div>
          )
        }
        const cName = n.storageKey.split('/').pop() || n.storageKey
        const cKey = `${entry.id}::${n.storageKey}`
        const cBusy = childBusy === cKey
        // File leaf indent: line up with the dir's NAME column,
        // not its chevron — chevron is 11px + gap 2 = 13px wide.
        return (
          <div
            key={n.storageKey}
            className="flex items-center gap-2 py-1.5"
            style={{ paddingLeft: indentPx + 13 }}
          >
            <FileText size={13} className="text-muted shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-fg truncate">{cName}</div>
              <div className="text-[11px] text-subtle">
                <span className="tabular-nums">{formatBytes(n.bytes)}</span>
              </div>
            </div>
            <button
              className="btn-ghost shrink-0"
              onClick={() => onRestoreFile(entry, n.storageKey)}
              disabled={cBusy}
              title="Restore just this file"
            >
              {cBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCcw size={12} />
              )}
              Restore
            </button>
          </div>
        )
      })}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const TRASH_RETENTION_DAYS = 30

function deletionCountdown(trashedAt: number): string {
  const purgeAt = trashedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const msLeft = purgeAt - Date.now()
  if (msLeft <= 0) return 'purges any moment'
  const hours = Math.floor(msLeft / (60 * 60 * 1000))
  if (hours < 24) return `purges in ${hours}h`
  const days = Math.floor(msLeft / (24 * 60 * 60 * 1000))
  return `purges in ${days}d`
}

function deletionColor(trashedAt: number): string {
  const purgeAt = trashedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const daysLeft = (purgeAt - Date.now()) / (24 * 60 * 60 * 1000)
  if (daysLeft <= 1) return '#BF2600'
  if (daysLeft <= 7) return '#FF991F'
  return 'var(--fg-subtle)'
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
