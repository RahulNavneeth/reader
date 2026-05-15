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
