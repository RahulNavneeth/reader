/**
 * WebSocket relay for the per-document Y.Doc. Speaks the standard
 * y-protocols framing so the off-the-shelf `y-websocket` client (or
 * any custom client built on `y-protocols/sync`) can attach without
 * any reader-specific knowledge.
 *
 * Endpoint:
 *   GET  /ws/crdt/:docId   (Upgrade: websocket)
 *
 * Auth: cookie-session, owner-only. Public docs and ACL-shared docs
 * are deferred — they need an extra "is the receiver allowed to
 * read/write at the CRDT layer" check that doesn't exist yet.
 *
 * Wire protocol (matches y-websocket):
 *
 *   message[0] = type tag (varint)
 *     0 → sync   — `y-protocols/sync` message follows
 *     1 → awareness (not yet — Phase 3)
 *     2 → auth (not yet — auth is at the upgrade handshake)
 *
 *   For sync:
 *     subtype 0 → syncStep1 (client sends state vector, expects diff)
 *     subtype 1 → syncStep2 (server replies with diff)
 *     subtype 2 → update     (either direction; broadcast to other peers)
 *
 * Each open WebSocket gets a Y.Doc lease from the registry. The
 * registry's update listener drives broadcasts to ALL connected
 * sockets for that docId; we filter out the origin connection so
 * a sender doesn't receive its own update back.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { leaseDoc, markEntryEditor } from '../services/crdtRegistry.js'
import { loadMeta, userCanEdit, userCanRead } from '../stores/documents.js'
import { findShareForPath } from '../stores/userShares.js'
import { config } from '../config.js'
import { getSession } from '../stores/sessions.js'
import { getUser } from '../stores/users.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/** One Awareness instance per docId. Tracks every connected
 *  peer's `user` state (name + colour) so we can relay updates +
 *  broadcast a clean removal when their socket closes — without
 *  this the OLD clientID's state hangs around forever and a tab
 *  refresh stacks ghosts in the Peers panel. */
const awarenessByDoc = new Map<string, awarenessProtocol.Awareness>()
function getAwareness(docId: string, doc: Y.Doc): awarenessProtocol.Awareness {
  let a = awarenessByDoc.get(docId)
  if (!a) {
    a = new awarenessProtocol.Awareness(doc)
    // Disable the internal staleness sweep. `y-protocols/awareness`
    // ships with a setInterval that removes states whose
    // `lastUpdated` is older than `outdatedTimeout` (default 30s).
    // The relay server doesn't refresh those timestamps itself —
    // it only applies updates that arrive over the wire — so a
    // brief client-side hiccup (network jitter, dev-mode HMR
    // pause) is enough to expire a peer and broadcast a fake
    // "left + rejoined" event. We track liveness explicitly via
    // socket-close handlers; the timer is pure noise here.
    const ai = a as unknown as { _checkInterval?: NodeJS.Timeout }
    if (ai._checkInterval) {
      clearInterval(ai._checkInterval)
      ai._checkInterval = undefined
    }
    awarenessByDoc.set(docId, a)
  }
  return a
}

/** Per-docId connection set so the update broadcaster knows who
 *  to fan out to. Map<docId, Set<WebSocket>>. */
const connectionsByDoc = new Map<string, Set<WebSocket>>()

function broadcast(docId: string, message: Uint8Array, origin: WebSocket): void {
  const peers = connectionsByDoc.get(docId)
  if (!peers) return
  for (const peer of peers) {
    if (peer === origin) continue
    if (peer.readyState !== 1 /* OPEN */) continue
    try {
      peer.send(message)
    } catch {
      /* peer is going down — let the close handler clean up. */
    }
  }
}

