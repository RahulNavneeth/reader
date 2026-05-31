/**
 * Typed facade over `db/syncChangesRepo.ts`. Every mutation route
 * funnels through these helpers so the on-disk schema (which is
 * deliberately loose — `kind` is a string, `payload` is a blob)
 * gets compile-time structure where it matters.
 *
 * The shape catalog is exhaustive — adding a new mutation kind
 * means extending `SyncChangeKind` here AND providing a record
 * helper. That's intentional friction; without it, an MCP tool
 * could quietly emit a half-formed payload that clients can't
 * replay.
 */
import {
  appendChange,
  listChangesSince,
  maxLsnFor,
  type SyncChangeRow,
} from '../db/syncChangesRepo.js'

export type SyncChangeKind =
  | 'doc.upsert'
  | 'doc.delete'
  | 'doc.move'
  | 'doc.tags'
  | 'doc.visibility'
  | 'doc.archive'
  | 'doc.lock'
  | 'doc.restore'
  | 'folder.mkdir'
  | 'folder.rmdir'
  | 'folder.archive'
  | 'folder.lock'

type Base = { owner: string; actor: string; clientOpId?: string | null }

type Payloads =
  | {
      kind: 'doc.upsert'
      /** sha256 after the write — the canonical body fingerprint. */
      sha256: string
      bytes: number
      /** Optional inline body. Phase 1 sends it for small docs so
       *  the client can replay the write locally; large docs skip
       *  this and the client refetches via /api/file/text. The
       *  threshold lives in the route, not here. */
      content?: string
      /** Source / context for audit-style filtering — same enum
       *  the webhook dispatcher uses (`chat`, `mcp`, `web`,
       *  `watcher`, `template`). */
      source?: 'web' | 'chat' | 'mcp' | 'watcher' | 'template' | 'template-refresh'
    }
  | { kind: 'doc.delete' }
  | { kind: 'doc.move'; from: string; to: string }
  | { kind: 'doc.tags'; tags: string[] }
  | {
      kind: 'doc.visibility'
      public: boolean
      expiresAt?: number | null
    }
  | { kind: 'doc.archive'; archived: boolean }
  | { kind: 'doc.lock'; locked: boolean }
  | { kind: 'doc.restore'; /** Trash-restore (NOT version restore). */ originalPath: string }
  | { kind: 'folder.mkdir' }
  | { kind: 'folder.rmdir'; recursive: boolean }
  | { kind: 'folder.archive'; archived: boolean }
  | { kind: 'folder.lock'; locked: boolean }

export type SyncChangePayload = Payloads

/** Record a mutation in the change log. Caller must have already
 *  applied the change to its primary storage (DB row / disk
 *  bytes); this only logs. */
export function recordChange(
  base: Base & {
    entityId: string
    payload: SyncChangePayload
  },
): { lsn: number; duplicate: boolean } {
  // entity_type is implied by the kind prefix — keep them in
  // sync so a query like `WHERE entity_type='folder'` works
  // without joining the kind column.
  const entityType = base.payload.kind.startsWith('folder.') ? 'folder' : 'doc'
  return appendChange({
    owner: base.owner,
    actor: base.actor,
    entityType,
    entityId: base.entityId,
    kind: base.payload.kind,
    payload: base.payload,
    clientOpId: base.clientOpId ?? null,
  })
}

export { listChangesSince, maxLsnFor }
export type { SyncChangeRow }
