/**
 * Append-only log of mutations the offline-sync clients pull. Each row
 * captures one logical change (a file body update, a tag flip, an
 * archive toggle, …); clients track the last `lsn` they've seen and
 * resume from there.
 *
 * Idempotency: callers may supply a `clientOpId`. The unique index on
 * (owner, client_op_id) short-circuits a second append with the same
 * id and returns the original `lsn` — covers the "client retried a
 * push because it didn't hear back" case without double-applying.
 *
 * Payload is JSON-encoded. Shape per `kind` lives in
 * `services/syncChanges.ts` (the typed wrapper); this repo just
 * trusts the caller's payload + writes it through.
 */
import { db } from './sqlite.js'

export type SyncChangeRow = {
  lsn: number
  owner: string
  entityType: string
  entityId: string
  kind: string
  payload: unknown
  actor: string
  ts: number
  clientOpId: string | null
}

type RawRow = {
  lsn: number
  owner: string
  entity_type: string
  entity_id: string
  kind: string
  payload: string
  actor: string
  ts: number
  client_op_id: string | null
}

function fromRow(r: RawRow): SyncChangeRow {
  return {
    lsn: r.lsn,
    owner: r.owner,
    entityType: r.entity_type,
    entityId: r.entity_id,
    kind: r.kind,
    payload: r.payload ? JSON.parse(r.payload) : null,
    actor: r.actor,
    ts: r.ts,
    clientOpId: r.client_op_id,
  }
}

/** Append a change. Returns the new lsn, or — when `clientOpId`
 *  collides with an earlier successful append — the *original* lsn
 *  plus a `duplicate: true` flag so the caller can short-circuit
 *  re-application. */
export function appendChange(c: {
  owner: string
  entityType: string
  entityId: string
  kind: string
  payload: unknown
  actor: string
  clientOpId?: string | null
  ts?: number
}): { lsn: number; duplicate: boolean } {
  if (c.clientOpId) {
    const existing = db()
      .prepare(
        `SELECT lsn FROM sync_changes WHERE owner = ? AND client_op_id = ?`,
      )
      .get(c.owner, c.clientOpId) as { lsn: number } | undefined
    if (existing) return { lsn: existing.lsn, duplicate: true }
  }
  const ts = c.ts ?? Date.now()
  const info = db()
    .prepare(
      `INSERT INTO sync_changes (owner, entity_type, entity_id, kind, payload, actor, ts, client_op_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.owner,
      c.entityType,
      c.entityId,
      c.kind,
      JSON.stringify(c.payload),
      c.actor,
      ts,
      c.clientOpId ?? null,
    )
  return { lsn: Number(info.lastInsertRowid), duplicate: false }
}

/** Pull changes after `sinceLsn`, owner-scoped. Caller paginates
 *  with `limit`; the route exposes a `hasMore` hint so clients
 *  know to fetch again. Ordered by lsn ASC — apply-in-order is
 *  the invariant downstream code relies on. */
export function listChangesSince(
  owner: string,
  sinceLsn: number,
  limit: number,
): SyncChangeRow[] {
  const rows = db()
    .prepare(
      `SELECT lsn, owner, entity_type, entity_id, kind, payload, actor, ts, client_op_id
         FROM sync_changes
        WHERE owner = ? AND lsn > ?
        ORDER BY lsn ASC
        LIMIT ?`,
    )
    .all(owner, sinceLsn, limit) as RawRow[]
  return rows.map(fromRow)
}

/** The current head LSN for an owner. Used by clients pulling
 *  with `since=0` to discover where they should pick up next
 *  time without enumerating every change. */
export function maxLsnFor(owner: string): number {
  const r = db()
    .prepare(`SELECT MAX(lsn) AS m FROM sync_changes WHERE owner = ?`)
    .get(owner) as { m: number | null } | undefined
  return r?.m ?? 0
}