export async function crdtRoutes(app: FastifyInstance) {
  app.get<{ Params: { docId: string } }>(
    '/ws/crdt/:docId',
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest<{ Params: { docId: string } }>) => {
      // Auth: the auth plugin's preHandler hook ran during the
      // upgrade and SHOULD have populated `req.currentUser` from
      // the session cookie. In practice some upgrade paths (proxy
      // hop, hook ordering edge cases with @fastify/websocket)
      // leave currentUser null even with a valid cookie — and the
      // share recipient hitting Edit mode on a shared file is one
      // such surface (symptom: editor opens empty + "Offline"
      // pill, server logs `ws/crdt: no currentUser`). Fall back
      // to inline cookie re-parse before rejecting so a valid
      // cookie always lands.
      let user = req.currentUser
      if (!user) {
        try {
          const raw = req.cookies?.[config.session.cookieName]
          if (raw) {
            const unsigned = req.unsignCookie(raw)
            if (unsigned.valid && unsigned.value) {
              const session = await getSession(unsigned.value)
              if (session) {
                const u = await getUser(session.username)
                if (u && !u.disabled) user = u
              }
            }
          }
        } catch (e) {
          req.log.warn({ err: e }, 'ws/crdt: inline auth fallback errored')
        }
      }
      if (!user) {
        req.log.warn({ docId: req.params.docId }, 'ws/crdt: no currentUser')
        socket.close(1008, 'authentication required')
        return
      }
      const docId = req.params.docId
      const meta = await loadMeta(docId).catch(() => null)
      if (!meta) {
        req.log.warn({ docId, user: user.username }, 'ws/crdt: meta not found')
        socket.close(1008, 'document not found')
        return
      }
      // Permission resolution for the WS connection:
      //   - owner / admin / ACL editor → 'rw' (full bidirectional)
      //   - ACL reader, share recipient (read-only), or public-
      //     read → 'r' (receive updates, can't push them)
      //   - none of the above → 1008 close.
      //
      // Read-only is enforced at the message layer below: we
      // accept syncStep1 from `r` peers (they want state) and
      // silently drop syncStep2/update frames they try to send.
      // This means a reader who opens the editor sees live
      // updates from the writers without their own typing
      // leaking back into the doc.
      let role: 'rw' | 'r' = 'rw'
      if (userCanEdit(meta, user.username, user.role)) {
        role = 'rw'
      } else if (userCanRead(meta, user.username, user.role)) {
        role = 'r'
      } else {
        // Cross-owner share? Folder-cascade match counts.
        const share = await findShareForPath(
          user.username,
          meta.owner,
          meta.storageKey,
        ).catch(() => null)
        if (share) {
          role = share.canEdit ? 'rw' : 'r'
        } else {
          // No direct file/folder share — try collection grants.
          // A doc reachable via a shared collection should let
          // the recipient open the editor for the same level of
          // access the HTTP `resolveReadContext` already grants.
          // Without this fallback, collection-shared editors saw
          // the WS reject the upgrade and the editor stayed
          // "Offline" forever.
          const { grantsForUser } = await import(
            '../db/collectionsRepo.js'
          )
          const cg = grantsForUser(user.username)
          if (cg.editableDocs.has(docId)) {
            role = 'rw'
          } else if (cg.readableDocs.has(docId)) {
            role = 'r'
          } else {
            req.log.warn(
              {
                docId,
                user: user.username,
                metaOwner: meta.owner,
                role: user.role,
                aclEditors: meta.acl?.editors ?? [],
                aclReaders: meta.acl?.readers ?? [],
                cgEditableSize: cg.editableDocs.size,
                cgReadableSize: cg.readableDocs.size,
              },
              'ws/crdt: forbidden — no ACL, no share, no collection grant',
            )
            socket.close(1008, 'forbidden')
            return
          }
        }
      }
      req.log.info(
        { docId, user: user.username, role, metaOwner: meta.owner },
        'ws/crdt: connection accepted',
      )

      const { doc, release } = leaseDoc(docId, {
        owner: meta.owner,
        storageKey: meta.storageKey,
      })
      let peers = connectionsByDoc.get(docId)
      if (!peers) {
        peers = new Set()
        connectionsByDoc.set(docId, peers)
      }
      peers.add(socket)

      // Awareness — one instance per docId, tracked separately
      // from connections so stale clientIDs get cleaned up on
      // disconnect (otherwise refreshing a tab leaves a ghost
      // peer in the panel forever).
      const awareness = getAwareness(docId, doc)
      // Track the clientIDs this socket has contributed so we can
      // wipe just THIS connection's awareness rows on close —
      // important when a single socket sends updates for multiple
      // synthetic clients (which y-websocket doesn't, but the
      // contract supports).
      const ownedAwarenessIds = new Set<number>()
      const onAwarenessChange = (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        // Record clientIDs that came in through THIS socket so
        // close handler can wipe just them. y-websocket only
        // sends one clientID per connection, but we track every
        // touched id for safety.
        if (origin === socket) {
          for (const id of changes.added) ownedAwarenessIds.add(id)
          for (const id of changes.updated) ownedAwarenessIds.add(id)
          // Don't re-broadcast the sender's own update back to
          // them — they already have the state.
          return
        }
        const ids = [...changes.added, ...changes.updated, ...changes.removed]
        if (ids.length === 0) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, ids),
        )
        try {
          socket.send(encoding.toUint8Array(encoder))
        } catch {
          /* socket dying — close handler reaps. */
        }
      }
      awareness.on('change', onAwarenessChange)

      // Hook the Y.Doc's update event so server-side mutations
      // (including the one we just imported during hydration) get
      // pushed to all connected peers EXCEPT the one that caused
      // them.
      const onUpdate = (update: Uint8Array, origin: unknown) => {
        // `origin` is whatever was passed to `Y.applyUpdate(doc,
        // update, origin)`. We use the receiving WebSocket as the
        // origin tag, so updates coming in from peer A only fan
        // out to peers B, C, …
        if (origin === socket) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeUpdate(encoder, update)
        try {
          socket.send(encoding.toUint8Array(encoder))
        } catch {
          /* socket dying — close handler reaps. */
        }
      }
      doc.on('update', onUpdate)

      // Open with a Step 1: the server probes what the client
      // already has. The client responds with its state vector +
      // its own outstanding updates. Standard y-websocket dance.
      try {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeSyncStep1(encoder, doc)
        socket.send(encoding.toUint8Array(encoder))
      } catch {
        /* send failure here = client gone before handshake — let
         * the close handler clean up. */
      }
      // Also proactively push the server's full state as a syncStep2
      // frame. Defensive: some clients (observed: share recipients
      // opening Edit mode through the Vite proxy) never send their
      // own syncStep1 after open, so they'd otherwise never receive
      // the doc state — they only reply to ours with an empty step2
      // and the body never lands. Sending the full state regardless
      // is a small extra payload and idempotent on the client (Yjs
      // updates are CRDT-safe to apply twice).
      try {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeSyncStep2(encoder, doc)
        socket.send(encoding.toUint8Array(encoder))
      } catch {
        /* see above */
      }
      // Send the current awareness state of every OTHER peer to
      // the new connection so it immediately knows who else is
      // here.
      const liveClientIds = Array.from(awareness.getStates().keys())
      if (liveClientIds.length > 0) {
        try {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(awareness, liveClientIds),
          )
          socket.send(encoding.toUint8Array(encoder))
        } catch {
          /* gone */
        }
      }

      socket.on('message', (raw: Buffer) => {
        // `raw` is whatever the client sent; framing matches the
        // outbound encoder we used above.
        try {
          const bytes = new Uint8Array(raw)
          const decoder = decoding.createDecoder(bytes)
          const messageType = decoding.readVarUint(decoder)
          if (messageType === MESSAGE_AWARENESS) {
            // Read-only peers don't get to broadcast presence —
            // their typing was already dropped at the sync edge,
            // and silent cursors would be misleading.
            if (role === 'r') return
            const update = decoding.readVarUint8Array(decoder)
            // Apply locally — origin = socket. The change listener
            // above sees `origin === socket`, records the touched
            // clientIDs into ownedAwarenessIds, and skips
            // broadcasting back to the sender. Other connections'
            // change listeners fire with their own different
            // origins and DO broadcast the update outbound.
            awarenessProtocol.applyAwarenessUpdate(awareness, update, socket)
            return
          }
          if (messageType !== MESSAGE_SYNC) {
            // Unknown frame — drop silently.
            return
          }
          // Read-only enforcement: peek the sync subtype before
          // handing the decoder to `readSyncMessage`, which would
          // apply update bytes to the Y.Doc as a side effect.
          // We accept syncStep1 (the read-only peer requesting
          // state) but silently drop syncStep2 / update frames
          // they try to push. The peek uses a fresh decoder
          // because reading the varuint advances state.
          if (role === 'r') {
            const peek = decoding.createDecoder(bytes)
            decoding.readVarUint(peek) // skip MESSAGE_SYNC tag
            const subtype = decoding.readVarUint(peek)
            if (
              subtype === syncProtocol.messageYjsSyncStep2 ||
              subtype === syncProtocol.messageYjsUpdate
            ) {
              // No state mutation, no broadcast — read-only peer's
              // attempted edits just vanish at the relay edge.
              return
            }
          }
          const replyEncoder = encoding.createEncoder()
          encoding.writeVarUint(replyEncoder, MESSAGE_SYNC)
          // readSyncMessage handles step1/step2/update in-band;
          // it writes into replyEncoder if a reply is needed
          // (sync step 2 reply, ack, etc.).
          //
          // The transaction origin (4th arg) is the connection's
          // own socket — that's how `onUpdate` above knows not to
          // bounce this peer's own delta back at it.
          const messageType2 = syncProtocol.readSyncMessage(
            decoder,
            replyEncoder,
            doc,
            socket,
          )
          if (messageType2 === syncProtocol.messageYjsSyncStep1) {
            // Reply only when there's actually content past the
            // type tag — y-protocols' encoder writes the tag
            // unconditionally, so we check length > 1 byte.
            if (encoding.length(replyEncoder) > 1) {
              try { socket.send(encoding.toUint8Array(replyEncoder)) } catch { /* gone */ }
            }
          } else if (messageType2 === syncProtocol.messageYjsSyncStep2 ||
                     messageType2 === syncProtocol.messageYjsUpdate) {
            // The Y.Doc's update listener already broadcast to
            // the other peers; nothing more to do here.
            // Still: if readSyncMessage produced an ack, send it.
            if (encoding.length(replyEncoder) > 1) {
              try { socket.send(encoding.toUint8Array(replyEncoder)) } catch { /* gone */ }
            }
            // Tag the entry with this user so the eventual
            // debounced materialise can attribute its `crdt.autosave`
            // audit row + version snapshot to whoever's typing.
            // Read-only peers (role === 'r') don't reach this
            // branch because their update frames were dropped
            // above.
            markEntryEditor(docId, user.username)
            // Now broadcast the raw frame to other peers.
            broadcast(docId, new Uint8Array(raw), socket)
          }
        } catch {
          // Malformed frame — drop. A persistently bad client
          // gets the same treatment.
        }
      })

      const cleanup = () => {
        doc.off('update', onUpdate)
        awareness.off('change', onAwarenessChange)
        // Remove the awareness states this socket owned so other
        // peers' Peers panel stops showing the now-gone tab. This
        // was the actual stack-up-on-refresh fix — without it,
        // every closed connection left a ghost awareness row
        // behind that lived until the server restarted.
        if (ownedAwarenessIds.size > 0) {
          awarenessProtocol.removeAwarenessStates(
            awareness,
            Array.from(ownedAwarenessIds),
            socket,
          )
        }
        const set = connectionsByDoc.get(docId)
        if (set) {
          set.delete(socket)
          if (set.size === 0) {
            connectionsByDoc.delete(docId)
            // Drop the awareness instance too once the last peer
            // leaves — keeps memory tidy across long-lived doc
            // sessions and ensures the next attach starts clean.
            awarenessByDoc.delete(docId)
          }
        }
        release()
      }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
    },
  )
}
