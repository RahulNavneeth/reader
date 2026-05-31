/**
 * REST endpoints for per-doc inline comments.
 *
 *   GET    /api/comments?docId=…           list comments on a doc
 *   POST   /api/comments                   create
 *   POST   /api/comments/:id/resolve       toggle resolved flag
 *   DELETE /api/comments/:id?docId=…       delete (author or admin)
 *
 * Access: anyone who can read the doc can list/create comments;
 * delete is author-only (admins can override). Resolve is open to
 * any reader — comments are conversational, not authoritative.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  createComment,
  deleteComment,
  listComments,
  setCommentResolved,
} from '../stores/comments.js'
import { loadMeta, userCanRead } from '../stores/documents.js'
import { findShareForPath } from '../stores/userShares.js'
import { audit } from '../stores/audit.js'
import { publish } from '../services/events.js'

const createSchema = z.object({
  docId: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(4000),
  quote: z.string().trim().min(1).max(2000),
  rangeStart: z.number().int().nonnegative(),
  rangeEnd: z.number().int().nonnegative(),
})

async function canAccessDoc(
  docId: string,
  username: string,
  role: string,
): Promise<boolean> {
  const meta = await loadMeta(docId).catch(() => null)
  if (!meta) return false
  if (userCanRead(meta, username, role)) return true
  const share = await findShareForPath(
    username,
    meta.owner,
    meta.storageKey,
  ).catch(() => null)
  return !!share
}

export async function commentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)

  app.get('/api/comments', async (req, reply) => {
    const { docId } = req.query as { docId?: string }
    if (!docId) return reply.code(400).send({ error: 'missing docId' })
    const u = req.currentUser!
    if (!(await canAccessDoc(docId, u.username, u.role))) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const comments = await listComments(docId)
    // Sort oldest-first so threads read naturally in the panel.
    comments.sort((a, b) => a.createdAt - b.createdAt)
    return { comments }
  })

  app.post('/api/comments', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues })
    }
    const u = req.currentUser!
    const { docId, text, quote, rangeStart, rangeEnd } = parsed.data
    if (rangeEnd < rangeStart) {
      return reply.code(400).send({ error: 'rangeEnd must be >= rangeStart' })
    }
    if (!(await canAccessDoc(docId, u.username, u.role))) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const row = await createComment({
      docId,
      author: u.username,
      text,
      quote,
      rangeStart,
      rangeEnd,
    })
    const meta = await loadMeta(docId).catch(() => null)
    if (meta) {
      publish({
        type: 'comment',
        path: meta.storageKey,
        docId,
        action: 'created',
        author: u.username,
      })
      await audit({
        actor: u.username,
        action: 'comment.create',
        target: meta.storageKey,
        meta: {
          docId,
          commentId: row.id,
          quote: row.quote.slice(0, 80),
          text: row.text.slice(0, 200),
        },
      }).catch(() => null)
    }
    return reply.code(201).send({ comment: row })
  })

  app.post<{ Params: { id: string } }>(
    '/api/comments/:id/resolve',
    async (req, reply) => {
      const { id } = req.params
      const { docId, resolved } = (req.body ?? {}) as {
        docId?: string
        resolved?: boolean
      }
      if (!docId) return reply.code(400).send({ error: 'missing docId' })
      if (typeof resolved !== 'boolean') {
        return reply.code(400).send({ error: 'resolved must be boolean' })
      }
      const u = req.currentUser!
      if (!(await canAccessDoc(docId, u.username, u.role))) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      const row = await setCommentResolved(docId, id, resolved, u.username)
      if (!row) return reply.code(404).send({ error: 'comment not found' })
      const meta = await loadMeta(docId).catch(() => null)
      if (meta) {
        publish({
          type: 'comment',
          path: meta.storageKey,
          docId,
          action: resolved ? 'resolved' : 'reopened',
          author: u.username,
        })
        await audit({
          actor: u.username,
          action: resolved ? 'comment.resolve' : 'comment.reopen',
          target: meta.storageKey,
          meta: { docId, commentId: row.id },
        }).catch(() => null)
      }
      return { comment: row }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/comments/:id',
    async (req, reply) => {
      const { id } = req.params
      const { docId } = req.query as { docId?: string }
      if (!docId) return reply.code(400).send({ error: 'missing docId' })
      const u = req.currentUser!
      if (!(await canAccessDoc(docId, u.username, u.role))) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      // Author-or-admin enforcement. We look up the row first so a
      // non-author can't probe for existence via the delete code.
      const all = await listComments(docId)
      const target = all.find((c) => c.id === id)
      if (!target) return reply.code(404).send({ error: 'comment not found' })
      if (target.author !== u.username && u.role !== 'admin') {
        return reply.code(403).send({ error: 'only author or admin can delete' })
      }
      await deleteComment(docId, id)
      const meta = await loadMeta(docId).catch(() => null)
      if (meta) {
        publish({
          type: 'comment',
          path: meta.storageKey,
          docId,
          action: 'deleted',
          author: u.username,
        })
        await audit({
          actor: u.username,
          action: 'comment.delete',
          target: meta.storageKey,
          meta: { docId, commentId: id },
        }).catch(() => null)
      }
      return { ok: true }
    },
  )
}
