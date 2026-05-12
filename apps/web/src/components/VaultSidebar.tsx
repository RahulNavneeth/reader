import { useCallback, useEffect, useMemo, useState } from 'react'
import { Filter, X, AlertCircle, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { useParams } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'
import { VaultTree } from './VaultTree'
import { useVault } from '../lib/vault-context'

/**
 * The left rail used by both VaultView and the workspace-settings page.
 *
 * Owns: tree fetch + filter + drag-drop upload zone. Inherits selection /
 * active path from the URL and the vault context, so the active file/folder is
 * always highlighted regardless of which page is rendered to the right of it.
 */
export function VaultSidebar() {
  const params = useParams()
  const openPath = (params['*'] || '').trim() || null
  const { uploadFiles, refreshNonce, uploadingName, vaultError, clearError, currentFolder } = useVault()
  const activePath = openPath ?? (currentFolder || null)

  const [tree, setTree] = useState<VaultNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const list = await api.list('')
      setTree(list.items)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch, refreshNonce])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!e.dataTransfer?.files?.length) return
    uploadFiles(e.dataTransfer.files)
  }

  const isExternalFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') &&
    !e.dataTransfer.types.includes('application/x-reader-path')

  const visibleTree = useMemo(() => {
    if (!tree) return tree
    const q = filter.trim().toLowerCase()
    if (!q) return tree
    return tree.filter((n) => n.name.toLowerCase().includes(q))
  }, [tree, filter])

  return (
    <aside className="panel border-r border-app overflow-y-auto shrink-0 w-[320px] flex flex-col">
      <div
        className="h-11 px-2 flex items-center border-b sticky top-0 z-10"
        style={{ background: 'var(--panel)', borderColor: 'var(--border-soft)' }}
      >
        <div className="relative w-full">
          <Filter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
          <input
            className="input pl-8 h-7 text-[12.5px]"
            placeholder="Filter files (⌘K for search)…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 btn-ghost h-5 w-5 px-0"
              onClick={() => setFilter('')}
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div
        className={clsx('flex-1 overflow-y-auto px-1 py-2', dragOver && 'ring-2 ring-inset')}
        style={dragOver ? { boxShadow: 'inset 0 0 0 2px var(--accent)' } : undefined}
        onDragOver={(e) => {
          if (!isExternalFileDrag(e)) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {!tree ? (
          <div className="px-3 py-2 text-[12.5px] text-muted">Loading…</div>
        ) : tree.length === 0 ? null : visibleTree && visibleTree.length === 0 ? (
          <div className="px-3 py-2 text-[12.5px] text-subtle">No files match "{filter}"</div>
        ) : (
          visibleTree?.map((node) => (
            <VaultTree
              key={node.path}
              node={node}
              depth={0}
              selectedPath={openPath}
              activePath={activePath}
            />
          ))
        )}

        {(uploadingName || vaultError || error) && (
          <div className="mt-2 mx-1 space-y-1.5">
            {uploadingName && (
              <div
                className="px-3 py-2 rounded text-[12.5px] flex items-center gap-2"
                style={{ background: 'var(--accent-bg)', color: 'var(--fg)' }}
              >
                <Loader2 size={13} className="animate-spin text-accent" />
                <span className="truncate">
                  Uploading <span className="font-medium">{uploadingName}</span>…
                </span>
              </div>
            )}
            {(vaultError || error) && (
              <div
                className="px-3 py-2 rounded text-[12.5px] flex items-center gap-2"
                style={{ background: '#FFEBE6', color: '#BF2600' }}
              >
                <AlertCircle size={13} />
                <span className="flex-1 truncate">{vaultError || error}</span>
                <button
                  onClick={() => {
                    setError(null)
                    clearError()
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
