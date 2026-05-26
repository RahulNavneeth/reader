import { useState } from 'react'
import { Archive, ArchiveRestore, Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

/**
 * Bulk Archive trigger for the folder-grid selection toolbar.
 * Accepts a mix of files and folders — server cascades through any
 * folder paths and flips every doc inside them. One click + a
 * confirm so the user can't sleeve-archive a folder by accident.
 *
 * `mode` toggles the gesture and the icon: `archive` for hiding,
 * `unarchive` for restoring. Callers compute the mode from the
 * selection's archive state.
 */
export function BulkArchiveButton({
  paths,
  mode = 'archive',
  onChanged,
}: {
  paths: string[]
  mode?: 'archive' | 'unarchive'
  onChanged?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const archive = mode === 'archive'

  const click = async () => {
    if (paths.length === 0) return
    const ok = await confirm({
      title: archive
        ? `Archive ${paths.length} item${paths.length === 1 ? '' : 's'}?`
        : `Unarchive ${paths.length} item${paths.length === 1 ? '' : 's'}?`,
      message: archive
        ? 'Archived files vanish from your default vault, timeline, and search until you unarchive them. Folders cascade — every file under a selected folder gets archived too.'
        : 'Selected items return to your default vault listings and search.',
      confirmLabel: archive ? 'Archive' : 'Unarchive',
    })
    if (!ok) return
    setBusy(true)
    const queueAll = async () => {
      // Fan out into N individual doc.archive ops. The server's
      // bulk endpoint cascades through folders, but the push schema
      // only carries per-doc archive — folder cascade resolves
      // server-side on the next online run when the queued op
      // hits the per-file route.
      const { enqueueAndTryDrain } = await import('../lib/sync/helpers')
      for (const p of paths) {
        await enqueueAndTryDrain({
          entityId: p,
          kind: 'doc.archive',
          body: { archived: archive },
        })
      }
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await queueAll()
      onChanged?.()
      setBusy(false)
      return
    }
    try {
      await api.bulkArchive(paths, archive)
      onChanged?.()
    } catch (e) {
      const { isNetworkError } = await import('../lib/sync/helpers')
      if (isNetworkError(e)) {
        await queueAll()
        onChanged?.()
      } else {
        // Other 4xx/5xx — surface for the parent if it cares.
        void (e instanceof ApiError ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={click}
      disabled={busy || paths.length === 0}
      title={archive ? 'Archive selected' : 'Unarchive selected'}
      aria-label={archive ? 'Archive selected' : 'Unarchive selected'}
    >
      {busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : archive ? (
        <Archive size={12} />
      ) : (
        <ArchiveRestore size={12} />
      )}
    </button>
  )
}
