/**
 * BLOB-level CRUD for the per-document Yjs state.
 *
 *   crdt_state         — full encoded state (`Y.encodeStateAsUpdate(doc)`)
 *   crdt_state_vector  — light-weight vector clock for "you got my updates?"
 *                        probes; kept separate so the WebSocket attach
 *                        path doesn't have to decode the full state
 *                        just to compute a diff
 *   crdt_materialised_at — last time we flushed Y.Doc → markdown → disk
 *
 * Loose validation: callers pass `Buffer | Uint8Array`. We coerce to
 * `Buffer` on the way in (better-sqlite3 wants Buffer for BLOB params)
 * and return raw bytes on the way out.
 */
import { db } from './sqlite.js'

export type CrdtSnapshot = {
  /** Encoded full state, or null when no CRDT updates have landed yet. */
  state: Buffer | null
  stateVector: Buffer | null
  materialisedAt: number | null
}

export function loadCrdtState(docId: string): CrdtSnapshot {
  const row = db()
    .prepare(
      `SELECT crdt_state, crdt_state_vector, crdt_materialised_at
         FROM documents WHERE id = ?`,
    )
    .get(docId) as
    | {
        crdt_state: Buffer | null
        crdt_state_vector: Buffer | null
        crdt_materialised_at: number | null
      }
    | undefined
  if (!row) return { state: null, stateVector: null, materialisedAt: null }
  return {
    state: row.crdt_state,
    stateVector: row.crdt_state_vector,
    materialisedAt: row.crdt_materialised_at,
  }
}

export function saveCrdtState(
  docId: string,
  state: Uint8Array,
  stateVector: Uint8Array,
): void {
  db()
    .prepare(
      `UPDATE documents
         SET crdt_state = ?,
             crdt_state_vector = ?
       WHERE id = ?`,
    )
    .run(Buffer.from(state), Buffer.from(stateVector), docId)
}

export function markCrdtMaterialised(docId: string, ts: number): void {
  db()
    .prepare(`UPDATE documents SET crdt_materialised_at = ? WHERE id = ?`)
    .run(ts, docId)
}
