/**
 * Per-document Y.Doc lifecycle hook. For an open markdown doc this
 * wires up:
 *
 *   - A Y.Doc instance, scoped to the docId so different tabs of
 *     the same doc share state through the server relay.
 *   - `y-indexeddb` persistence so the doc survives a reload
 *     without a network round-trip — also gives us per-doc
 *     offline durability.
 *   - `y-websocket` connection to `/ws/crdt/:docId`, which speaks
 *     the standard y-protocols sync framing that the server
 *     route already implements.
 *   - Observation on `Y.Text('body')` so the caller's React
 *     state updates whenever the doc body changes — from this
 *     tab, another tab, or any future agent that mutates via
 *     CRDT deltas.
 *
 * Returns `null` when the hook is disabled (docId missing, doc
 * isn't markdown, user opted out). Callers must tolerate that.
 *
 * Bind one of these per open viewer. Do NOT instantiate at the
 * app root — the IndexedDB DB name encodes docId, so a shared
 * provider would mix up state.
 */
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Awareness } from 'y-protocols/awareness'
import * as awarenessProtocol from 'y-protocols/awareness'

const WS_BASE = (() => {
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
})()

export type CrdtBody = {
  /** Live markdown body text. Refreshes on every Y.Doc update.
   *  Use this for read surfaces that don't need a CodeMirror
   *  binding (the rendered markdown view). */
  text: string
  /** True after the first `synced` event from the WebSocket. Until
   *  then the local IndexedDB cache is the only source of truth. */
  synced: boolean
  /** True whenever the WebSocket transport is open — surfaces a
   *  "we're talking to the server" signal that's more reliable
   *  than `synced` for the toolbar's Autosaving / Offline pill.
   *  Some short-doc / already-synced reconnects never fire a
   *  fresh `sync` event (the syncStep2 reply is empty so the
   *  client treats it as a no-op), leaving `synced` stuck at
   *  `false` even though edits are flowing. */
  connected: boolean
  /** Imperative API for callers that want to write through the
   *  CRDT (Phase 4 chat/MCP-style operators). For pure read
   *  surfaces (the current PathViewer) this stays unused. */
  replace: (next: string) => void
  /** The Y.Doc itself. Editors (CodeMirror via y-codemirror.next)
   *  bind to `doc.getText('body')` directly so they get char-
   *  level deltas instead of whole-body replace. */
  doc: Y.Doc | null
  /** Awareness state shared with all peers connected to the same
   *  doc. y-codemirror.next renders remote cursors + selections
   *  out of this. Null until the WebsocketProvider is up. */
  awareness: Awareness | null
}

export function useCrdtBody(
  docId: string | null | undefined,
  enabled: boolean,
): CrdtBody | null {
  const [text, setText] = useState('')
  const [synced, setSynced] = useState(false)
  const [connected, setConnected] = useState(false)
  // Y.Doc + awareness live in state (not refs) because the
  // editor binds via React props and needs a render when they
  // (re)initialise. Refs would silently keep the editor pointed
  // at a dead Y.Doc across docId changes.
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [awareness, setAwareness] = useState<Awareness | null>(null)
  const docRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    if (!enabled || !docId) {
      setText('')
      setSynced(false)
      setConnected(false)
      setDoc(null)
      setAwareness(null)
      return
    }

    const doc = new Y.Doc()
    docRef.current = doc
    setDoc(doc)

    // Persistence: one IDB instance per docId. The IDB name is
    // namespaced so two open viewers for different docs don't
    // step on each other.
    const persistence = new IndexeddbPersistence(`reader-crdt-${docId}`, doc)

    // The hook is mounted before the WS transport finishes
    // syncing. Seed initial state from IndexedDB first so the
    // viewer doesn't briefly flash empty content between mount
    // and first `synced` event.
    persistence.whenSynced.then(() => {
      const ytext = doc.getText('body')
      if (ytext.length > 0) setText(ytext.toString())
    })

    // WebSocket transport — talks to `/ws/crdt/:docId` on the
    // backend. y-websocket handles reconnects + heartbeats; we
    // only need to listen for `status` and `synced`.
    const provider = new WebsocketProvider(`${WS_BASE}/ws/crdt`, docId, doc, {
      // Auth: the route gates on session cookie. The provider
      // doesn't pass cookies in WebSocket headers (browser
      // restriction), but cookies on the same origin ride
      // along with the upgrade request automatically.
      connect: true,
    })
    setAwareness(provider.awareness)
    // Intentionally DON'T seed an awareness state for view-mode
    // tabs. Two reasons:
    //   1. We don't have the signed-in username here without
    //      drilling auth state into the hook; using a random
    //      `tabId` as the name surfaced as "dnr3933q"-style
    //      ghosts in the other tab's Peers panel.
    //   2. Conceptually only edit-mode tabs are "editing now";
    //      a view-only reader doesn't belong in the peers list.
    // CrdtEditor publishes awareness when it mounts (with the
    // actual username + a hue-stable colour from the tab id), so
    // peers correctly populate from edit-mode tabs only.

    const onSync = (isSynced: boolean) => {
      setSynced(isSynced)
      if (isSynced) {
        // Initial sync done — refresh text in case the server's
        // state diverged from our IDB cache.
        setText(doc.getText('body').toString())
      }
    }
    provider.on('sync', onSync)
    // `status` fires { status: 'connected' | 'connecting' | 'disconnected' }
    // each time the WebSocket transitions. Drives the toolbar's
    // Autosaving / Offline label directly — `synced` can stay
    // false forever on a short-doc reconnect (no syncStep2 payload
    // to trigger the event) and would mislead the user.
    const onStatus = (s: { status: 'connected' | 'connecting' | 'disconnected' }) => {
      setConnected(s.status === 'connected')
    }
    provider.on('status', onStatus)
    // Seed the initial value in case the provider connects before
    // we attach the listener (y-websocket's connect is sync after
    // `connect: true`).
    setConnected((provider as unknown as { wsconnected?: boolean }).wsconnected ?? false)

    const ytext = doc.getText('body')
    const onUpdate = () => {
      setText(ytext.toString())
    }
    ytext.observe(onUpdate)

    // Hard-refresh cleanup: y-websocket registers its own
    // beforeunload, but the awareness-removal frame can lose the
    // race with TCP close. Send the explicit removeAwarenessStates
    // ourselves so the server's `applyAwarenessUpdate` runs before
    // the connection drops — eliminates the brief "ghost peer"
    // window between an unload and the staleness sweep.
    const onBeforeUnload = () => {
      try {
        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          [doc.clientID],
          'window unload',
        )
      } catch {/* best-effort during unload */}
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      ytext.unobserve(onUpdate)
      provider.off('sync', onSync)
      provider.off('status', onStatus)
      provider.disconnect()
      provider.destroy()
      persistence.destroy()
      doc.destroy()
      docRef.current = null
      setDoc(null)
      setAwareness(null)
      setConnected(false)
    }
  }, [docId, enabled])

  const replace = (next: string) => {
    const doc = docRef.current
    if (!doc) return
    doc.transact(() => {
      const ytext = doc.getText('body')
      ytext.delete(0, ytext.length)
      ytext.insert(0, next)
    }, 'replace')
  }

  if (!enabled || !docId) return null
  return { text, synced, connected, replace, doc, awareness }
}
