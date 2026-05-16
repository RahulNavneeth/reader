import { useEffect, useState } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
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
    | { status: 'file'; path: string }
    | { status: 'folder'; path: string }
  >({ status: 'idle' })

  useEffect(() => {
    if (tagFilter) {
      setResolved({ status: 'idle' })
      return
    }
    if (!barePath) {
      setResolved({ status: 'folder', path: '' })
      return
    }
    let cancelled = false
    setResolved({ status: 'loading' })
    api
      .resolve(barePath, ownerHint ? { owner: ownerHint } : undefined)
      .then((r) => {
        if (cancelled) return
        setResolved(
          r.kind === 'file'
            ? { status: 'file', path: barePath }
            : { status: 'folder', path: barePath },
        )
      })
      .catch((e) => {
        if (cancelled) return
        // 404 → fall back to folder view so the user lands on an empty
        // grid instead of a hard error if the path was, say, just
        // created on disk and not yet indexed.
        if (e instanceof ApiError && e.status === 404) {
          setResolved({ status: 'folder', path: barePath })
        } else {
          setResolved({ status: 'folder', path: '' })
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
          <div className="flex-1 flex items-center justify-center text-muted text-[12.5px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        ) : resolved.status === 'file' ? (
          <PathViewer key={resolved.path} path={resolved.path} />
        ) : (
          <FolderGrid initialPath={resolved.status === 'folder' ? resolved.path : ''} />
        )}
      </main>
    </div>
  )
}
