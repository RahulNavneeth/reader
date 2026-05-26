import { useState } from 'react'
import { RefreshCw, Check, Loader2 } from 'lucide-react'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { useConfirm } from '../lib/confirm'

type Props = {
  meta: DocumentMeta
  onRefreshed?: (next: DocumentMeta) => void
}

/** Toolbar action for docs that were originally created from a
 *  template. Re-runs the engine with the stashed template + vars
 *  (built-ins like date / time / uuid recompute to "now"). The
 *  pre-refresh body is snapshotted to the versions store first, so
 *  the user has a one-click undo via the rail's version list. */
export function RefreshTemplateButton({ meta, onRefreshed }: Props) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only render for docs that carry template provenance. The
  // server returns 400 otherwise; rendering the button anyway
  // would just give the user a useless click target.
  if (!meta.templateSource) return null

  const handleClick = async () => {
    if (busy) return
    const ok = await confirm({
      title: 'Refresh from template?',
      message: `This will re-render the document from "${meta.templateSource!.template}" using the original variables. Built-ins like {{date}} update to now. The current version is snapshotted first so you can roll back.`,
      confirmLabel: 'Refresh',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.refreshTemplate(meta.id)
      onRefreshed?.(r.document)
      setFlash(true)
      setTimeout(() => setFlash(false), 1500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setTimeout(() => setError(null), 3500)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={handleClick}
      disabled={busy}
      title={
        error
          ? error
          : flash
            ? 'Refreshed'
            : `Re-render from ${meta.templateSource.template}`
      }
      aria-label="Refresh from template"
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : flash ? (
        <Check size={13} />
      ) : (
        <RefreshCw size={13} />
      )}
    </button>
  )
}
