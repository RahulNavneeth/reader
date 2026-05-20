/**
 * Per-document AI chat endpoints.
 *
 *   GET    /api/chat/:docId/messages   — load thread history
 *   POST   /api/chat/:docId/stream     — send a user message,
 *                                        streams assistant tokens via SSE,
 *                                        persists both messages on completion
 *   DELETE /api/chat/:docId            — wipe the thread for this user
 *
 * The streaming endpoint speaks Server-Sent Events — same shape the
 * rest of the app's live updates use. Event types:
 *   - `data: {"kind":"meta","citations":[...]}` (once, up front)
 *   - `data: {"kind":"token","token":"..."}`   (many, as model generates)
 *   - `data: {"kind":"done","messageId":"..."}` (final, after persist)
 *   - `data: {"kind":"error","error":"..."}`   (on failure)
 *
 * Why POST + SSE rather than EventSource: EventSource only does GET
 * with no body. Sending a long user query in a query string is ugly
 * (and trips URL-length limits); we read the body, then upgrade the
 * response to event-stream and stream tokens.
 */
import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { config } from '../config.js'
import {
  appendMessage,
  clearThread,
  deleteMessageById,
  listMessages,
  type ChatCitation,
  type ChatMessage,
  type MemoryUsed,
} from '../db/chatRepo.js'
import {
  addUserMemory,
  addDocMemory,
  deleteUserMemory,
  deleteDocMemory,
  listUserMemories,
  listDocMemories,
} from '../db/memoriesRepo.js'
import {
  assembleContext,
  buildOllamaMessages,
  ChatError,
  streamOllamaChat,
} from '../services/chat.js'

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireUser)
  // Server-wide kill switch. Admins can disable chat via settings
  // even when embeddings stay enabled — useful while picking a chat
  // model or to turn off any LLM generation entirely.
  app.addHook('preHandler', async (_req, reply) => {
    if (!config.ollama.chatEnabled) {
      reply.code(503).send({ error: 'AI chat is disabled by the administrator' })
    }
  })

  app.get<{ Params: { docId: string } }>('/api/chat/:docId/messages', async (req) => {
    const user = req.currentUser!
    const messages = listMessages(req.params.docId, user.username)
    return { messages }
  })

  app.delete<{ Params: { docId: string } }>('/api/chat/:docId', async (req) => {
    const user = req.currentUser!
    const cleared = clearThread(req.params.docId, user.username)
    return { cleared }
  })

  app.post<{
    Params: { docId: string }
    Body: { content?: string; regenerateOf?: string }
  }>('/api/chat/:docId/stream', async (req, reply) => {
    const user = req.currentUser!
    const docId = req.params.docId
    const content = String(req.body?.content ?? '').trim()
    const regenerateOf = req.body?.regenerateOf
      ? String(req.body.regenerateOf)
      : null
    if (!content) {
      return reply.code(400).send({ error: 'content required' })
    }
    if (content.length > 4000) {
      return reply.code(400).send({ error: 'message too long (max 4000 chars)' })
    }

    // ── Slash-command intercept ───────────────────────────────
    // Commands run synchronously against the memory repo, then
    // emit a synthetic chat turn so the user sees the action in
    // their thread history. No model call required.
    const slash = parseSlashCommand(content)
    if (slash && !regenerateOf) {
      const now = Date.now()
      // Persist the user turn so the command shows up in history
      // just like a normal message.
      const userMsgId = nanoid()
      appendMessage({
        id: userMsgId,
        docId,
        userId: user.username,
        role: 'user',
        content,
        citations: null,
        memoriesUsed: null,
        error: null,
        createdAt: now,
      })
      const reply_text = executeSlashCommand(slash, user.username, docId)
      const asstId = nanoid()
      appendMessage({
        id: asstId,
        docId,
        userId: user.username,
        role: 'assistant',
        content: reply_text,
        citations: null,
        memoriesUsed: null,
        error: null,
        createdAt: now + 1,
      })
      // Emit as SSE so the client uses its existing chatStream
      // consumer — no special-case branching needed on the client.
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const send = (obj: unknown) => {
        try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {/* ignore */}
      }
      send({ kind: 'meta', citations: [] })
      send({ kind: 'token', token: reply_text })
      send({ kind: 'done', messageId: asstId })
      try { reply.raw.end() } catch {/* ignore */}
      return
    }

    // Assemble context BEFORE flipping to SSE so we can return a
    // clean JSON 4xx/5xx if anchor-load or RAG fails. After this
    // point the body is event-stream and errors stream as events.
    let ctx
    let history: ChatMessage[]
    try {
      ctx = await assembleContext(docId, { username: user.username, role: user.role }, content)
      history = listMessages(docId, user.username)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to build chat context'
      const code = e instanceof ChatError && msg.includes('not allowed') ? 403 : 400
      return reply.code(code).send({ error: msg })
    }

    const now = Date.now()
    // When regenerating, we capture the original assistant turn's
    // createdAt so the new answer slots back into the same position
    // in chronological history — otherwise a fresh `Date.now()`
    // would push the regenerated turn to the bottom of a long
    // thread, far away from the question that produced it.
    let regenerateOriginalCreatedAt: number | null = null
    if (regenerateOf) {
      const idx = history.findIndex((m) => m.id === regenerateOf)
      if (idx >= 0) {
        regenerateOriginalCreatedAt = history[idx].createdAt
      }
      if (idx > 0) {
        // Strip the original Q + stale A from the prompt history so
        // the model isn't anchored on its previous answer or shown
        // the question twice (history Q1 + new user message also Q1).
        const prevUserIsImmediate = history[idx - 1]?.role === 'user'
        history = prevUserIsImmediate ? history.slice(0, idx - 1) : history.slice(0, idx)
      }
      deleteMessageById(regenerateOf, user.username, docId)
    } else {
      // Fresh question — persist the user turn up front so a
      // mid-stream disconnect still keeps the question in history.
      const userMsgId = nanoid()
      appendMessage({
        id: userMsgId,
        docId,
        userId: user.username,
        role: 'user',
        content,
        citations: null,
        memoriesUsed: null,
        error: null,
        createdAt: now,
      })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Roll up the memories the prompt builder will surface — this
    // gets streamed to the client in the meta event AND persisted
    // on the assistant turn so the "Used memory: …" footer survives
    // a history reload.
    const memoriesUsed: MemoryUsed[] = [
      ...ctx.permanentFacts.map((m) => ({ kind: 'user' as const, id: m.id, preview: m.fact })),
      ...ctx.docFacts.map((m) => ({ kind: 'doc' as const, id: m.id, preview: m.fact })),
      ...ctx.knownMistakes.map((n) => ({
        kind: 'mistake' as const,
        id: n.id,
        preview: `Q: ${n.question.slice(0, 80)}${n.question.length > 80 ? '…' : ''}`,
      })),
    ]

    // Citations include BOTH the open-doc match (primary) and the
    // cross-doc vault chunks. UI groups by primary/secondary so the
    // user can see which passage from the CURRENT document grounded
    // the answer — not just which other docs were referenced.
    const cap = (t: string) => (t.length > 600 ? t.slice(0, 600) + '…' : t)
    const citations: ChatCitation[] = [
      ...ctx.focusChunks.map((c) => ({
        docId: c.docId,
        chunkIdx: c.chunkIdx,
        score: c.score,
        docTitle: c.docTitle,
        docPath: c.docPath,
        text: cap(c.text),
        primary: true,
      })),
      ...ctx.ragChunks.map((c) => ({
        docId: c.docId,
        chunkIdx: c.chunkIdx,
        score: c.score,
        docTitle: c.docTitle,
        docPath: c.docPath,
        text: cap(c.text),
        primary: false,
      })),
    ]

    // CRITICAL: the Ollama generation must NOT be cancelled when
    // the client navigates away. Notion-AI-like UX requires that
    // a question's answer keeps generating in the background and
    // gets persisted, so returning to the file (or to another file
    // and back) shows the finished reply. We only stop *writing*
    // SSE frames on disconnect; the read loop keeps going and the
    // final assistant turn is persisted at the end.
    let clientGone = false
    const send = (obj: unknown) => {
      if (clientGone) return
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`)
      } catch {
        clientGone = true
      }
    }
    req.raw.on('close', () => {
      clientGone = true
    })

    send({ kind: 'meta', citations, memoriesUsed })

    // Hard cap on background generations so a runaway model can't
    // pin the worker forever. 5 min covers any 1024-token answer
    // on even slow local models.
    const ac = new AbortController()
    const hardTimeout = setTimeout(() => ac.abort(), 5 * 60_000)

    let assembled = ''
    let finished = false
    try {
      const messages = buildOllamaMessages(ctx, history, content)
      for await (const ev of streamOllamaChat(messages, ac.signal)) {
        if (ev.kind === 'token') {
          assembled += ev.token
          send({ kind: 'token', token: ev.token })
        } else {
          finished = true
        }
      }
    } catch (e) {
      clearTimeout(hardTimeout)
      const msg = e instanceof Error ? e.message : 'chat stream failed'
      // Persist the failure as an assistant turn so reloading the
      // page doesn't make the failed answer silently disappear —
      // the user sees their question followed by a clean error
      // panel, instead of a dangling YOU bubble.
      const errId = nanoid()
      appendMessage({
        id: errId,
        docId,
        userId: user.username,
        role: 'assistant',
        content: '',
        citations: null,
        memoriesUsed: null,
        error: msg,
        // Same in-place positioning rule as the success path.
        createdAt: regenerateOriginalCreatedAt ?? Date.now(),
      })
      send({ kind: 'error', error: msg, messageId: errId })
      try {
        reply.raw.end()
      } catch {
        /* already ended */
      }
      return
    }

    clearTimeout(hardTimeout)
    if (finished && assembled.length > 0) {
      const asstId = nanoid()
      appendMessage({
        id: asstId,
        docId,
        userId: user.username,
        role: 'assistant',
        content: assembled,
        citations: citations.length ? citations : null,
        memoriesUsed: memoriesUsed.length ? memoriesUsed : null,
        error: null,
        // Preserve the original assistant turn's timestamp on
        // regen so the new answer slots back into the same place
        // in history. Fresh answers use Date.now() as usual.
        createdAt: regenerateOriginalCreatedAt ?? Date.now(),
      })
      send({ kind: 'done', messageId: asstId })
    } else {
      // Streamed nothing useful — don't persist an empty assistant
      // row, but tell the client we're done so the UI can recover.
      send({ kind: 'done', messageId: null })
    }
    try {
      reply.raw.end()
    } catch {
      /* already ended */
    }
  })
}

// ── Slash command parser + executor ─────────────────────────────
// Recognized commands:
//   /remember <fact>      — persist a permanent user memory
//   /remember-here <fact> — persist a doc-scoped memory
//   /memories             — list all memories (user + this doc)
//   /forget <substring>   — delete memories matching the substring
//
// All four short-circuit the chat stream: the model is not called.
// The reply text is persisted as a synthetic assistant turn so the
// thread looks like a normal exchange.

export type SlashCommand =
  | { kind: 'remember'; fact: string }
  | { kind: 'remember-here'; fact: string }
  | { kind: 'memories' }
  | { kind: 'forget'; needle: string }

/** Detect + parse a slash command at the start of `content`. Returns
 *  null when the content isn't a command — caller falls through to
 *  the normal chat path. Whitespace before the slash is allowed
 *  (the user may paste with leading newlines). */
export function parseSlashCommand(content: string): SlashCommand | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('/')) return null
  // First token is the verb, rest is the argument.
  const spaceIdx = trimmed.search(/\s/)
  const verb = (spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
  const arg = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim()
  switch (verb) {
    case '/remember':
      if (!arg) return null // bare /remember falls through (treated as a normal model question)
      return { kind: 'remember', fact: arg }
    case '/remember-here':
      if (!arg) return null
      return { kind: 'remember-here', fact: arg }
    case '/memories':
      return { kind: 'memories' }
    case '/forget':
      if (!arg) return null
      return { kind: 'forget', needle: arg }
    default:
      return null
  }
}

/** Execute the command against the memory repo and return the
 *  assistant-side reply text that should be shown to the user. */
export function executeSlashCommand(
  cmd: SlashCommand,
  userId: string,
  docId: string,
): string {
  if (cmd.kind === 'remember') {
    addUserMemory({
      id: nanoid(),
      userId,
      fact: cmd.fact,
      source: 'user_command',
      createdAt: Date.now(),
    })
    return `✓ Saved as a permanent memory:\n\n> ${cmd.fact}`
  }
  if (cmd.kind === 'remember-here') {
    addDocMemory({
      id: nanoid(),
      docId,
      userId,
      fact: cmd.fact,
      createdAt: Date.now(),
    })
    return `✓ Saved as a memory for **this document**:\n\n> ${cmd.fact}`
  }
  if (cmd.kind === 'forget') {
    const needle = cmd.needle.toLowerCase()
    const userMatches = listUserMemories(userId).filter((m) =>
      m.fact.toLowerCase().includes(needle),
    )
    const docMatches = listDocMemories(docId, userId).filter((m) =>
      m.fact.toLowerCase().includes(needle),
    )
    if (userMatches.length === 0 && docMatches.length === 0) {
      return `No memory matched **"${cmd.needle}"**. Try \`/memories\` to see what's stored.`
    }
    for (const m of userMatches) deleteUserMemory(m.id, userId)
    for (const m of docMatches) deleteDocMemory(m.id, docId, userId)
    const lines = [
      `✓ Removed ${userMatches.length + docMatches.length} memory(ies):`,
      '',
      ...userMatches.map((m) => `- (user) ${m.fact}`),
      ...docMatches.map((m) => `- (this doc) ${m.fact}`),
    ]
    return lines.join('\n')
  }
  // cmd.kind === 'memories'
  const userMems = listUserMemories(userId)
  const docMems = listDocMemories(docId, userId)
  if (userMems.length === 0 && docMems.length === 0) {
    return [
      `No memories saved yet.`,
      ``,
      `Use \`/remember <fact>\` to save something that applies to every chat,`,
      `or \`/remember-here <fact>\` for facts specific to this document.`,
    ].join('\n')
  }
  const parts: string[] = []
  if (userMems.length > 0) {
    parts.push(`## Permanent memories (${userMems.length})`)
    for (const m of userMems) parts.push(`- ${m.fact}`)
  }
  if (docMems.length > 0) {
    if (parts.length > 0) parts.push('')
    parts.push(`## This document (${docMems.length})`)
    for (const m of docMems) parts.push(`- ${m.fact}`)
  }
  parts.push('')
  parts.push(`Remove one with \`/forget <substring>\`.`)
  return parts.join('\n')
}
