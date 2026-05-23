import { useEffect, useState } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router-dom'
import { PathViewer } from './PathViewer'
import { FolderGrid } from './FolderGrid'
import { TaggedFilesView } from './TaggedFilesView'
import { VaultSidebar } from './VaultSidebar'
import { useVault } from '../lib/vault-context'
import { ApiError, api } from '../lib/api'

export function VaultView() {
  const params = useParams()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const ownerHint = searchParams.get('owner') || undefined
  const tagFilter = location.pathname.startsWith('/tags/') ? params.tag ?? null : null
  const { uploadFiles } = useVault()
  const [dragOver, setDragOver] = useState(false)

  // Bare paths (no /docs or /folder prefix): a path can be either a file
  // or a folder, so we ask the server which one it is and dispatch the
  // right viewer. The cache key is the path itself — switching to a
  // different bare path triggers a re-resolve.
  const barePath = !tagFilter ? (params['*'] || '').trim() : ''
  const [resolved, setResolved] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'file'; path: string; canEdit: boolean }
    | { status: 'folder'; path: string; canEdit: boolean }
  >({ status: 'idle' })

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
        if (e instanceof ApiError && e.status === 404) {
          // 404 → fall back to folder view at the bare path; treat as
          // own-vault (canEdit=true) so the user can recover by
          // uploading etc.
          setResolved({ status: 'folder', path: barePath, canEdit: !ownerHint })
        } else if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
          // Forbidden / auth-required: keep the path so the error
          // surfaces in the folder view, but canEdit=false so we
          // don't render owner-only controls (and the chip reads
          // "read-only" instead of "edit").
          setResolved({ status: 'folder', path: barePath, canEdit: false })
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
          // Empty during resolve — avoids a spinner flash for what's
          // usually a <100ms /api/resolve round-trip.
          <div className="flex-1" />
        ) : resolved.status === 'file' ? (
          <PathViewer path={resolved.path} canEdit={resolved.canEdit} />
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
