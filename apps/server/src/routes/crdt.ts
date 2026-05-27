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
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { leaseDoc } from '../services/crdtRegistry.js'
import { loadMeta, userCanEdit, userCanRead } from '../stores/documents.js'
import { findShareForPath } from '../stores/userShares.js'

const MESSAGE_SYNC = 0
// const MESSAGE_AWARENESS = 1  // Phase 3 work.

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
      // Auth: parse the session cookie via the same hook the rest
      // of the API uses. `req.currentUser` was populated by the
      // onRequest decorator before this handler ran.
      if (!req.currentUser) {
        socket.close(1008, 'authentication required')
        return
      }
      const user = req.currentUser
      const docId = req.params.docId
      const meta = await loadMeta(docId).catch(() => null)
      if (!meta) {
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
        if (!share) {
          socket.close(1008, 'forbidden')
          return
        }
        role = share.canEdit ? 'rw' : 'r'
      }

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

      socket.on('message', (raw: Buffer) => {
        // `raw` is whatever the client sent; framing matches the
        // outbound encoder we used above.
        try {
          const bytes = new Uint8Array(raw)
          const decoder = decoding.createDecoder(bytes)
          const messageType = decoding.readVarUint(decoder)
          if (messageType !== MESSAGE_SYNC) {
            // Awareness messages are Phase 3; ignoring them keeps
            // our pre-3 server tolerant of a client that already
            // sends presence ticks.
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
        const set = connectionsByDoc.get(docId)
        if (set) {
          set.delete(socket)
          if (set.size === 0) connectionsByDoc.delete(docId)
        }
        release()
      }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
    },
  )
}
