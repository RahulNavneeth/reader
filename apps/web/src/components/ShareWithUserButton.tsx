import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Users, Loader2, ChevronDown, Pencil, Eye, Trash2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

type Props = {
  /** One or more vault-relative paths to share with a single recipient.
   *  Single-path callers pass a one-element array; bulk-select uses the
   *  selected paths so one recipient/permission combo lands grants for
   *  every selected item in one go. */
  paths: string[]
}

type ShareRow = {
  id: string
  recipient: string
  canEdit: boolean
  isFolder: boolean
  storageKey: string
}

/** Aggregated view for bulk mode — one row per (recipient, canEdit). */
type AggregatedShareRow = {
  recipient: string
  canEdit: boolean
  ids: string[]
  coveredCount: number
}

/**
 * Private user-to-user share control. Owner picks another username and
 * (optionally) grants edit access. The recipient sees each path in their
 * sidebar's "Shared with me" section. Supports bulk-share: paths.length
 * > 1 fans the create call out to every selected path.
 */
export function ShareWithUserButton({ paths }: Props) {
  const isBulk = paths.length > 1
  const primaryPath = paths[0]
  const [open, setOpen] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shares, setShares] = useState<ShareRow[] | null>(null)
  // Separate busy flag for row actions (permission toggle, revoke) so
  // they don't disable the unrelated "Share" submit button at the top
  // of the popover — that was causing a visible flicker on every chip
  // click.
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const resolvedAlign = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 340,
    open,
  })

  useEffect(() => {
    if (!open) return
    refresh()
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      const target = e.target as Element | null
      if (rootRef.current.contains(target as Node)) return
      // Per-row permission menu is portaled into <body>, so it's
      // outside rootRef. Treat clicks landing inside it as in-popover
      // so the parent doesn't slam shut while the user is choosing.
      if (target?.closest('[data-share-permission-menu]')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, primaryPath, isBulk])

  const pathSet = useMemo(() => new Set(paths), [paths])

  const refresh = async () => {
    try {
      const r = await api.listUserSharesFrom()
      const rows = r.shares
        .filter((s) => pathSet.has(s.storageKey))
        .map((s) => ({
          id: s.id,
          recipient: s.recipient,
          canEdit: s.canEdit,
          isFolder: s.isFolder,
          storageKey: s.storageKey,
        }))
      setShares(rows)
    } catch (e) {
      setShares([])
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  // Aggregate per (recipient, canEdit) so bulk users see "alice — 2 of 3
  // items (edit)" rather than three separate rows for the same person.
  const aggregated: AggregatedShareRow[] = useMemo(() => {
    if (!shares) return []
    const buckets = new Map<string, AggregatedShareRow>()
    for (const s of shares) {
      const key = `${s.recipient}::${s.canEdit ? 'edit' : 'read'}`
      const existing = buckets.get(key)
      if (existing) {
        existing.ids.push(s.id)
        existing.coveredCount++
      } else {
        buckets.set(key, {
          recipient: s.recipient,
          canEdit: s.canEdit,
          ids: [s.id],
          coveredCount: 1,
        })
      }
    }
    return Array.from(buckets.values()).sort((a, b) =>
      a.recipient.localeCompare(b.recipient),
    )
  }, [shares])

  const create = async () => {
    if (!recipient.trim()) return
    setBusy(true)
    setError(null)
    try {
      // Fan out per path. Continue on individual failures so one bad
      // path (e.g. recipient already has a grant on it) doesn't stop
      // the rest. Surface the first error if any happen.
      let firstErr: string | null = null
      for (const p of paths) {
        try {
          await api.createUserShare({ path: p, recipient: recipient.trim(), canEdit })
        } catch (e) {
          if (!firstErr) firstErr = e instanceof ApiError ? e.message : String(e)
        }
      }
      if (firstErr) setError(firstErr)
      setRecipient('')
      setCanEdit(false)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (ids: string[], rowKey: string) => {
    setRowBusy(rowKey)
    setError(null)
    try {
      for (const id of ids) {
        await api.deleteUserShare(id).catch(() => null)
      }
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRowBusy(null)
    }
  }

  /** Flip a recipient's permission across every selected path that
   *  has a grant for them. Server dedupes `(owner, recipient,
   *  storageKey)` so re-creating with the new canEdit updates the
   *  existing record in place. */
  const togglePermission = async (recipient: string, nextCanEdit: boolean, rowKey: string) => {
    if (!shares) return
    const targets = shares.filter((s) => s.recipient === recipient)
    setRowBusy(rowKey)
    setError(null)
    try {
      for (const t of targets) {
        await api.createUserShare({
          path: t.storageKey,
          recipient,
          canEdit: nextCanEdit,
        })
      }
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRowBusy(null)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Share with another user"
        aria-label="Share"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <Users size={13} />
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden flex flex-col"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            ...alignStyle(resolvedAlign),
          }}
        >
          {/* Inset sub-header bar to match the standard sub-panel
              pattern used by Similar documents / Chat dock / version
              banners — surface-2 strip with a bottom rule. */}
          <div
            className="flex items-center gap-2 px-3 h-8 shrink-0"
            style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' }}
          >
            <Users size={13} className="text-accent shrink-0" />
            <span className="text-[12px] font-semibold text-fg flex-1">
              {isBulk ? `Share ${paths.length} items` : 'Share with a user'}
            </span>
            {aggregated.length > 0 && (
              <span className="text-[10.5px] text-subtle">
                {aggregated.length} shared
              </span>
            )}
          </div>
          <div className="p-3 space-y-2">
            <input
              className="input h-8 text-[12.5px]"
              placeholder="Username"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              autoFocus
            />
            <label className="flex items-center gap-2 text-[12px] text-fg select-none cursor-pointer">
              <input
                type="checkbox"
                checked={canEdit}
                onChange={(e) => setCanEdit(e.target.checked)}
              />
              Allow this user to edit
            </label>
            <button
              className="btn-primary w-full h-8"
              onClick={create}
              disabled={busy || !recipient.trim()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />}
              Share
            </button>
            {error && (
              <div className="text-[11px]" style={{ color: 'var(--danger-fg)' }}>
                {error}
              </div>
            )}
          </div>
          {/* People list. Bordered top separates from the form,
              individual rows hover-tinted (no per-row borders so
              the list reads as a clean stack rather than a grid). */}
          <div
            className="max-h-[200px] overflow-y-auto"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            {shares == null ? (
              <div className="px-3 py-3 text-[11.5px] text-muted flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : aggregated.length === 0 ? (
              <div className="px-3 py-3 text-[11.5px] text-subtle text-center">
                {isBulk
                  ? 'None of the selected items are shared.'
                  : 'Not shared yet'}
              </div>
            ) : (
              <div>
                {aggregated.map((row) => {
                  const rowKey = `${row.recipient}-${row.canEdit ? 'e' : 'r'}`
                  const initial = row.recipient.slice(0, 1).toUpperCase()
                  const isBusy = rowBusy === rowKey
                  const coverage = isBulk
                    ? ` · ${row.coveredCount}/${paths.length}`
                    : ''
                  const hue =
                    Math.abs(
                      row.recipient
                        .split('')
                        .reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0),
                    ) % 360
                  return (
                    <ShareRow
                      key={rowKey}
                      recipient={row.recipient}
                      initial={initial}
                      avatarHue={hue}
                      coverage={coverage}
                      canEdit={row.canEdit}
                      busy={isBusy}
                      onSetEdit={() =>
                        !row.canEdit &&
                        togglePermission(row.recipient, true, rowKey)
                      }
                      onSetReadOnly={() =>
                        row.canEdit &&
                        togglePermission(row.recipient, false, rowKey)
                      }
                      onRevoke={() => revoke(row.ids, rowKey)}
                      revokeLabel={
                        row.ids.length > 1
                          ? `Remove all ${row.ids.length} grants`
                          : 'Remove access'
                      }
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One row in the shared-with list. Replaces the previous
 * "chip + X" pair with a single permission dropdown that
 * surfaces the three meaningful states inline (Google
 * Drive / Notion pattern):
 *
 *   • Can edit
 *   • View only
 *   • ────────
 *   • Remove access
 *
 * Reads as one obvious affordance per row instead of two
 * cramped controls.
 */
function ShareRow({
  recipient,
  initial,
  avatarHue,
  coverage,
  canEdit,
  busy,
  onSetEdit,
  onSetReadOnly,
  onRevoke,
  revokeLabel,
}: {
  recipient: string
  initial: string
  avatarHue: number
  coverage: string
  canEdit: boolean
  busy: boolean
  onSetEdit: () => void
  onSetReadOnly: () => void
  onRevoke: () => void
  revokeLabel: string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // Menu uses `position: fixed` so it escapes the popover's
  // `overflow-hidden` + the list's `overflow-y-auto` (both
  // would otherwise clip it). The trigger's bounding rect
  // anchors the menu top + right.
  const [menuPos, setMenuPos] = useState<{
    top: number
    left: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const MENU_WIDTH = 124
    setMenuPos({
      top: r.bottom + 4,
      left: Math.round((r.left + r.right) / 2 - MENU_WIDTH / 2),
    })
    setMenuOpen(true)
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span
        className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-semibold text-white shrink-0"
        style={{ background: `hsl(${avatarHue}, 60%, 50%)` }}
        aria-hidden="true"
      >
        {initial}
      </span>
      <span className="text-[12.5px] text-fg flex-1 truncate">
        {recipient}
        {coverage && (
          <span className="text-subtle text-[11.5px]">{coverage}</span>
        )}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center gap-1 text-[11.5px] font-medium h-7 px-2.5 rounded transition-colors hover:bg-[var(--hover)]"
        onClick={toggleMenu}
        disabled={busy}
        style={{ color: 'var(--fg-muted)' }}
        title="Change permission"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <>
            {canEdit ? 'Can edit' : 'View only'}
            <ChevronDown size={11} />
          </>
        )}
      </button>
      {menuOpen && menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-share-permission-menu
            className="rounded-md shadow-card overflow-hidden"
            style={{
              position: 'fixed',
              top: menuPos.top,
              left: menuPos.left,
              zIndex: 1000,
              width: 124,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
            }}
          >
            <button
              role="menuitem"
              type="button"
              className="w-full flex items-center gap-2 px-2 h-7 text-left text-[12px] hover:bg-[var(--hover)]"
              onClick={() => {
                setMenuOpen(false)
                onSetEdit()
              }}
              style={{
                background: canEdit ? 'var(--selected)' : 'transparent',
                color: canEdit ? 'var(--accent)' : 'var(--fg)',
              }}
            >
              <Pencil size={11} />
              <span>Can edit</span>
            </button>
            <button
              role="menuitem"
              type="button"
              className="w-full flex items-center gap-2 px-2 h-7 text-left text-[12px] hover:bg-[var(--hover)]"
              onClick={() => {
                setMenuOpen(false)
                onSetReadOnly()
              }}
              style={{
                background: !canEdit ? 'var(--selected)' : 'transparent',
                color: !canEdit ? 'var(--accent)' : 'var(--fg)',
              }}
            >
              <Eye size={11} />
              <span>View only</span>
            </button>
            <div style={{ borderTop: '1px solid var(--border)' }} />
            <button
              role="menuitem"
              type="button"
              aria-label={revokeLabel}
              className="w-full flex items-center gap-2 px-2 h-7 text-left text-[12px] hover:bg-[var(--danger-bg)]"
              onClick={() => {
                setMenuOpen(false)
                onRevoke()
              }}
              style={{ color: 'var(--danger-fg)' }}
            >
              <Trash2 size={11} />
              <span>Remove</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
