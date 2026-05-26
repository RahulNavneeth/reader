import { useEffect } from 'react'

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
  | { type: 'edit'; path: string; docId?: string }
  | { type: 'archive'; path: string; archived: boolean }

/**
 * Subscribe to the server's SSE stream. The browser EventSource auto-
 * reconnects with backoff, so we just need to wire one up per app mount and
 * forward each parsed event to the caller.
 *
 * Pass `enabled = false` to skip the connection (e.g., for anonymous routes).
 */
export function useReaderEvents(onEvent: (e: ReaderEvent) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    // `withCredentials` is the only way to send the session cookie from
    // EventSource (cross-origin doesn't apply in our same-origin setup but
    // some dev proxies trip on it).
    const es = new EventSource('/api/events', { withCredentials: true })
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as ReaderEvent
        onEvent(data)
      } catch {
        /* malformed — ignore */
      }
    }
    es.onerror = () => {
      // Let EventSource handle reconnects; nothing to do here aside from
      // not leaking the listener if onerror coincides with onclose.
    }
    return () => {
      es.close()
    }
  }, [enabled, onEvent])
}
