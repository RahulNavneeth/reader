import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { FileX, FolderX, Lock } from 'lucide-react'
import { PathViewer } from './PathViewer'
import { PathBreadcrumb } from './PathBreadcrumb'
import { FolderGrid } from './FolderGrid'
import { TaggedFilesView } from './TaggedFilesView'
import { VaultSidebar } from './VaultSidebar'
import { useVault } from '../lib/vault-context'
import { ApiError, api } from '../lib/api'
import { vaultUrl } from '../lib/vaultUrl'

export function VaultView() {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Two URL forms feed VaultView:
  //   /<path>                — own vault
  //   /u/<owner>/<path>      — shared from <owner>
  // We unify them into (ownerHint, barePath) so the rest of the
  // component (and PathViewer downstream) doesn't care which form
  // brought the user here. The legacy `?owner=` query is still
  // honoured for back-compat with old links.
  const routeOwner = params.owner || undefined
  const queryOwner = searchParams.get('owner') || undefined
  const tagFilter = location.pathname.startsWith('/tags/') ? params.tag ?? null : null
  const { uploadFiles, currentUsername } = useVault()
  // Normalise away an owner-segment / query that points at the
  // signed-in user themselves — that's not a share, that's their
  // own vault, and the bare `/<path>` URL is the canonical form.
  // We hold off until `currentUsername` actually loads so a
  // transient anonymous render doesn't drop the segment too
  // early.
  const ownerHint =
    currentUsername && routeOwner === currentUsername
      ? undefined
      : routeOwner ||
        (currentUsername && queryOwner === currentUsername ? undefined : queryOwner)
  const [dragOver, setDragOver] = useState(false)

  // Bare paths (no /docs or /folder prefix): a path can be either a file
  // or a folder, so we ask the server which one it is and dispatch the
  // right viewer. The cache key is the path itself — switching to a
  // different bare path triggers a re-resolve.
  const barePath = !tagFilter ? (params['*'] || '').trim() : ''

  // Canonicalise: a URL like `/u/<myself>/foo.md` should collapse to
  // `/foo.md`. The /u/ namespace is reserved for cross-user shares;
  // if the route owner is the signed-in user themselves there's no
  // share — just an over-specified URL — so rewrite it back to the
  // bare form. Belts-and-braces with the ownerHint normalisation
  // above: that branch makes the rest of the component behave
  // correctly even before this redirect lands; this one keeps the
  // address bar honest.
  useEffect(() => {
    if (
      routeOwner &&
      currentUsername &&
      routeOwner === currentUsername
    ) {
      const encoded = barePath
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')
      navigate(
        { pathname: encoded ? `/${encoded}` : '/', search: location.search },
        { replace: true },
      )
    }
  }, [routeOwner, currentUsername, barePath, navigate, location.search])

  const [resolved, setResolved] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'file'; path: string; canEdit: boolean }
    | { status: 'folder'; path: string; canEdit: boolean }
    | {
        status: 'missing'
        path: string
        reason: 'not-found' | 'forbidden'
        kind: 'file' | 'folder'
      }
  >({ status: 'idle' })

  // Heuristic for "this path looks like a file, not a folder" — a
  // trailing segment with a dot. Used to pick the right icon /
  // copy in the missing-path view when /api/resolve errors out.
  // (`.foo` dotfiles still look like files, which is fine; bare
  // folder names like `investments` correctly skip this branch.)
  const looksLikeFile = (rel: string) => {
    const last = rel.split('/').filter(Boolean).pop() ?? ''
    return last.length > 1 && last.includes('.')
  }

  useEffect(() => {
    if (tagFilter) {
      setResolved({ status: 'idle' })
      return
    }
    if (!barePath) {
      setResolved({ status: 'folder', path: '', canEdit: true })
      return
    }
    let cancelled = false
    setResolved({ status: 'loading' })
    api
      .resolve(barePath, ownerHint ? { owner: ownerHint } : undefined)
      .then((r) => {
        if (cancelled) return
        // Disambiguate bare-path access to a shared item. If the
        // resolver landed on a doc owned by someone else (because
        // it found an incoming share covering this path) AND the
        // URL doesn't carry `?owner=`, push the explicit form so
        // every downstream API call — including embedded-asset
        // fetches — can thread the owner through. Without this
        // self-correction, the same bare path that resolved to
        // the shared doc up here would re-resolve to the
        // requester's OWN doc at a deeper endpoint (asset bytes
        // fetched from /<asset>?via=…), which is the path clash
        // that broke shared images.
        if (
          !ownerHint &&
          currentUsername &&
          r.owner &&
          r.owner !== currentUsername
        ) {
          // Promote to the namespaced form `/u/<owner>/<path>`.
          // Cleaner than a `?owner=` query string and removes the
          // own-vs-shared collision at the URL layer: every
          // downstream link, breadcrumb, and embedded asset URL
          // carries the owner inherently.
          const encodedPath = barePath
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/')
          navigate(
            { pathname: `/u/${encodeURIComponent(r.owner)}/${encodedPath}`, search: location.search },
            { replace: true },
          )
          return
        }
        // canEdit is true for own vault, sharedEdit grants, or admin
        // (resolve returns `access.ownedByRequester` for the owner
        // case; the recipient case is gated on `sharedEdit`).
        const canEdit = r.access.ownedByRequester || r.access.sharedEdit
        setResolved(
          r.kind === 'file'
            ? { status: 'file', path: barePath, canEdit }
            : { status: 'folder', path: barePath, canEdit },
        )
      })
      .catch((e) => {
        if (cancelled) return
        // Any 404 / 403 / 401 from /api/resolve means the path
        // doesn't reach a real item — render the explicit missing
        // state for both files AND folders. The previous folder
        // fallback was misleading: it showed "This folder is
        // empty" with an upload affordance for paths the vault
        // had no record of (and the breadcrumb pretended every
        // parent segment existed). The kind drives the icon /
        // copy so a missing `.png` reads differently from a
        // missing `/project/foo`.
        const kind = looksLikeFile(barePath) ? 'file' : 'folder'
        if (e instanceof ApiError && e.status === 404) {
          setResolved({ status: 'missing', path: barePath, reason: 'not-found', kind })
        } else if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
          setResolved({ status: 'missing', path: barePath, reason: 'forbidden', kind })
        } else {
          setResolved({ status: 'folder', path: '', canEdit: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [barePath, tagFilter, ownerHint])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!e.dataTransfer?.files?.length) return
    uploadFiles(e.dataTransfer.files)
  }

  const isExternalFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') &&
    !e.dataTransfer.types.includes('application/x-reader-path')

  return (
    <div className="flex-1 flex overflow-hidden">
      <VaultSidebar />
      <main
        className="flex-1 overflow-hidden flex flex-col"
        onDragOver={(e) => {
          if (!isExternalFileDrag(e)) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={dragOver ? { boxShadow: 'inset 0 0 0 2px var(--accent)' } : undefined}
      >
        {tagFilter ? (
          <TaggedFilesView key={tagFilter} />
        ) : resolved.status === 'loading' ? (
          // Render the breadcrumb during resolve so the bar doesn't
          // pop in only after the network round-trip completes. We
          // already have everything needed to draw it (the URL
          // path, the owner hint) — the only thing we don't know
          // yet is whether the last segment is a file or a folder,
          // so the active crumb uses the file/folder heuristic.
          // Action buttons are intentionally omitted: PathViewer /
          // FolderGrid own those and they need real data first.
          <ResolvingBar
            barePath={barePath}
            ownerHint={ownerHint}
            currentUsername={currentUsername}
            navigate={navigate}
          />
        ) : resolved.status === 'file' ? (
          <PathViewer path={resolved.path} canEdit={resolved.canEdit} />
        ) : resolved.status === 'missing' ? (
          <MissingPathView
            path={resolved.path}
            kind={resolved.kind}
            reason={resolved.reason}
          />
        ) : (
          <FolderGrid
            initialPath={resolved.status === 'folder' ? resolved.path : ''}
            canEdit={resolved.status === 'folder' ? resolved.canEdit : true}
          />
        )}
      </main>
    </div>
  )
}

/**
 * Skeleton bar rendered while /api/resolve is in flight. Mirrors
 * the header layout used by PathViewer / FolderGrid so the page
 * doesn't jump when the real toolbar takes over.
 */
function ResolvingBar({
  barePath,
  ownerHint,
  currentUsername,
  navigate,
}: {
  barePath: string
  ownerHint: string | undefined
  currentUsername: string
  navigate: (to: string) => void
}) {
  // Detect file vs folder the same way the missing-state view
  // does so the active crumb shows the right icon while loading.
  const last = barePath.split('/').filter(Boolean).pop() ?? ''
  const isFile = last.length > 1 && last.includes('.')
  const parentDir = isFile
    ? barePath.split('/').slice(0, -1).join('/')
    : barePath
  const currentName = isFile ? last : undefined
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header
        className="min-h-11 px-3 py-1.5 flex items-center gap-2 border-b border-app shrink-0 flex-wrap"
        style={{ background: 'var(--surface-2)' }}
      >
        <PathBreadcrumb
          dir={parentDir}
          currentName={currentName}
          onNavigate={(dir) =>
            navigate(
              vaultUrl(dir, { owner: ownerHint, requester: currentUsername }),
            )
          }
          onBack={
            parentDir || currentName
              ? () =>
                  navigate(
                    vaultUrl(parentDir, {
                      owner: ownerHint,
                      requester: currentUsername,
                    }),
                  )
              : undefined
          }
          ownerLabel={ownerHint}
        />
      </header>
      <div className="flex-1" />
    </div>
  )
}

/**
 * Shown when a bare-path URL points at an item that resolve()
 * couldn't reach — either it isn't in the vault (404) or the
 * requester lacks the grant to read it (403/401). Replaces the
 * older folder-grid fallback for these cases, which mis-labelled
 * file paths with a folder icon and pretended nonexistent folders
 * were "empty and ready for upload".
 */
function MissingPathView({
  path,
  kind,
  reason,
}: {
  path: string
  kind: 'file' | 'folder'
  reason: 'not-found' | 'forbidden'
}) {
  const filename = path.split('/').pop() || path
  const Icon =
    reason === 'forbidden' ? Lock : kind === 'file' ? FileX : FolderX
  const title =
    reason === 'forbidden'
      ? 'You don’t have access'
      : kind === 'file'
        ? 'File not found'
        : 'Folder not found'
  const detail =
    reason === 'forbidden'
      ? kind === 'file'
        ? 'This file exists but isn’t shared with you directly. If it’s embedded in a document you can read, open the document and view it from there.'
        : 'This folder exists but isn’t shared with you.'
      : kind === 'file'
        ? 'The vault has no file at this path. It may have been moved, renamed, or deleted.'
        : 'The vault has no folder at this path. It may have been moved, renamed, or deleted.'
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div
          className="inline-flex items-center justify-center mb-4 w-12 h-12 rounded-full"
          style={{ background: 'var(--panel-2)' }}
        >
          <Icon size={20} style={{ color: 'var(--fg-subtle)' }} />
        </div>
        <h2 className="text-[15px] font-semibold mb-1.5" style={{ color: 'var(--fg)' }}>
          {title}
        </h2>
        <div className="text-[13px] mb-3" style={{ color: 'var(--fg-subtle)' }}>
          <span className="break-all">{filename}</span>
        </div>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--fg-subtle)' }}>
          {detail}
        </p>
      </div>
    </div>
  )
}
