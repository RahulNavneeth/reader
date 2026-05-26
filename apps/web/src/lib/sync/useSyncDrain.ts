import { useEffect, useRef, useState } from 'react'
import { listPending } from './queue'
import { useOnlineStatus } from './online'
import { drainQueue, type ReplayResult } from './replay'
import { pullSince, notableRows } from './pull'

export type SyncStatus = {
  online: boolean
  pending: number
  draining: boolean
  /** Conflicts surfaced during the last drain — the UI hangs onto
   *  these until the user dismisses or opens the conflict file. */
  conflicts: ReplayResult['conflicts']
  /** Last replay's error rows. Cleared on a clean drain. */
  errors: ReplayResult['errors']
  /** Conflict files this client learned about from the pull side
   *  — i.e. a different device of the same user uploaded a
   *  conflict sibling and we just discovered it. */
  inboundConflicts: { path: string; ts: number }[]
  /** Manual trigger from a UI button — does the same work as the
   *  automatic online-event hook. */
  drainNow: () => Promise<void>
}

/**
 * One-stop sync hook: tracks online state + queued count + replays
 * automatically when the network comes back. Components that need
 * to render the offline badge or surface conflicts call this once
 * and read the fields they care about.
 *
 * Mount in App.tsx so the auto-drain runs whether or not the user
 * is currently looking at the sync UI.
 */
export function useSyncDrain(
  enabled: boolean,
  /** Called whenever a pull-side catchup surfaces server changes
   *  (own offline replays, other devices' edits). Caller bumps
   *  whatever global "vault changed" nonce drives the file tree
   *  + folder grid refresh. Same callback the existing SSE
   *  pipeline uses, so a flood of pull rows compresses to one
   *  refresh. */
  onRemoteChanges?: () => void,
): SyncStatus {
  const online = useOnlineStatus()
  const [pending, setPending] = useState(0)
  const [draining, setDraining] = useState(false)
  const [conflicts, setConflicts] = useState<ReplayResult['conflicts']>([])
  const [errors, setErrors] = useState<ReplayResult['errors']>([])
  const [inboundConflicts, setInboundConflicts] = useState<
    { path: string; ts: number }[]
  >([])
  const lastOnlineRef = useRef(online)

  const refreshPending = async () => {
    try {
      const rows = await listPending()
      setPending(rows.length)
    } catch {
      // Likely IDB blocked or unavailable — treat as zero.
      setPending(0)
    }
  }

  const runDrain = async () => {
    if (!enabled) return
    setDraining(true)
    try {
      // Order matters: push our own queued ops FIRST. Otherwise
      // we'd pull a snapshot of the server (which doesn't yet
      // see our offline edits), wastefully refresh the UI, and
      // then push and refresh again. Push-then-pull gives the
      // caller one coherent refresh.
      const r = await drainQueue()
      if (r.conflicts.length) setConflicts((cur) => [...cur, ...r.conflicts])
      if (r.errors.length) setErrors(r.errors)
      else setErrors([])
      const pull = await pullSince()
      if (pull.count > 0) {
        onRemoteChanges?.()
        const conflicts = notableRows(pull.rows).map((row) => ({
          path: row.entityId,
          ts: row.ts,
        }))
        if (conflicts.length) {
          setInboundConflicts((cur) => [...cur, ...conflicts])
        }
      }
      await refreshPending()
    } finally {
      setDraining(false)
    }
  }

  // Initial pending-count poll + a poll every time `enabled`
  // changes (logout clears the queue, login should re-count).
  useEffect(() => {
    if (!enabled) {
      setPending(0)
      setConflicts([])
      setErrors([])
      setInboundConflicts([])
      return
    }
    void refreshPending()
  }, [enabled])

  // Replay on mount (catch a session that crashed mid-drain) +
  // whenever we transition from offline → online.
  useEffect(() => {
    if (!enabled) return
    if (online && !lastOnlineRef.current) {
      void runDrain()
    }
    lastOnlineRef.current = online
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, online])

  // Kick once on mount too — covers a fresh page load where the
  // online → offline transition never fires but pending ops exist.
  useEffect(() => {
    if (!enabled) return
    if (online) void runDrain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return {
    online,
    pending,
    draining,
    conflicts,
    errors,
    inboundConflicts,
    drainNow: runDrain,
  }
}
