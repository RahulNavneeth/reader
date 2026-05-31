import { useState } from 'react'
import { Loader2, Lock, Unlock } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

/**
 * Single-target lock toggle. Sibling to PinButton — when the doc /
 * folder is locked, every mutation on it (CRDT autosave, MCP edit,
 * /api/file/upload overwrite, delete, move) is refused server-side
 * until an owner / admin unlocks it.
 *
 * - Owner-only (the route enforces this; the parent decides whether
 *   to render the button at all).
 * - Confirms before locking + before unlocking so it's not a
 *   single-misclick footgun.
 */
export function LockButton({
  path,
  locked,
  ownerOpt,
  onChanged,
  isFolder,
}: {
  path: string
  locked: boolean
  ownerOpt?: string
  onChanged?: () => void | Promise<void>
  isFolder?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const click = async () => {
    if (busy) return
    const next = !locked
    const noun = isFolder ? 'folder' : 'file'
    const ok = await confirm({
      title: next ? `Lock this ${noun}?` : `Unlock this ${noun}?`,
      message: next
        ? `Locking freezes this ${noun}${
            isFolder ? ' and everything inside it' : ''
          }. Edits, deletes, and moves will be refused until you unlock.`
        : `Unlocking restores normal edit / delete / move on this ${noun}${
            isFolder ? ' and its descendants' : ''
          }.`,
      confirmLabel: next ? 'Lock' : 'Unlock',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.lockFile(path, next, { owner: ownerOpt })
      await onChanged?.()
    } catch (e) {
      void (e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={click}
      disabled={busy}
      title={locked ? 'Locked — click to unlock' : 'Lock'}
      aria-label={locked ? 'Unlock' : 'Lock'}
      style={locked ? { color: 'var(--accent)', background: 'var(--selected)' } : undefined}
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : locked ? (
        <Lock size={13} />
      ) : (
        <Unlock size={13} />
      )}
    </button>
  )
}

/**
 * Bulk variant — sibling to BulkArchiveButton. Takes a list of
 * paths (files and folders mixed) and toggles their lock state in
 * one call. The single-button shape (no "lock all" / "unlock all"
 * split) means the caller passes a `targetLocked` direction.
 */
export function BulkLockButton({
  paths,
  locked,
  showCount = false,
  onChanged,
}: {
  paths: string[]
  /** Direction of the bulk operation — true to lock the items in
   *  `paths`, false to unlock them. Caller chooses by bucketing
   *  the selection into currently-locked vs currently-unlocked
   *  subsets and rendering one button per subset (matches the
   *  Public/Private split). */
  locked: boolean
  /** Render the count next to the icon. Caller flips this on when
   *  both groups exist in the same selection so each button can
   *  show its own count, matching the Public/Private convention. */
  showCount?: boolean
  onChanged?: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const click = async () => {
    if (busy || paths.length === 0) return
    const ok = await confirm({
      title: locked
        ? `Lock ${paths.length} item${paths.length === 1 ? '' : 's'}?`
        : `Unlock ${paths.length} item${paths.length === 1 ? '' : 's'}?`,
      message: locked
        ? 'Locking freezes every selected file / folder (and anything inside the folders). Edits / deletes / moves will be refused until unlocked.'
        : 'Unlocking restores normal edit / delete / move on the selected items.',
      confirmLabel: locked ? 'Lock' : 'Unlock',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.bulkLock(paths, locked)
      await onChanged?.()
    } catch (e) {
      void (e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={click}
      disabled={busy || paths.length === 0}
      title={locked ? `Lock ${paths.length} selected` : `Unlock ${paths.length} selected`}
      aria-label={locked ? 'Lock selected' : 'Unlock selected'}
      style={!locked ? { color: 'var(--accent)', background: 'var(--selected)' } : undefined}
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : locked ? (
        <Lock size={13} />
      ) : (
        <Unlock size={13} />
      )}
      {showCount && paths.length > 1 && (
        <span className="text-[10px] font-semibold tabular-nums">
          {paths.length}
        </span>
      )}
    </button>
  )
}
