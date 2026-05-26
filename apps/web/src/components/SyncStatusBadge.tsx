import { useState } from 'react'
import { CloudOff, RefreshCw, Loader2, AlertCircle, Check } from 'lucide-react'
import type { SyncStatus } from '../lib/sync/useSyncDrain'

type Props = {
  status: SyncStatus
}

/**
 * Compact connection-state chip rendered in the top bar.
 * Three primary states + a fourth for active drain:
 *   online + empty queue → hidden (no visual noise when everything is healthy)
 *   draining             → spinner + "Syncing"
 *   offline              → orange chip "Offline · N queued"
 *   online + pending     → "N queued" with retry button (server reachable
 *                         but a previous push failed; user can re-trigger)
 *   has errors           → red dot + detail in popover
 */
export function SyncStatusBadge({ status }: Props) {
  const [open, setOpen] = useState(false)
  if (
    status.online &&
    status.pending === 0 &&
    status.errors.length === 0 &&
    status.conflicts.length === 0 &&
    status.inboundConflicts.length === 0
  ) {
    return null
  }
  const tone = !status.online
    ? 'text-amber-500'
    : status.errors.length > 0
      ? 'text-rose-500'
      : 'text-accent'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost h-7 px-2 inline-flex items-center gap-1.5 text-[11.5px]"
        title={
          !status.online
            ? `Offline — ${status.pending} change${status.pending === 1 ? '' : 's'} queued`
            : status.draining
              ? 'Syncing pending changes…'
              : status.errors.length > 0
                ? `Sync errors — ${status.errors.length}`
                : `Online — ${status.pending} pending`
        }
      >
        {status.draining ? (
          <Loader2 size={12} className={`animate-spin ${tone}`} />
        ) : !status.online ? (
          <CloudOff size={12} className={tone} />
        ) : status.errors.length > 0 ? (
          <AlertCircle size={12} className={tone} />
        ) : status.pending > 0 ? (
          <RefreshCw size={12} className={tone} />
        ) : (
          <Check size={12} className={tone} />
        )}
        <span className={tone}>
          {!status.online
            ? `Offline · ${status.pending}`
            : status.draining
              ? 'Syncing'
              : status.errors.length > 0
                ? `${status.errors.length} sync error${status.errors.length === 1 ? '' : 's'}`
                : status.pending > 0
                  ? `${status.pending} queued`
                  : 'Synced'}
        </span>
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 w-72 rounded-md shadow-card z-50 text-[12px]"
          style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
        >
          <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="font-semibold text-fg">
              {status.online ? 'Sync' : 'Offline'}
            </div>
            <div className="text-subtle">
              {status.pending === 0
                ? 'No pending changes.'
                : `${status.pending} change${status.pending === 1 ? '' : 's'} waiting for the server.`}
            </div>
          </div>
          {status.conflicts.length > 0 && (
            <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="font-semibold text-fg mb-1">Conflicts from this device</div>
              <div className="space-y-1">
                {status.conflicts.map((c) => (
                  <div key={c.conflictPath} className="text-subtle">
                    <div className="text-fg truncate">{c.entityId}</div>
                    <div className="truncate">→ {c.conflictPath}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {status.inboundConflicts.length > 0 && (
            <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="font-semibold text-fg mb-1">Conflicts from other devices</div>
              <div className="space-y-1">
                {status.inboundConflicts.map((c) => (
                  <div key={c.path} className="text-subtle truncate">
                    {c.path}
                  </div>
                ))}
              </div>
            </div>
          )}
          {status.errors.length > 0 && (
            <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="font-semibold text-fg mb-1">Errors</div>
              <ul className="space-y-1 text-subtle">
                {status.errors.slice(0, 4).map((e) => (
                  <li key={e.clientOpId} className="truncate">{e.error}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="px-3 py-2 flex justify-end">
            <button
              type="button"
              className="btn-ghost h-6 px-2 text-[11.5px]"
              disabled={status.draining || !status.online}
              onClick={() => {
                setOpen(false)
                void status.drainNow()
              }}
              title={status.online ? 'Retry pending ops' : 'Connect to retry'}
            >
              {status.draining ? 'Syncing…' : 'Retry now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
