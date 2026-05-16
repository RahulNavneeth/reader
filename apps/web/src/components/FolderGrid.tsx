import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Folder,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileCode,
  Sparkles,
  Upload,
  Loader2,
  Globe,
  Lock,
  Trash2,
  X,
} from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { PathBreadcrumb } from './PathBreadcrumb'
import { MakePublicPopover } from './MakePublicPopover'
import { ShareWithUserButton } from './ShareWithUserButton'
import { TagsButton } from './TagsButton'
import { ActivityButton } from './ActivityButton'
import { RevokePublicPopover } from './RevokePublicPopover'

type FolderMetaShape = {
  owner: string
  storageKey: string
  tags: string[]
  public?: boolean
  publicExpiresAt?: number | null
  hasPassword: boolean
  publicPasswordHash?: string | null
  createdAt: number
  updatedAt: number
}

export function FolderGrid({ initialPath }: { initialPath?: string } = {}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // When viewing a path owned by another user (via a user-to-user share),
  // the URL carries `?owner=<username>`. We thread it through every read
  // call so the server treats us as a cross-owner caller and consults the
  // share grant instead of denying access.
  const ownerHint = searchParams.get('owner') || undefined
  const callerOpts = ownerHint ? { owner: ownerHint } : undefined
  // Cross-owner context (browsing someone else's shared path). Owner-
  // only controls (Tags / Activity / Share / Public / Private / bulk
  // toolbar) hide in this mode — the recipient can read and navigate
  // but not mutate the owner's vault.
  const isSharedView = !!ownerHint
  const { triggerUpload, refresh, refreshNonce, currentFolder, setCurrentFolder } = useVault()
  const [dir, setDir] = useState<string>(initialPath ?? currentFolder)

  // Honor URL-driven path changes (e.g. user clicks a Public folder link in a
  // new tab). The state above only seeds the first render — subsequent
  // /folder/<other> navigations need to push into state.
  useEffect(() => {
    if (initialPath !== undefined && initialPath !== dir) setDir(initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath])
  const [items, setItems] = useState<VaultNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<null | 'delete'>(null)
  const [folderMeta, setFolderMeta] = useState<FolderMetaShape | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (rel: string) => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.list(rel, callerOpts)
      setItems(r.items)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [callerOpts?.owner])

  useEffect(() => {
    load(dir)
    setCurrentFolder(dir)
    setSelection(new Set())
  }, [dir, load, refreshNonce, setCurrentFolder])

  // Fetch the current folder's own meta (tags + public state) — including
  // the vault root (path = ""). Making the root public cascades to every
  // file and sub-folder in the user's vault, which is exactly what the
  // user expects from a "share my whole vault" gesture.
  useEffect(() => {
    let cancelled = false
    api
      .getFolderMeta(dir, callerOpts)
      .then((r) => {
        if (!cancelled) setFolderMeta(r.folder as FolderMetaShape)
      })
      .catch(() => {
        if (!cancelled) setFolderMeta(null)
      })
    return () => {
      cancelled = true
    }
  }, [dir, refreshNonce, callerOpts?.owner])

  // Navigate folders through the URL so the address bar reflects "where am
  // I" — without this, clicking into a sub-folder kept the URL at the
  // vault root, which broke deep-linking and tab-restore. URLs are bare
  // paths now (no `/folder` or `/docs` prefix); VaultView's resolver
  // figures out which viewer to mount. State stays synced via the
  // initialPath effect above.
  // Carry the `?owner=` (shared vault) query through any in-app
  // navigation so the recipient stays in the share context as they
  // browse around.
  const ownerSuffix = ownerHint ? `?owner=${encodeURIComponent(ownerHint)}` : ''
  const goToFolder = useCallback(
    (rel: string) => {
      const segs = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')
      navigate(`${segs ? `/${segs}` : '/'}${ownerSuffix}`)
    },
    [navigate, ownerSuffix],
  )

  const onOpen = (node: VaultNode) => {
    if (node.type === 'dir') {
      goToFolder(node.path)
    } else {
      const segs = node.path.split('/').map(encodeURIComponent).join('/')
      navigate(`/${segs}${ownerSuffix}`)
    }
  }

  const toggleSelect = (path: string) => {
    setSelection((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const parent = useMemo(() => {
    if (!dir) return null
    const i = dir.lastIndexOf('/')
    return i < 0 ? '' : dir.slice(0, i)
  }, [dir])

  const selectedPaths = useMemo(() => Array.from(selection), [selection])

  // Split the selection into the inputs each bulk action should target.
  //
  // Files: classified by their current `public` flag. Sending only the ones
  // that need flipping avoids clobbering existing expiry/password on
  // already-public files when the user clicks Public on a mixed selection.
  //
  // Folders: we can't see every descendant's visibility from the parent
  // tree, so we add the folder path to *both* targets — the server walks
  // the subtree and applies the new flag to every file inside.
  const { privateTargets, publicTargets } = useMemo(() => {
    const priv: string[] = []
    const pub: string[] = []
    if (!items) {
      return { privateTargets: priv, publicTargets: pub }
    }
    const byPath = new Map(items.map((n) => [n.path, n]))
    for (const p of selectedPaths) {
      const n = byPath.get(p)
      if (!n) continue
      // Bucket by current `public` flag — folders cascade via the server
      // endpoint, so they're treated like files for the purposes of which
      // bulk action targets them.
      if (n.public) pub.push(p)
      else priv.push(p)
    }
    return { privateTargets: priv, publicTargets: pub }
  }, [items, selectedPaths])

  // Folder-level visibility breakdown — shown as counts inside the Public
  // and Private toolbar buttons so the user can see at-a-glance how many
  // items inside are currently in each state.
  const folderSummary = useMemo(() => {
    if (!items) return { pub: 0, priv: 0 }
    let pub = 0
    let priv = 0
    for (const n of items) {
      if (n.public) pub++
      else priv++
    }
    return { pub, priv }
  }, [items])

  // Clear selection whenever the user clicks somewhere that isn't a tile or
  // the bulk-actions toolbar — both inside this view (empty grid space) and
  // outside it (sidebar, chat panel, breadcrumb, etc.).
  useEffect(() => {
    if (selection.size === 0) return
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-grid-tile]') || t.closest('[data-grid-toolbar]')) return
      setSelection(new Set())
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(new Set())
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [selection.size])

  const runBulkDelete = async () => {
    if (selectedPaths.length === 0) return
    if (!confirm(`Move ${selectedPaths.length} item${selectedPaths.length === 1 ? '' : 's'} to Trash?`)) {
      return
    }
    setBusy('delete')
    setError(null)
    try {
      await api.bulkDelete(selectedPaths)
      setSelection(new Set())
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={rootRef} className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <div
        data-grid-toolbar=""
        className="flex items-center gap-2 px-3 h-11 border-b shrink-0"
        style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
      >
        <PathBreadcrumb
          dir={dir}
          onNavigate={(p) => goToFolder(p)}
          onBack={parent !== null ? () => goToFolder(parent) : undefined}
          ownerLabel={ownerHint}
        />
        <div className="flex-1" />
        {selection.size > 0 && !isSharedView ? (
          <>
            <span className="text-[11.5px] text-fg font-medium">
              {selection.size} selected
            </span>
            {/* Selection toolbar uses the same form + semantics as the
                folder toolbar: label = current state count, Public
                opens the revoke popover, Private opens the publish
                popover. Targets are the items that would actually
                change: revoke targets the already-public ones,
                publish targets the already-private ones. */}
            {publicTargets.length > 0 && (
              <RevokePublicPopover
                triggerLabel={`Public (${publicTargets.length})`}
                publicCount={publicTargets.length}
                folderPublic={false}
                onRevoke={async () => {
                  await api.bulkSetVisibility(publicTargets, false)
                  setSelection(new Set())
                  refresh()
                }}
              />
            )}
            {privateTargets.length > 0 && (
              <MakePublicPopover
                title={`Publish ${privateTargets.length} item${privateTargets.length === 1 ? '' : 's'}`}
                confirmLabel={`Publish ${privateTargets.length} item${privateTargets.length === 1 ? '' : 's'}`}
                onConfirm={async (opts) => {
                  await api.bulkSetVisibility(privateTargets, true, opts)
                  setSelection(new Set())
                  refresh()
                }}
                trigger={
                  <button
                    className="btn-ghost"
                    disabled={!!busy}
                    title={`Publish ${privateTargets.length} private item${privateTargets.length === 1 ? '' : 's'}`}
                  >
                    <Lock size={13} />
                    Private ({privateTargets.length})
                  </button>
                }
              />
            )}
            {/* Share-with-user fans out to every selected path under
                one recipient/permission combo — no need to pick each
                target one at a time. */}
            <ShareWithUserButton paths={selectedPaths} />
            <button
              className="btn-ghost"
              disabled={!!busy}
              onClick={runBulkDelete}
              title="Move to Trash"
              style={{ color: '#BF2600' }}
            >
              {busy === 'delete' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete
            </button>
            <button
              className="btn-ghost h-7 w-7 px-0"
              onClick={() => setSelection(new Set())}
              title="Clear selection"
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <>
            {/* Per-folder controls. Shown at every level (including the
                vault root). Tags / Activity / Share act on the folder
                itself. The Public/Private buttons mirror the selection
                toolbar — Public(N) cascades all currently-private items
                to public; Private(M) cascades all currently-public items
                to private. The folder's own visibility follows the
                cascade. */}
            {folderMeta && !isSharedView && (
              <>
                <TagsButton
                  path={dir}
                  kind="folder"
                  tags={folderMeta.tags}
                  onSaved={(tags) => setFolderMeta((m) => (m ? { ...m, tags } : m))}
                />
                <ActivityButton path={dir} kind="folder" />
                <ShareWithUserButton paths={[dir]} />
                {/* Folder Public/Private toggle. Mirrors the file
                    viewer's PublicButton: label + popover both come
                    from the folder's own visibility flag, so the user
                    never sees "Public" with a "Make public" form
                    inside. When the folder IS public, a dedicated
                    Private button next to it cascades a revoke without
                    needing to dig into the popover. */}
                {/* Two-button toggle: button label = count currently
                    in that state, click = act on those items.
                    Public(N) → revoke popover (cascades private).
                    Private(M) → publish popover with expiry/password
                    options (cascades public). */}
                {folderSummary.pub > 0 && (
                  <RevokePublicPopover
                    triggerLabel={`Public (${folderSummary.pub})`}
                    publicCount={folderSummary.pub}
                    folderPublic={!!folderMeta.public}
                    folderExpiresAt={folderMeta.publicExpiresAt}
                    folderHasPassword={folderMeta.hasPassword}
                    onRevoke={async () => {
                      await api.setFolderVisibility(dir, false)
                      setFolderMeta((m) =>
                        m
                          ? {
                              ...m,
                              public: false,
                              publicExpiresAt: null,
                              hasPassword: false,
                            }
                          : m,
                      )
                      refresh()
                    }}
                  />
                )}
                {folderSummary.priv > 0 && (
                  <MakePublicPopover
                    title="Publish folder"
                    confirmLabel={`Publish ${folderSummary.priv} item${folderSummary.priv === 1 ? '' : 's'}`}
                    onConfirm={async (opts) => {
                      const r = await api.setFolderVisibility(dir, true, opts)
                      setFolderMeta((m) => (m ? { ...m, ...r.folder } : m))
                      refresh()
                    }}
                    trigger={
                      <button
                        className="btn-ghost"
                        title={`Publish ${folderSummary.priv} private item${folderSummary.priv === 1 ? '' : 's'}`}
                      >
                        <Lock size={13} />
                        Private ({folderSummary.priv})
                      </button>
                    }
                  />
                )}

              </>
            )}
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading && !items && (
          <div className="flex items-center justify-center h-full text-muted text-[12.5px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        )}

        {error && (
          <div className="px-2 py-4">
            <div className="flex items-center gap-2 text-fg font-semibold mb-1">
              <Lock size={14} style={{ color: '#BF2600' }} /> Couldn't open this folder
            </div>
            <div className="text-[13px] text-muted">{prettyFolderError(error)}</div>
          </div>
        )}

        {items && items.length === 0 && !loading && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div
                className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                style={{ background: 'var(--panel)' }}
              >
                <Upload size={22} className={isSharedView ? 'text-subtle' : 'text-accent'} />
              </div>
              <div className="text-fg font-semibold text-[15px]">This folder is empty</div>
              {isSharedView ? (
                <div className="text-[12.5px] text-muted mt-1">
                  Nothing's been added here yet by the owner.
                </div>
              ) : (
                <>
                  <div className="text-[12.5px] text-muted mt-1 mb-4">
                    Drop files anywhere on this page to upload.
                  </div>
                  <button className="btn-primary" onClick={triggerUpload}>
                    <Upload size={14} />
                    Upload files
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {items && items.length > 0 && (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
            {items.map((node) => (
              <GridTile
                key={node.path}
                node={node}
                selected={selection.has(node.path)}
                onOpen={() => onOpen(node)}
                onToggleSelect={() => toggleSelect(node.path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function GridTile({
  node,
  selected,
  onOpen,
  onToggleSelect,
}: {
  node: VaultNode
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
}) {
  const [hover, setHover] = useState(false)
  const isFile = node.type === 'file'
  // Treat any image-y or PDF file as a thumbnail candidate. The endpoint 404s
  // for types it can't render; we fall back to the type icon on error.
  const ext = (node.ext || '').toLowerCase()
  const tryThumb =
    isFile &&
    [
      '.pdf',
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico',
      '.heic', '.heif', '.tiff', '.tif', '.jxl',
      '.mp4', '.mov', '.m4v', '.mkv', '.webm',
      '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
      '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
    ].includes(ext)
  const [thumbFailed, setThumbFailed] = useState(false)

  return (
    <div
      data-grid-tile=""
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        // Cmd/Ctrl-click toggles selection (works on files AND folders so
        // bulk Public/Private/Delete can act on whole subtrees); plain click
        // opens.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault()
          onToggleSelect()
          return
        }
        onOpen()
      }}
      className="group relative flex flex-col items-center justify-start gap-2 p-3 rounded-md transition-colors text-left cursor-pointer"
      style={{
        background: selected ? 'var(--selected)' : hover ? 'var(--border)' : 'transparent',
        outline: selected ? '1px solid var(--accent)' : undefined,
      }}
    >
      {(hover || selected) && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
          className="absolute top-1.5 left-1.5 w-4 h-4 rounded flex items-center justify-center"
          style={{
            background: selected ? 'var(--accent)' : 'var(--bg)',
            border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
          }}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
      {node.public && node.publicExpiresAt && (
        <span
          className="absolute top-1.5 right-1.5 text-[9.5px] font-medium px-1 py-px rounded leading-none"
          style={{
            background: 'var(--panel)',
            color: '#00875A',
            border: '1px solid var(--border-soft)',
          }}
          title={`Public link expires ${describeExpiry(node.publicExpiresAt)}`}
        >
          {shortExpiry(node.publicExpiresAt)}
        </span>
      )}
      <div className="w-full h-20 flex items-center justify-center overflow-hidden rounded">
        {node.type === 'dir' ? (
          <Folder size={42} className="text-accent" strokeWidth={1.4} />
        ) : tryThumb && !thumbFailed ? (
          <img
            src={api.thumbnailUrl(node.path)}
            alt=""
            className="max-w-full max-h-full object-contain"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <BigTypeIcon ext={node.ext} />
        )}
      </div>
      <div className="w-full text-[11.5px] text-fg text-center leading-tight">
        <span className="line-clamp-2 break-words">{node.name}</span>
        {node.type === 'file' && node.embedded && (
          <Sparkles size={9} className="text-accent inline-block ml-1 align-middle" />
        )}
        {node.public && (
          <Globe size={9} className="inline-block ml-1 align-middle" style={{ color: '#00875A' }} />
        )}
      </div>
    </div>
  )
}

function BigTypeIcon({ ext }: { ext?: string }) {
  const e = (ext || '').toLowerCase()
  const props = { size: 42, strokeWidth: 1.3 } as const
  if (e === '.pdf') return <FileType {...props} className="text-muted" />
  if ([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
  ].includes(e))
    return <FileImage {...props} className="text-muted" />
  if ([
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
    '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
    '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
  ].includes(e))
    return <FileVideo {...props} className="text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(e))
    return <FileCode {...props} className="text-subtle" />
  return <FileText {...props} className="text-subtle" />
}

/** Map raw API errors to copy a recipient can act on. */
function prettyFolderError(raw: string): string {
  const low = raw.toLowerCase()
  if (low === 'forbidden' || low.includes('forbidden')) {
    return "You don't have access to this folder. If someone shared a folder with you, the grant may have been revoked — ask them to re-share."
  }
  if (low.includes('expired')) return 'This public link has expired.'
  if (low.includes('password')) return 'A password is required to open this folder.'
  return raw
}

/** Tight badge label for the tile corner — e.g. "5d", "12h", "expired". */
function shortExpiry(ts: number): string {
  const ms = ts - Date.now()
  if (ms <= 0) return 'expired'
  const days = ms / 86_400_000
  if (days >= 1) return `${Math.round(days)}d`
  const hours = ms / 3_600_000
  if (hours >= 1) return `${Math.round(hours)}h`
  const mins = Math.max(1, Math.round(ms / 60_000))
  return `${mins}m`
}

/** Longer phrasing for the tile tooltip. */
function describeExpiry(ts: number): string {
  const ms = ts - Date.now()
  if (ms <= 0) return 'already (expired)'
  const days = ms / 86_400_000
  if (days < 1) {
    const hours = Math.max(1, Math.round(ms / 3_600_000))
    return `in ${hours}h`
  }
  if (days < 14) return `in ${Math.round(days)} days`
  return `on ${new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`
}
