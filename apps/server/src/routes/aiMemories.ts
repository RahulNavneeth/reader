/**
 * Memory CRUD + feedback endpoints for Reader AI.
 *
 *   GET    /api/ai-memories                          — list user memories
 *   POST   /api/ai-memories          {fact}          — add a permanent memory
 *   DELETE /api/ai-memories/:id                      — drop one
 *
 *   GET    /api/chat/:docId/ai-memories              — list doc-scoped memories
 *   POST   /api/chat/:docId/ai-memories {fact}       — add a doc memory
 *   DELETE /api/chat/:docId/ai-memories/:id          — drop one
 *
 *   POST   /api/chat/:docId/feedback {messageId, correction, wrongAnswer?, question}
 *                                                    — record a chat_error_note
 *                                                      from the 👎 button
 *
 * Distinct from the `/api/memories` "On this day" surface in
 * routes/memories.ts which serves photo throwbacks for the
 * Account dashboard — completely different feature, hence the
 * `ai-` prefix here. These do NOT gate on `config.ollama.chatEnabled`
 * — memories are user data, not LLM generation, and should be
 * manageable even when chat is disabled.
 */
import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import {
  addChatErrorNote,
  addDocMemory,
  addUserMemory,
  deleteDocMemory,
  deleteUserMemory,
  listDocMemories,
  listUserMemories,
} from '../db/memoriesRepo.js'

const FACT_MAX_CHARS = 1000

function trimFact(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.length > FACT_MAX_CHARS ? trimmed.slice(0, FACT_MAX_CHARS) : trimmed
}

export async function aiMemoriesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)

  // ── User-level (permanent) memories ────────────────────────────

  app.get('/api/ai-memories', async (req) => {
    const user = req.currentUser!
    const memories = listUserMemories(user.username)
    return { memories }
  })

  app.post<{ Body: { fact?: string } }>('/api/ai-memories', async (req, reply) => {
    const user = req.currentUser!
    const fact = trimFact(req.body?.fact)
    if (!fact) return reply.code(400).send({ error: 'fact required (non-empty string)' })
    const id = nanoid()
    const createdAt = Date.now()
    addUserMemory({
      id,
      userId: user.username,
      fact,
      source: 'user_command',
      createdAt,
    })
    return {
      memory: {
        id,
        userId: user.username,
        fact,
        source: 'user_command',
        usedCount: 0,
        createdAt,
      },
    }
  })

  app.delete<{ Params: { id: string } }>('/api/ai-memories/:id', async (req, reply) => {
    const user = req.currentUser!
    const ok = deleteUserMemory(req.params.id, user.username)
    if (!ok) return reply.code(404).send({ error: 'memory not found' })
    return { ok: true }
  })

  // ── Doc-scoped memories ────────────────────────────────────────

  app.get<{ Params: { docId: string } }>('/api/chat/:docId/ai-memories', async (req) => {
    const user = req.currentUser!
    const memories = listDocMemories(req.params.docId, user.username)
    return { memories }
  })

  app.post<{ Params: { docId: string }; Body: { fact?: string } }>(
    '/api/chat/:docId/ai-memories',
    async (req, reply) => {
      const user = req.currentUser!
      const fact = trimFact(req.body?.fact)
      if (!fact) return reply.code(400).send({ error: 'fact required (non-empty string)' })
      const id = nanoid()
      const docId = req.params.docId
      const createdAt = Date.now()
      addDocMemory({ id, docId, userId: user.username, fact, createdAt })
      return { memory: { id, docId, userId: user.username, fact, createdAt } }
    },
  )

  app.delete<{ Params: { docId: string; id: string } }>(
    '/api/chat/:docId/ai-memories/:id',
    async (req, reply) => {
      const user = req.currentUser!
      const ok = deleteDocMemory(req.params.id, req.params.docId, user.username)
      if (!ok) return reply.code(404).send({ error: 'memory not found' })
      return { ok: true }
    },
  )

  // ── Feedback / failure log ─────────────────────────────────────
  // Recorded when the user clicks 👎 on an assistant turn and
  // supplies a correction. `wrongAnswer` is optional — sometimes
  // the user wants to record just the correction.
  app.post<{
    Params: { docId: string }
    Body: { messageId?: string; correction?: string; wrongAnswer?: string; question?: string }
  }>('/api/chat/:docId/feedback', async (req, reply) => {
    const user = req.currentUser!
    const correction = trimFact(req.body?.correction)
    if (!correction) return reply.code(400).send({ error: 'correction required (non-empty string)' })
    const question = typeof req.body?.question === 'string' ? req.body.question.slice(0, 4000).trim() : ''
    if (!question) return reply.code(400).send({ error: 'question required (the original prompt being corrected)' })
    const wrongAnswer = typeof req.body?.wrongAnswer === 'string'
      ? req.body.wrongAnswer.slice(0, 4000)
      : null
    const id = nanoid()
    addChatErrorNote({
      id,
      userId: user.username,
      docId: req.params.docId,
      question,
      wrongAnswer,
      correction,
      createdAt: Date.now(),
    })
    return { note: { id, docId: req.params.docId, question, correction } }
  })
}
