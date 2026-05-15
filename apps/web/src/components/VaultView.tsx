import { useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { PathViewer } from './PathViewer'
import { FolderGrid } from './FolderGrid'
import { TaggedFilesView } from './TaggedFilesView'
import { VaultSidebar } from './VaultSidebar'
import { useVault } from '../lib/vault-context'

export function VaultView() {
  const params = useParams()
  const location = useLocation()
  const openPath = (params['*'] || '').trim() || null
  const tagFilter = location.pathname.startsWith('/tags/') ? params.tag ?? null : null
  const { uploadFiles } = useVault()
  const [dragOver, setDragOver] = useState(false)

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
        {openPath ? (
          <PathViewer key={openPath} path={openPath} />
        ) : tagFilter ? (
          <TaggedFilesView key={tagFilter} />
        ) : (
          <FolderGrid />
        )}
      </main>
    </div>
  )
}
