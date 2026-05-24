import { useEffect, useMemo, useRef, useState } from 'react'
import { Users, Loader2, X } from 'lucide-react'
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
      if (rootRef.current.contains(e.target as Node)) return
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
          className="absolute top-full mt-1 z-50 w-[340px] rounded-md shadow-card overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            ...alignStyle(resolvedAlign),
          }}
        >
          {/* Header bar mirrors MakePublicPopover so the two access
              affordances feel like the same component family — icon,
              title, status pill on the right showing current state. */}
          <div
            className="flex items-center gap-2 px-3 h-8"
            style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' }}
          >
            <Users size={13} className="text-muted" />
            <span className="text-[12px] font-semibold text-fg flex-1">
              {isBulk ? `Share ${paths.length} items` : 'Share with a user'}
            </span>
            <span className="text-[10.5px] text-subtle">
              {aggregated.length === 0
                ? 'Not shared'
                : `Shared with ${aggregated.length}`}
            </span>
          </div>
          <div className="p-3 space-y-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <input
              className="input h-7 text-[12.5px]"
              placeholder="Username"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              autoFocus
            />
            <label className="flex items-center gap-2 text-[12px] text-fg">
              <input
                type="checkbox"
                checked={canEdit}
                onChange={(e) => setCanEdit(e.target.checked)}
              />
              Allow this user to edit
            </label>
            <button
              className="btn-primary w-full h-7"
              onClick={create}
              disabled={busy || !recipient.trim()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />}
              Share
            </button>
            {error && (
              <div className="text-[11px]" style={{ color: '#BF2600' }}>
                {error}
              </div>
            )}
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            {shares == null ? (
              <div className="px-3 py-2 text-[11.5px] text-muted flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : aggregated.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-subtle">
                {isBulk
                  ? 'None of the selected items are shared.'
                  : 'Not shared with anyone yet.'}
              </div>
            ) : (
              aggregated.map((row) => {
                const coverage = isBulk
                  ? ` — ${row.coveredCount} of ${paths.length}`
                  : ''
                return (
                  <div
                    key={`${row.recipient}-${row.canEdit ? 'e' : 'r'}`}
                    className="flex items-center gap-2 px-3 py-1.5"
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <span className="text-[12px] text-fg flex-1 truncate">
                      {row.recipient}
                      <span className="text-subtle">{coverage}</span>
                    </span>
                    {/* Permission chip — click to flip. Server dedupes
                        on (owner, recipient, storageKey) so updating
                        an existing grant in place is just a
                        createUserShare with the new canEdit. */}
                    <button
                      className="text-[10.5px] font-medium px-1.5 h-5 rounded"
                      onClick={() =>
                        togglePermission(
                          row.recipient,
                          !row.canEdit,
                          `${row.recipient}-${row.canEdit ? 'e' : 'r'}`,
                        )
                      }
                      disabled={rowBusy === `${row.recipient}-${row.canEdit ? 'e' : 'r'}`}
                      title={`Click to switch to ${row.canEdit ? 'read-only' : 'edit'}`}
                      style={{
                        background: row.canEdit ? 'var(--selected)' : 'var(--bg)',
                        color: row.canEdit ? 'var(--accent)' : 'var(--fg)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {row.canEdit ? 'edit' : 'read-only'}
                    </button>
                    <button
                      className="btn-ghost h-6 w-6 px-0"
                      onClick={() =>
                        revoke(row.ids, `${row.recipient}-${row.canEdit ? 'e' : 'r'}`)
                      }
                      disabled={rowBusy === `${row.recipient}-${row.canEdit ? 'e' : 'r'}`}
                      title={
                        row.ids.length > 1
                          ? `Revoke all ${row.ids.length} grants`
                          : 'Revoke'
                      }
                      style={{ color: '#BF2600' }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
