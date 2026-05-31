import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

type Props = {
  /** Paths to move to Trash. Accepts a mix of files and folders;
   *  the server cascades through folder paths into their files. */
  paths: string[]
  /** Override the confirm-dialog title. Defaults to "Move N items
   *  to Trash" / "Move folder to Trash" when paths.length === 1
   *  and that one path looks like a folder. */
  title?: string
  /** Override the confirm-dialog body. */
  message?: string
  /** Override the confirm button label. */
  confirmLabel?: string
  /** Fires AFTER the server confirms a successful delete. Use this
   *  to refresh state and (for the folder-self case) navigate to
   *  the parent — same shape as BulkArchiveButton.onChanged. */
  onDeleted?: () => void
  /** Fires when the server returns per-file failures or a network
   *  error. Receives a multi-line message. */
  onError?: (msg: string) => void
}

/**
 * Bulk Trash trigger — sibling to BulkArchiveButton. Wraps the
 * /api/file/bulk-delete call in a confirm dialog and surfaces as
 * a single icon button so it slots into any toolbar (folder-self
 * controls, selection toolbar, etc.) without duplicating the dialog
 * + spinner + error wiring at every call site.
 *
 * No offline queue: there's no `doc.delete` sync op (unlike archive),
 * so a delete attempted offline fails loudly via onError rather than
 * silently queueing and surprising the user later.
 */
export function BulkDeleteButton({
  paths,
  title,
  message,
  confirmLabel,
  onDeleted,
  onError,
}: Props) {
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const click = async () => {
    if (paths.length === 0) return
    const n = paths.length
    const defaultTitle =
      n === 1 ? 'Move to Trash' : `Move ${n} items to Trash`
    const defaultMessage =
      n === 1
        ? `"${paths[0].split('/').pop() || paths[0]}" and everything inside (if it's a folder) will be moved to Trash. You can restore items within the retention window.`
        : `${n} items will be moved to Trash. You can restore them within the retention window.`
    const ok = await confirm({
      title: title ?? defaultTitle,
      message: message ?? defaultMessage,
      confirmLabel: confirmLabel ?? 'Move to Trash',
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await api.bulkDelete(paths)
      if (r.failed > 0 && r.errors.length > 0) {
        const preview = r.errors
          .slice(0, 5)
          .map((e) => `• ${e.path} — ${e.reason}`)
          .join('\n')
        const more =
          r.errors.length > 5 ? `\n…and ${r.errors.length - 5} more` : ''
        onError?.(
          `${r.failed} item${r.failed === 1 ? '' : 's'} could not be deleted:\n${preview}${more}`,
        )
      }
      onDeleted?.()
    } catch (e) {
      onError?.(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={click}
      disabled={busy || paths.length === 0}
      title={n1Title(paths)}
      aria-label={n1Title(paths)}
      style={{ color: '#BF2600' }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
    </button>
  )
}

function n1Title(paths: string[]): string {
  if (paths.length === 1) return 'Move to Trash'
  return `Move ${paths.length} items to Trash`
}
