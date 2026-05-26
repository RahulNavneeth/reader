import { useState } from 'react'
import { Archive, ArchiveRestore } from 'lucide-react'
import { api, type DocumentMeta } from '../lib/api'
import { enqueueAndTryDrain, isNetworkError } from '../lib/sync/helpers'

type Props = {
  path: string
  meta: DocumentMeta
  /** Fires after the server confirms — caller refetches the meta
   *  so the rest of the viewer reflects the new archived state. */
  onSaved?: (next: DocumentMeta) => void
}

/**
 * Toolbar archive/unarchive toggle. Hides a doc from default vault
 * listings and search without deleting it; one click flips it back.
 * Distinct from Pin (sidebar prominence) and Public (anonymous read)
 * — Archive is the "I'm done with this for now" gesture.
 *
 * Optimistic flip like PinButton: state moves on click, the API call
 * resolves in the background, server errors revert. Keeps the
 * toolbar feeling instant.
 */
export function ArchiveButton({ path, meta, onSaved }: Props) {
  const [busy, setBusy] = useState(false)
  const archived = !!meta.archived

  const toggle = async () => {
    if (busy) return
    setBusy(true)
    const next = !archived
    // Optimistic flip — icon updates immediately, irrespective of
    // whether we reach the server or end up queuing the op.
    onSaved?.({ ...meta, archived: next, archivedAt: next ? Date.now() : null })
    const queueOp = () =>
      enqueueAndTryDrain({
        entityId: path,
        kind: 'doc.archive',
        body: { archived: next },
      })
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await queueOp()
      setBusy(false)
      return
    }
    try {
      const r = await api.fileArchive(path, next)
      onSaved?.(r.document)
    } catch (e) {
      if (isNetworkError(e)) await queueOp()
      else onSaved?.(meta) // 403 / 409 / etc → revert optimistic.
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={toggle}
      title={archived ? 'Unarchive' : 'Archive — hide from default listings'}
      aria-label={archived ? 'Unarchive' : 'Archive'}
      disabled={busy}
      style={archived ? { color: 'var(--accent)', background: 'var(--selected)' } : undefined}
    >
      {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
    </button>
  )
}
