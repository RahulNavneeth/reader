/**
 * In-memory pub/sub for Server-Sent Events. Routes that mutate the corpus
 * (ingest, trash, visibility, tags, share) publish an event here; the SSE
 * route forwards them to subscribed clients so the UI can update without
 * polling.
 *
 * Intentionally simple: no replay buffer, no per-user scoping. Filtering and
 * access-control happens in the SSE route handler.
 */

export type ReaderEvent =
  | {
      type: 'ingest'
      path: string
      docId?: string
      status: 'extracting' | 'embedding' | 'ready' | 'failed' | 'no-text' | 'pending'
    }
  | { type: 'thumbnail'; path: string; docId?: string }
  | { type: 'preview'; path: string; docId?: string }
  | { type: 'visibility'; path: string; public: boolean }
  | { type: 'tags'; path: string; tags: string[] }
  | { type: 'trash'; path: string }
  | { type: 'restore'; path: string }
  /** Body bytes changed — MCP granular edits, chat apply-edit /
   *  apply-op, version restore, watcher pick-up of an external
   *  in-place edit. Path is vault-relative. Listeners (PathViewer,
   *  FolderGrid, sidebar tree) refetch their slice on this. */
  | { type: 'edit'; path: string; docId?: string }
  /** Archive flag flipped on a file or folder. */
  | { type: 'archive'; path: string; archived: boolean }
  /** Lock flag flipped on a file or folder. Empty `path` means
   *  bulk update — listeners should re-fetch their slice. */
  | { type: 'lock'; path: string; locked: boolean }
  /** Inline comment created / deleted / resolve-toggled. Path is
   *  the doc's vault-relative storageKey so the listener side can
   *  filter the same way it does for `edit`. */
  | {
      type: 'comment'
      path: string
      docId: string
      action: 'created' | 'deleted' | 'resolved' | 'reopened'
      author: string
    }

type Listener = (e: ReaderEvent) => void

const listeners = new Set<Listener>()

export function publish(event: ReaderEvent): void {
  for (const l of listeners) {
    try {
      l(event)
    } catch {
      /* keep delivering to the rest */
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function listenerCount(): number {
  return listeners.size
}
