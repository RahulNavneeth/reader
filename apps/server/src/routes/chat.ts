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
import { readFile, writeFile } from 'node:fs/promises'
import {
  appendMessage,
  clearThread,
  deleteMessageById,
  discardPendingEdit,
  findMessageByIdScoped,
  listMessages,
  markEditApplied,
  setPendingEdit,
  updateEditTargetSha,
  type ChatCitation,
  type ChatMessage,
  type MemoryUsed,
  type ProposedEditOp,
} from '../db/chatRepo.js'
import {
  createThread,
  deleteThread,
  getThread,
  listThreads,
  maybeAutoTitleFromMessage,
  renameThread,
  touchThread,
} from '../db/threadsRepo.js'
import {
  loadMeta,
  readText,
  saveMeta,
  sha256Of,
  userCanEdit,
  userCanRead,
} from '../stores/documents.js'
import { resolveUserVault } from '../lib/userVault.js'
import { withEditLock } from '../lib/editLock.js'
import { audit } from '../stores/audit.js'
import { ingestDocument } from '../services/ingest.js'
import * as mdx from '../lib/mdx.js'
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
  ChatError,
  detectEditIntent,
  extractQuotedExcerpt,
  locateHeadingForExcerpt,
} from '../services/chat.js'
import { runAgent } from '../services/agent.js'

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

  // ── Thread CRUD ────────────────────────────────────────────────
  // A "thread" is one named conversation inside a (doc, user) pair.
  // Multiple threads per doc per user are supported — the legacy
  // "one conversation per doc" world is just the case where the
  // user has exactly one thread.

  app.get<{ Params: { docId: string } }>('/api/chat/:docId/threads', async (req) => {
    const user = req.currentUser!
    const threads = listThreads(req.params.docId, user.username)
    return { threads }
  })

  app.post<{ Params: { docId: string }; Body: { title?: string } }>(
    '/api/chat/:docId/threads',
    async (req) => {
      const user = req.currentUser!
      const id = nanoid()
      const title = String(req.body?.title ?? '').trim() || 'New chat'
      const t = createThread({ id, docId: req.params.docId, userId: user.username, title })
      await audit({
        actor: user.username,
        action: 'chat.thread.create',
        target: req.params.docId,
        meta: { threadId: id, title },
      })
      return { thread: t }
    },
  )

  app.patch<{ Params: { docId: string; threadId: string }; Body: { title?: string } }>(
    '/api/chat/:docId/threads/:threadId',
    async (req, reply) => {
      const user = req.currentUser!
      const title = String(req.body?.title ?? '').trim()
      if (!title) return reply.code(400).send({ error: 'title required' })
      const ok = renameThread(req.params.threadId, user.username, req.params.docId, title)
      if (!ok) return reply.code(404).send({ error: 'thread not found' })
      await audit({
        actor: user.username,
        action: 'chat.thread.rename',
        target: req.params.docId,
        meta: { threadId: req.params.threadId, title },
      })
      return { ok: true }
    },
  )

  app.delete<{ Params: { docId: string; threadId: string } }>(
    '/api/chat/:docId/threads/:threadId',
    async (req, reply) => {
      const user = req.currentUser!
      const ok = deleteThread(req.params.threadId, user.username, req.params.docId)
      if (!ok) return reply.code(404).send({ error: 'thread not found' })
      await audit({
        actor: user.username,
        action: 'chat.thread.delete',
        target: req.params.docId,
        meta: { threadId: req.params.threadId },
      })
      return { ok: true }
    },
  )

  app.get<{ Params: { docId: string }; Querystring: { threadId?: string } }>(
    '/api/chat/:docId/messages',
    async (req, reply) => {
      const user = req.currentUser!
      const explicitThreadId = req.query?.threadId
      let threadId: string
      if (explicitThreadId) {
        // Verify the thread belongs to this user before returning
        // messages. Without this, a known thread id from another
        // user could be read by guessing it.
        const t = getThread(explicitThreadId, user.username)
        if (!t || t.docId !== req.params.docId) {
          return reply.code(404).send({ error: 'thread not found' })
        }
        threadId = t.id
      } else {
        // No threadId passed → default to the most-recently-active
        // thread for this (doc, user). Legacy clients that don't
        // know about threads keep working. Returns empty when the
        // user has never chatted on this doc.
        const existing = listThreads(req.params.docId, user.username)
        if (existing.length === 0) return { messages: [], threadId: null }
        threadId = existing[0].id
      }
      const messages = listMessages(req.params.docId, user.username, threadId)
      return { messages, threadId }
    },
  )

  app.delete<{ Params: { docId: string } }>('/api/chat/:docId', async (req) => {
    const user = req.currentUser!
    // Legacy "wipe all chat for this doc" endpoint. Wipes every
    // thread the user has on this doc — drops their messages AND
    // the thread rows so the switcher dropdown is empty afterwards.
    const cleared = clearThread(req.params.docId, user.username)
    for (const t of listThreads(req.params.docId, user.username)) {
      deleteThread(t.id, user.username, req.params.docId)
    }
    return { cleared }
  })

  // ── In-flight stream registry ──────────────────────────────────
  // Lets the cancel endpoint reach into an active /stream request
  // to abort the agent + flag the request as user-cancelled so the
  // post-stream block knows NOT to persist the partial. Keyed by
  // (docId, userId, threadId) — only one active stream per that
  // triple at a time (the client can't fire concurrent streams on
  // the same thread).
  type ActiveStream = {
    ac: AbortController
    /** Most-recent user-turn id this stream wrote. Null for
     *  regenerate flows (which don't add a new user turn). The
     *  cancel handler optionally deletes this so the user's
     *  question vanishes alongside the aborted answer. */
    userMsgId: string | null
    userAborted: boolean
  }
  const activeStreams = new Map<string, ActiveStream>()
  const streamKey = (docId: string, userId: string, threadId: string) =>
    `${docId}:${userId}:${threadId}`

  /** Delete a single chat message by id. Scoped to the caller via
   *  deleteMessageById's (id, userId, docId) WHERE clause so users
   *  can't drop one another's messages. Used by the client's
   *  "Edit question" flow which removes the old user + assistant
   *  pair before sending the edited question as a fresh turn. */
  app.delete<{
    Params: { docId: string; messageId: string }
  }>('/api/chat/:docId/messages/:messageId', async (req, reply) => {
    const user = req.currentUser!
    const ok = deleteMessageById(req.params.messageId, user.username, req.params.docId)
    if (!ok) return reply.code(404).send({ error: 'message not found' })
    return { ok: true }
  })

  app.post<{
    Params: { docId: string }
    Body: { threadId?: string; deleteUserTurn?: boolean }
  }>('/api/chat/:docId/cancel', async (req, reply) => {
    const user = req.currentUser!
    const threadId = req.body?.threadId ? String(req.body.threadId) : null
    if (!threadId) return reply.code(400).send({ error: 'threadId required' })
    const key = streamKey(req.params.docId, user.username, threadId)
    const entry = activeStreams.get(key)
    if (!entry) return { ok: true, found: false }
    entry.userAborted = true
    entry.ac.abort()
    // Optionally remove the user turn so the chat looks clean
    // after a Stop click — matches the user's expectation that
    // Stop = cancel the question entirely. Caller passes
    // deleteUserTurn:false to keep the question for editing.
    if ((req.body?.deleteUserTurn ?? true) && entry.userMsgId) {
      try {
        deleteMessageById(entry.userMsgId, user.username, req.params.docId)
      } catch {
        /* swallow */
      }
    }
    return { ok: true, found: true }
  })

  app.post<{
    Params: { docId: string }
    Body: {
      content?: string
      regenerateOf?: string
      threadId?: string
      /** Doc IDs the user @-mentioned in the composer. Their text
       *  is loaded server-side and handed to the agent as
       *  additional context so the model can reference docs that
       *  RAG might not have surfaced on its own. */
      attachedDocs?: string[]
    }
  }>('/api/chat/:docId/stream', async (req, reply) => {
    const user = req.currentUser!
    const docId = req.params.docId
    const content = String(req.body?.content ?? '').trim()
    const attachedDocIds = Array.isArray(req.body?.attachedDocs)
      ? req.body!.attachedDocs!.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const regenerateOf = req.body?.regenerateOf
      ? String(req.body.regenerateOf)
      : null
    if (!content) {
      return reply.code(400).send({ error: 'content required' })
    }
    if (content.length > 4000) {
      return reply.code(400).send({ error: 'message too long (max 4000 chars)' })
    }

    // Doc-existence + access check upfront. We need a valid doc
    // before either the slash-command branch (which persists to
    // chat_messages with an FK on doc_id) or the agent branch
    // (which calls assembleContext). Both paths used to discover
    // a missing doc via assembleContext, but that left the slash
    // branch using `activeThreadId` before it was assigned.
    {
      const preMeta = await loadMeta(docId).catch(() => null)
      if (!preMeta) {
        return reply.code(400).send({ error: `document not found: ${docId}` })
      }
      if (!userCanRead(preMeta, user.username, user.role)) {
        return reply.code(403).send({ error: 'not allowed to chat on this document' })
      }
    }

    // Resolve which thread we're writing into. Both branches below
    // (slash + agent) persist messages with this threadId, so we
    // resolve it here once.
    const requestedThreadId = req.body?.threadId ? String(req.body.threadId) : null
    let activeThreadId: string
    if (requestedThreadId) {
      const t = getThread(requestedThreadId, user.username)
      if (!t || t.docId !== docId) {
        return reply.code(404).send({ error: 'thread not found' })
      }
      activeThreadId = t.id
    } else {
      const existing = listThreads(docId, user.username)
      if (existing.length > 0) {
        activeThreadId = existing[0].id
      } else {
        activeThreadId = createThread({ id: nanoid(), docId, userId: user.username }).id
      }
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
        threadId: activeThreadId,
        role: 'user',
        content,
        citations: null,
        memoriesUsed: null,
        pendingEdit: null,
        editAppliedAt: null,
        editTargetSha256: null,
        toolTrace: null,
        error: null,
        createdAt: now,
      })
      const reply_text = executeSlashCommand(slash, user.username, docId)
      const asstId = nanoid()
      appendMessage({
        id: asstId,
        docId,
        userId: user.username,
        threadId: activeThreadId,
        role: 'assistant',
        content: reply_text,
        citations: null,
        memoriesUsed: null,
        pendingEdit: null,
        editAppliedAt: null,
        editTargetSha256: null,
        toolTrace: null,
        error: null,
        createdAt: now + 1,
      })
      touchThread(activeThreadId, user.username, docId)
      maybeAutoTitleFromMessage(activeThreadId, user.username, docId, content)
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
    try {
      ctx = await assembleContext(docId, { username: user.username, role: user.role }, content)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to build chat context'
      const code = e instanceof ChatError && msg.includes('not allowed') ? 403 : 400
      return reply.code(code).send({ error: msg })
    }

    let history: ChatMessage[]
    try {
      history = listMessages(docId, user.username, activeThreadId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to load thread'
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
    // ID of the new user turn we persisted up-front (fresh-question
    // path only). Captured so the cancel endpoint can delete the
    // user turn alongside the aborted answer when Stop is clicked.
    let newUserMsgId: string | null = null
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
      newUserMsgId = nanoid()
      appendMessage({
        id: newUserMsgId,
        docId,
        userId: user.username,
        threadId: activeThreadId,
        role: 'user',
        content,
        citations: null,
        memoriesUsed: null,
        pendingEdit: null,
        editAppliedAt: null,
        editTargetSha256: null,
        toolTrace: null,
        error: null,
        createdAt: now,
      })
      // Bump the thread's updated_at so it floats to the top of
      // the switcher dropdown, and rename "New chat" to a derived
      // title based on the first user message.
      touchThread(activeThreadId, user.username, docId)
      maybeAutoTitleFromMessage(activeThreadId, user.username, docId, content)
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

    // Resolve @-mentioned docs into title/path/text triples + push
    // each into citations so the Sources panel surfaces them.
    // Access control: silently drop IDs the user can't read.
    // Capped at 4 docs per turn so the prompt doesn't balloon.
    const ATTACH_LIMIT = 4
    const attachedDocsForPrompt: Array<{ title: string; path: string; text: string }> = []
    for (const id of attachedDocIds.slice(0, ATTACH_LIMIT)) {
      if (id === docId) continue // anchor is already in context
      try {
        const meta = await loadMeta(id)
        if (!meta) continue
        if (!userCanRead(meta, user.username, user.role)) continue
        const text = (await readText(id)) ?? ''
        if (!text) continue
        attachedDocsForPrompt.push({
          title: meta.title || meta.originalFilename || id,
          path: meta.storageKey || '',
          text,
        })
        citations.push({
          docId: meta.id,
          chunkIdx: -1,
          score: 1,
          docTitle: meta.title || meta.originalFilename || id,
          docPath: meta.storageKey,
          text: cap(text),
          primary: false,
        })
      } catch {
        /* skip unreadable / malformed */
      }
    }

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

    // Emit threadId in the meta event so the client can call
    // /cancel correctly even when this is the first turn of a
    // brand-new thread (where the client had activeThreadId=null
    // before sending).
    send({ kind: 'meta', citations, memoriesUsed, threadId: activeThreadId })

    // Hard cap on background generations so a runaway model can't
    // pin the worker forever. 5 min covers any 1024-token answer
    // on even slow local models.
    const ac = new AbortController()
    const hardTimeout = setTimeout(() => ac.abort(), 5 * 60_000)

    // Register this stream so /cancel can reach in and abort it.
    // Keyed by (docId, userId, threadId) — only one active stream
    // per that triple at a time.
    const myStreamKey = streamKey(docId, user.username, activeThreadId)
    const streamEntry: ActiveStream = {
      ac,
      userMsgId: newUserMsgId,
      userAborted: false,
    }
    activeStreams.set(myStreamKey, streamEntry)
    // Outer try/finally guarantees the registry entry is reaped
    // regardless of what happens below — including thrown
    // exceptions in pre-loop setup that the inner try/catch
    // wouldn't otherwise cover. Without this, a freak error would
    // leak the entry forever and the /cancel endpoint would still
    // see this thread as "in flight" for the rest of the process.
    try {

    // Agent loop — Ollama tool-calling. The model picks tools
    // (list_sections, search_doc, propose_edit, answer, …) instead
    // of generating a giant rules-driven single-shot response. Each
    // tool call streams as a `tool_call_start` / `tool_call_result`
    // event so the UI can render a "Reasoning" trace.
    let assembled = ''
    const collectedToolTrace: Array<{ id: string; name: string; args: unknown; ok?: boolean; summary?: string }> = []
    let collectedProposedEdits: ProposedEditOp[] = []
    let agentDone = false
    try {
      const gen = runAgent({
        anchor: ctx.anchor,
        docText: ctx.anchorTextFull,
        history,
        query: content,
        user: { username: user.username, role: user.role },
        signal: ac.signal,
        attachedDocs: attachedDocsForPrompt,
      })
      for await (const ev of gen) {
        if (ev.kind === 'token') {
          assembled += ev.token
          send({ kind: 'token', token: ev.token })
        } else if (ev.kind === 'tool_call_start') {
          collectedToolTrace.push({ id: ev.id, name: ev.name, args: ev.args })
          send({ kind: 'tool_call_start', id: ev.id, name: ev.name, args: ev.args })
        } else if (ev.kind === 'tool_call_result') {
          const entry = collectedToolTrace.find((t) => t.id === ev.id)
          if (entry) {
            entry.ok = ev.ok
            entry.summary = ev.summary
          }
          send({ kind: 'tool_call_result', id: ev.id, ok: ev.ok, summary: ev.summary })
        } else if (ev.kind === 'thinking_text') {
          send({ kind: 'thinking_text', text: ev.text })
        } else if (ev.kind === 'done') {
          agentDone = true
          collectedProposedEdits = ev.proposedEdits
          // If the model never streamed a `token` (e.g. it never
          // called `answer` and we synthesised the fallback message),
          // ensure `assembled` carries the final answer text.
          if (!assembled) assembled = ev.answer
        } else if (ev.kind === 'error') {
          throw new ChatError(ev.message)
        }
      }
    } catch (e) {
      clearTimeout(hardTimeout)
      activeStreams.delete(myStreamKey)
      // If the user explicitly cancelled via /cancel, /cancel
      // already deleted the user turn — don't persist an error
      // stub for the assistant turn either. Clean exit.
      if (streamEntry.userAborted) {
        try { reply.raw.end() } catch { /* already ended */ }
        return
      }
      const msg = e instanceof Error ? e.message : 'agent failed'
      const errId = nanoid()
      appendMessage({
        id: errId,
        docId,
        userId: user.username,
        threadId: activeThreadId,
        role: 'assistant',
        content: '',
        citations: null,
        memoriesUsed: null,
        pendingEdit: null,
        editAppliedAt: null,
        editTargetSha256: null,
        toolTrace: null,
        error: msg,
        createdAt: regenerateOriginalCreatedAt ?? Date.now(),
      })
      send({ kind: 'error', error: msg, messageId: errId })
      try { reply.raw.end() } catch { /* already ended */ }
      return
    }

    clearTimeout(hardTimeout)

    // Small-model safety net: if the user asked for an edit on a
    // Reply-quote (`> "…"` prefix) and the agent never produced a
    // proposed_edit (the 0.5–1.5b qwen2.5 models silently fail tool
    // calling and just return empty content), synthesise the edit
    // deterministically from the located heading. The model's
    // answer text — if any — becomes the new section body for a
    // rephrase/rewrite, or we strip the quoted line for a
    // remove/delete.
    if (collectedProposedEdits.length === 0 && detectEditIntent(content)) {
      const excerpt = extractQuotedExcerpt(content)
      const heading = excerpt && ctx.anchorTextFull
        ? locateHeadingForExcerpt(ctx.anchorTextFull, excerpt)
        : null
      if (heading && excerpt) {
        const lower = content.toLowerCase()
        const isRemoval =
          /\b(remove|delete|drop|strip|get rid of)\b/.test(lower)
        if (isRemoval) {
          // Pull the section's current body and remove the quoted
          // line(s). Fall back to a body that lacks the excerpt
          // entirely when partial-match removal is ambiguous.
          const fullText = ctx.anchorTextFull
          const sectionMatch = fullText.split('\n').reduce<{
            inSection: boolean
            startIdx: number
            endIdx: number
          }>(
            (acc, line, idx, arr) => {
              const isAtxHeading = /^\s{0,3}#{1,6}\s+/.test(line)
              if (acc.inSection && isAtxHeading) {
                return { ...acc, inSection: false, endIdx: idx }
              }
              if (!acc.inSection && isAtxHeading) {
                const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
                if (m && m[1].trim() === heading) {
                  return { inSection: true, startIdx: idx + 1, endIdx: arr.length }
                }
              }
              return acc
            },
            { inSection: false, startIdx: -1, endIdx: -1 },
          )
          if (sectionMatch.startIdx >= 0) {
            const lines = fullText.split('\n').slice(sectionMatch.startIdx, sectionMatch.endIdx)
            const needle = excerpt.replace(/\s+/g, ' ').trim()
            const filtered = lines.filter((line) => {
              const normalised = line.replace(/\s+/g, ' ').trim()
              return !normalised.includes(needle) && !needle.includes(normalised) || normalised === ''
            })
            const newBody = filtered.join('\n').trim()
            collectedProposedEdits = [{ op: 'replace_section', heading, content: newBody }]
            if (!assembled) {
              assembled = `Proposed removing the quoted line from the **${heading}** section. Review and Apply below.`
            }
          }
        } else if (assembled.length > 0) {
          // Rephrase / rewrite path: use the model's answer text
          // as the new section body. Strip a leading `Rephrase:` or
          // surrounding double-quotes if the model added them.
          const cleaned = assembled
            .replace(/^\s*(rephrase|rewrite|edit|fix|update|revised?|new version)\s*:\s*/i, '')
            .replace(/^\s*"([^]*?)"\s*$/, '$1')
            .trim()
          if (cleaned.length > 0) {
            collectedProposedEdits = [{ op: 'replace_section', heading, content: cleaned }]
          }
        }
      }
    }

    // Treat the agent as successful when it produced ANY artifact:
    // an answer text OR at least one proposed_edit. A queued edit
    // with no answer text is still a real outcome (the user gets a
    // diff card to Apply); the agent service synthesises a default
    // summary in that case so `assembled` is non-empty by the time
    // we get here, but we guard for proposed_edits too in case a
    // future agent change skips the synthesis path.
    activeStreams.delete(myStreamKey)
    // User cancelled via /cancel → skip persistence entirely. The
    // cancel endpoint already deleted the user turn; this skip
    // keeps the assistant side clean too.
    if (streamEntry.userAborted) {
      try { reply.raw.end() } catch { /* already ended */ }
      return
    }
    if (agentDone && (assembled.length > 0 || collectedProposedEdits.length > 0)) {
      const asstId = nanoid()
      appendMessage({
        id: asstId,
        docId,
        userId: user.username,
        threadId: activeThreadId,
        role: 'assistant',
        content: assembled,
        citations: citations.length ? citations : null,
        memoriesUsed: memoriesUsed.length ? memoriesUsed : null,
        error: null,
        pendingEdit: collectedProposedEdits.length > 0 ? collectedProposedEdits : null,
        editAppliedAt: null,
        editTargetSha256: collectedProposedEdits.length > 0 ? ctx.anchor.sha256 : null,
        toolTrace: collectedToolTrace.length > 0 ? collectedToolTrace : null,
        createdAt: regenerateOriginalCreatedAt ?? Date.now(),
      })
      send({ kind: 'done', messageId: asstId })
    } else {
      const stubId = nanoid()
      appendMessage({
        id: stubId,
        docId,
        userId: user.username,
        threadId: activeThreadId,
        role: 'assistant',
        content: '',
        citations: null,
        memoriesUsed: null,
        pendingEdit: null,
        editAppliedAt: null,
        editTargetSha256: null,
        toolTrace: null,
        error: 'The agent produced no answer. Try a simpler question, or switch to a larger chat model in Admin → Settings → Embeddings.',
        createdAt: regenerateOriginalCreatedAt ?? Date.now(),
      })
      send({ kind: 'done', messageId: stubId })
    }
    try {
      reply.raw.end()
    } catch {
      /* already ended */
    }

    } finally {
      // Always reap the registry entry — even if anything above
      // (including pre-loop setup or persistence) throws. The two
      // explicit delete()s inside this block are redundant with
      // this finally but harmless because Map.delete is idempotent;
      // leaving them in keeps the userAborted check semantics tight
      // (we want to know whether the user cancelled BEFORE we mark
      // the entry gone, since /cancel does a map.get → mutate).
      activeStreams.delete(myStreamKey)
    }
  })

  // ── Apply a pending edit ───────────────────────────────────────
  // POST /api/chat/:docId/apply-edit  { messageId }
  // Looks up the pending_edit JSON on the named assistant turn,
  // re-checks sha256 against the live doc (refuses on mismatch so
  // a stale model output can't silently overwrite a recent manual
  // edit), runs each op through lib/mdx.ts inside withEditLock,
  // writes the new bytes, re-ingests, marks the row applied.
  app.post<{
    Params: { docId: string }
    Body: { messageId?: string }
  }>('/api/chat/:docId/apply-edit', async (req, reply) => {
    const user = req.currentUser!
    const docId = req.params.docId
    const messageId = String(req.body?.messageId ?? '').trim()
    if (!messageId) {
      return reply.code(400).send({ error: 'messageId required' })
    }

    // Locate the pending edit. The message id is unique per
    // assistant turn; we look it up directly rather than scanning
    // all threads for the user.
    const turn = findMessageByIdScoped(messageId, user.username, docId)
    if (!turn) return reply.code(404).send({ error: 'message not found' })
    if (turn.role !== 'assistant') return reply.code(400).send({ error: 'not an assistant turn' })
    if (!turn.pendingEdit || turn.pendingEdit.length === 0) {
      return reply.code(400).send({ error: 'no pending edit on this turn' })
    }
    if (turn.editAppliedAt) {
      return reply.code(409).send({ error: 'edit already applied' })
    }

    // Permission + doc state.
    const meta = await loadMeta(docId)
    if (!meta) return reply.code(404).send({ error: 'document not found' })
    if (!userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'you do not have edit access on this document' })
    }

    // sha256 conflict check — pre-lock, so we fail fast.
    if (turn.editTargetSha256 && turn.editTargetSha256 !== meta.sha256) {
      return reply.code(409).send({
        error: 'document changed since this edit was proposed',
        code: 'sha_mismatch',
        proposedAgainst: turn.editTargetSha256,
        current: meta.sha256,
      })
    }

    const result = await withEditLock(docId, async () => {
      // Re-load inside the lock — another holder may have just
      // committed between our pre-check and acquiring the lock.
      const live = await loadMeta(docId)
      if (!live) throw Object.assign(new Error('document not found'), { status: 404 })
      if (turn.editTargetSha256 && turn.editTargetSha256 !== live.sha256) {
        throw Object.assign(new Error('document changed since this edit was proposed'), {
          status: 409,
          code: 'sha_mismatch',
        })
      }
      const abs = resolveUserVault(live.owner, live.storageKey)
      let buf: Buffer
      try {
        buf = await readFile(abs)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          throw Object.assign(new Error(`document file is missing on disk (${live.storageKey})`), { status: 404 })
        }
        throw e
      }
      // Apply each PENDING op in order. Ops already accepted via
      // the per-op preview flow carry their own appliedAt and are
      // skipped here — re-applying them would either no-op (if the
      // op is idempotent against the now-mutated section) or fail
      // outright (e.g. delete_section on a section that's already
      // gone). mdx helpers throw on a missing heading; we let those
      // bubble up as 422.
      let text = buf.toString('utf8')
      const now = Date.now()
      const stamped = turn.pendingEdit!.map((op) => {
        if (op.appliedAt) return op
        text = applyOp(text, op)
        return { ...op, appliedAt: now }
      })
      const nextBuf = Buffer.from(text, 'utf8')
      // Snapshot the PRE-edit state explicitly. The vault watcher
      // also fires snapshotVersion on the resulting file change,
      // but that race captures the NEW meta (because we call
      // saveMeta before the watcher reads). Calling it here
      // guarantees the snapshot reflects the state before this
      // Reader AI edit. Deduped by sha256 inside snapshotVersion,
      // so the watcher's subsequent fire is a no-op.
      {
        const { snapshotVersion } = await import('../stores/versions.js')
        await snapshotVersion(docId, {
          actor: user.username,
          source: 'reader-ai',
          reason: 'apply-edit',
        }).catch(() => null)
      }
      await writeFile(abs, nextBuf)
      const nextMeta = {
        ...live,
        bytes: nextBuf.length,
        sha256: sha256Of(nextBuf),
        updatedAt: Date.now(),
        ingest: { status: 'pending' as const, embedded: false },
      }
      await saveMeta(nextMeta)
      const finalMeta = await ingestDocument(nextMeta, nextBuf)
      // Persist the per-op appliedAt stamps, then mark the whole
      // turn applied so the message-level pill renders.
      setPendingEdit(messageId, user.username, docId, stamped)
      markEditApplied(messageId, user.username, docId)
      await audit({
        actor: user.username,
        action: 'chat.apply_edit',
        target: docId,
        meta: {
          path: live.storageKey,
          ops: turn.pendingEdit!.map((o) => o.op),
          messageId,
        },
      })
      return finalMeta
    }).catch((e) => {
      const status = (e as { status?: number }).status ?? 500
      const code = (e as { code?: string }).code
      reply.code(status).send({
        error: (e as Error).message ?? 'apply failed',
        ...(code ? { code } : {}),
      })
      return null
    })

    if (!result) return // error already sent
    return { ok: true, document: result }
  })

  // ── Preview a pending edit ─────────────────────────────────────
  // GET /api/chat/:docId/messages/:messageId/preview
  // Runs the same op pipeline as apply-edit but skips the write /
  // snapshot / re-ingest. Returns the would-be post-edit text so
  // the client can render an inline diff in the doc viewer
  // without committing the change.
  app.get<{
    Params: { docId: string; messageId: string }
  }>('/api/chat/:docId/messages/:messageId/preview', async (req, reply) => {
    const user = req.currentUser!
    const docId = req.params.docId
    const messageId = req.params.messageId

    const turn = findMessageByIdScoped(messageId, user.username, docId)
    if (!turn) return reply.code(404).send({ error: 'message not found' })
    if (turn.role !== 'assistant') {
      return reply.code(400).send({ error: 'not an assistant turn' })
    }
    if (!turn.pendingEdit || turn.pendingEdit.length === 0) {
      return reply.code(400).send({ error: 'no pending edit on this turn' })
    }

    const meta = await loadMeta(docId)
    if (!meta) return reply.code(404).send({ error: 'document not found' })
    // Preview is read-only; gate on read access (apply gates on
    // edit access). A user without edit rights still benefits from
    // seeing what the model proposed before they hand the chat to
    // someone who can apply it.
    if (!userCanRead(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'no access' })
    }

    const abs = resolveUserVault(meta.owner, meta.storageKey)
    let cur: string
    try {
      cur = await readFile(abs, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'document file is missing on disk' })
      }
      throw e
    }
    let next = cur
    // Per-op "would-be" texts — each unapplied op applied
    // INDIVIDUALLY against the live current text, NOT against the
    // cumulative post-previous-op state. The client uses these to
    // render a per-op diff alongside the in-doc hunk, so each op
    // can be accepted or discarded in isolation. Ops that already
    // carry an appliedAt (committed via earlier per-op flow) are
    // still surfaced in opPreviews so the client can show them as
    // "Applied" markers, but with `applied: true` and no diff —
    // they're not actionable.
    //
    // Known limitation: ops that touch overlapping regions show
    // independent diffs that don't account for each other. If
    // op[0] deletes a section and op[1] modifies the same section,
    // op[1]'s preview will (correctly, against current text) show
    // the modification — but accepting op[0] first will then make
    // op[1]'s server-side apply fail with a "section not found"
    // error. We surface that failure inline via opError on the
    // hunk, so the user still gets a clear signal. Overlapping
    // proposals are rare in practice (the model usually proposes
    // disjoint section edits).
    const opPreviews: Array<{
      op: unknown
      next: string
      error?: string
      applied?: boolean
    }> = []
    try {
      for (const op of turn.pendingEdit) {
        if (op.appliedAt) continue
        next = applyOp(next, op)
      }
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message ?? 'preview failed' })
    }
    for (const op of turn.pendingEdit) {
      if (op.appliedAt) {
        opPreviews.push({ op, next: cur, applied: true })
        continue
      }
      try {
        const single = applyOp(cur, op)
        opPreviews.push({ op, next: single })
      } catch (e) {
        opPreviews.push({ op, next: cur, error: (e as Error).message ?? 'op preview failed' })
      }
    }
    return { current: cur, next, sha256: meta.sha256, opPreviews }
  })

  // ── Apply a single op ──────────────────────────────────────────
  // POST /api/chat/:docId/apply-op  { messageId, opIndex }
  // Applies just one op from the turn's pendingEdit array against
  // the current doc text. The op gets an inline `appliedAt` stamp
  // (NOT removed from the array — the UI keeps showing "Applied
  // to <heading>" pills for every op the model proposed, in order).
  // When the last unapplied op gets stamped, the whole turn flips
  // to edit_applied_at as well, matching the chat card's bulk apply
  // behavior. sha256 is rechecked under the lock + re-stamped after
  // a partial apply so the next per-op call's sha-check passes.
  app.post<{
    Params: { docId: string }
    Body: { messageId?: string; opIndex?: number }
  }>('/api/chat/:docId/apply-op', async (req, reply) => {
    const user = req.currentUser!
    const docId = req.params.docId
    const messageId = String(req.body?.messageId ?? '').trim()
    const opIndex = Number(req.body?.opIndex)
    if (!messageId || !Number.isInteger(opIndex) || opIndex < 0) {
      return reply.code(400).send({ error: 'messageId and opIndex (≥ 0) required' })
    }

    const turn = findMessageByIdScoped(messageId, user.username, docId)
    if (!turn) return reply.code(404).send({ error: 'message not found' })
    if (turn.role !== 'assistant') {
      return reply.code(400).send({ error: 'not an assistant turn' })
    }
    if (!turn.pendingEdit || turn.pendingEdit.length === 0) {
      return reply.code(400).send({ error: 'no pending edit on this turn' })
    }
    if (turn.editAppliedAt) {
      return reply.code(409).send({ error: 'edit already applied' })
    }
    if (opIndex >= turn.pendingEdit.length) {
      return reply.code(400).send({ error: 'opIndex out of range' })
    }
    if (turn.pendingEdit[opIndex]?.appliedAt) {
      return reply.code(409).send({ error: 'op already applied' })
    }

    const meta = await loadMeta(docId)
    if (!meta) return reply.code(404).send({ error: 'document not found' })
    if (!userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'you do not have edit access on this document' })
    }
    if (turn.editTargetSha256 && turn.editTargetSha256 !== meta.sha256) {
      return reply.code(409).send({
        error: 'document changed since this edit was proposed',
        code: 'sha_mismatch',
      })
    }

    const result = await withEditLock(docId, async () => {
      // Re-fetch the turn INSIDE the lock so we act on the latest
      // pending_edit array, not the snapshot we read before locking.
      // Without this, a parallel apply-op or discard-op on the same
      // turn could land between our outer read and our write, and
      // our write would silently drop the other call's mutation
      // (lost-update race).
      const freshTurn = findMessageByIdScoped(messageId, user.username, docId)
      if (!freshTurn) throw Object.assign(new Error('message not found'), { status: 404 })
      if (freshTurn.role !== 'assistant') {
        throw Object.assign(new Error('not an assistant turn'), { status: 400 })
      }
      if (!freshTurn.pendingEdit || freshTurn.pendingEdit.length === 0) {
        throw Object.assign(new Error('no pending edit on this turn'), { status: 400 })
      }
      if (freshTurn.editAppliedAt) {
        throw Object.assign(new Error('edit already applied'), { status: 409 })
      }
      if (opIndex >= freshTurn.pendingEdit.length) {
        throw Object.assign(new Error('opIndex out of range'), { status: 400 })
      }
      if (freshTurn.pendingEdit[opIndex]?.appliedAt) {
        throw Object.assign(new Error('op already applied'), { status: 409 })
      }
      const live = await loadMeta(docId)
      if (!live) throw Object.assign(new Error('document not found'), { status: 404 })
      if (freshTurn.editTargetSha256 && freshTurn.editTargetSha256 !== live.sha256) {
        throw Object.assign(new Error('document changed since this edit was proposed'), {
          status: 409,
          code: 'sha_mismatch',
        })
      }
      const abs = resolveUserVault(live.owner, live.storageKey)
      const buf = await readFile(abs)
      const op = freshTurn.pendingEdit[opIndex]
      const nextText = applyOp(buf.toString('utf8'), op)
      const nextBuf = Buffer.from(nextText, 'utf8')
      {
        const { snapshotVersion } = await import('../stores/versions.js')
        await snapshotVersion(docId, {
          actor: user.username,
          source: 'reader-ai',
          reason: 'apply-op',
        }).catch(() => null)
      }
      await writeFile(abs, nextBuf)
      const newSha = sha256Of(nextBuf)
      const nextMeta = {
        ...live,
        bytes: nextBuf.length,
        sha256: newSha,
        updatedAt: Date.now(),
        ingest: { status: 'pending' as const, embedded: false },
      }
      await saveMeta(nextMeta)
      const finalMeta = await ingestDocument(nextMeta, nextBuf)
      // Stamp THIS op as applied, preserve the array shape. If every
      // op now carries an appliedAt, flip the message-level applied
      // flag (matches bulk apply-edit semantics).
      const now = Date.now()
      const stamped = freshTurn.pendingEdit.map((o, i) =>
        i === opIndex ? { ...o, appliedAt: now } : o,
      )
      setPendingEdit(messageId, user.username, docId, stamped)
      const allApplied = stamped.every((o) => o.appliedAt)
      if (allApplied) {
        markEditApplied(messageId, user.username, docId)
      } else {
        // More ops remain. Re-anchor the sha-check baseline so the
        // next per-op apply doesn't trip the (now stale) original
        // sha256 — that was bug #1 of the audit.
        updateEditTargetSha(messageId, user.username, docId, newSha)
      }
      await audit({
        actor: user.username,
        action: 'chat.apply_edit_op',
        target: docId,
        meta: {
          path: live.storageKey,
          op: (op as { op: string }).op,
          opIndex,
          messageId,
        },
      })
      return finalMeta
    }).catch((e) => {
      const status = (e as { status?: number }).status ?? 500
      const code = (e as { code?: string }).code
      reply.code(status).send({
        error: (e as Error).message ?? 'apply failed',
        ...(code ? { code } : {}),
      })
      return null
    })

    if (!result) return
    return { ok: true, document: result }
  })

  // ── Discard a single op ────────────────────────────────────────
  // DELETE /api/chat/:docId/pending-edit/:messageId/op/:opIndex
  // Removes one op from the turn's pendingEdit array without
  // applying it. Discards (unlike per-op applies) actually shrink
  // the array — a discarded op isn't history-worthy, the user
  // explicitly rejected it. When the array empties AND no ops were
  // applied yet, the whole pending_edit field is NULLed (card
  // disappears). When it empties AFTER some applies, we still flip
  // edit_applied_at so the message displays "applied" pills for
  // the ones that did land.
  app.delete<{
    Params: { docId: string; messageId: string; opIndex: string }
  }>('/api/chat/:docId/pending-edit/:messageId/op/:opIndex', async (req, reply) => {
    const user = req.currentUser!
    const opIndex = Number(req.params.opIndex)
    const docId = req.params.docId
    const messageId = req.params.messageId
    if (!Number.isInteger(opIndex) || opIndex < 0) {
      return reply.code(400).send({ error: 'opIndex must be a non-negative integer' })
    }

    // Take the per-doc edit lock even though we don't touch the
    // file. It serializes us against apply-op (which mutates the
    // same pending_edit array under the same lock), preventing the
    // lost-update race where two concurrent calls both read a
    // stale turn and overwrite each other's changes.
    type DiscardOutcome =
      | { kind: 'discarded'; op: { op: string } }
    const result = await withEditLock(docId, async (): Promise<DiscardOutcome> => {
      const freshTurn = findMessageByIdScoped(messageId, user.username, docId)
      if (!freshTurn) throw Object.assign(new Error('message not found'), { status: 404 })
      if (!freshTurn.pendingEdit || opIndex >= freshTurn.pendingEdit.length) {
        throw Object.assign(new Error('opIndex out of range'), { status: 400 })
      }
      if (freshTurn.pendingEdit[opIndex]?.appliedAt) {
        throw Object.assign(new Error('cannot discard an already-applied op'), { status: 409 })
      }
      const discarded = freshTurn.pendingEdit[opIndex]
      const remaining = freshTurn.pendingEdit.filter((_, i) => i !== opIndex)
      const anyPending = remaining.some((o) => !o.appliedAt)
      if (remaining.length === 0) {
        const ok = discardPendingEdit(messageId, user.username, docId)
        if (!ok) throw Object.assign(new Error('pending edit not found'), { status: 404 })
      } else if (!anyPending) {
        // Only already-applied ops remain. Keep them so the card
        // shows pills, and stamp the message-level applied flag.
        setPendingEdit(messageId, user.username, docId, remaining)
        markEditApplied(messageId, user.username, docId)
      } else {
        setPendingEdit(messageId, user.username, docId, remaining)
      }
      return { kind: 'discarded', op: discarded as { op: string } }
    }).catch((e) => {
      const status = (e as { status?: number }).status ?? 500
      reply.code(status).send({ error: (e as Error).message ?? 'discard failed' })
      return null
    })
    if (!result) return

    await audit({
      actor: user.username,
      action: 'chat.discard_edit_op',
      target: docId,
      meta: { messageId, op: result.op.op, opIndex },
    })
    return { ok: true }
  })

  // ── Discard a pending edit ─────────────────────────────────────
  // DELETE /api/chat/:docId/pending-edit/:messageId
  // Drops the pending_edit JSON payload but preserves the chat
  // message itself (the model's reasoning text stays in history).
  app.delete<{
    Params: { docId: string; messageId: string }
  }>('/api/chat/:docId/pending-edit/:messageId', async (req, reply) => {
    const user = req.currentUser!
    const ok = discardPendingEdit(
      req.params.messageId,
      user.username,
      req.params.docId,
    )
    if (!ok) {
      return reply.code(404).send({
        error: 'pending edit not found, already applied, or not yours',
      })
    }
    await audit({
      actor: user.username,
      action: 'chat.discard_edit',
      target: req.params.docId,
      meta: { messageId: req.params.messageId },
    })
    return { ok: true }
  })
}

/** Apply a single proposed-edit op against the doc's current text.
 *  Delegates to lib/mdx.ts — same primitives the MCP granular
 *  tools use. Throws if a referenced heading doesn't exist
 *  (caller turns this into a 422). */
function applyOp(text: string, op: ProposedEditOp): string {
  switch (op.op) {
    case 'replace_section': {
      // Defensive: strip a leading "# Heading" / "## Heading" /
      // "### Heading" line if it matches the target heading. The
      // model is told not to include it (replaceSection preserves
      // the original heading line), but small models occasionally
      // include it anyway, which would result in a duplicated
      // heading on apply.
      const body = stripDuplicateLeadingHeading(op.content, op.heading)
      return mdx.replaceSection(text, op.heading, body)
    }
    case 'insert_after':
      return mdx.insertAfter(text, op.heading, op.content)
    case 'delete_section':
      return mdx.deleteSection(text, op.heading)
    case 'append_text':
      return mdx.appendText(text, op.content)
    case 'prepend_text':
      return mdx.prependText(text, op.content)
  }
}

/**
 * Strip a leading ATX heading from `body` if it matches `heading`
 * (case-sensitive, whitespace-tolerant). Returns the body unchanged
 * otherwise. Lets us defensively handle models that include the
 * heading line at the top of replace_section content even though
 * the prompt and applyOp keep the original heading in place.
 */
function stripDuplicateLeadingHeading(body: string, heading: string): string {
  const lines = body.split('\n')
  let i = 0
  // Skip any leading blank lines.
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length) return body
  const m = lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
  if (!m) return body
  if (m[1].trim() !== heading.trim()) return body
  // Strip the heading line + any blank lines that immediately
  // followed it, so the remaining body doesn't start with a
  // stranded blank line.
  i++
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n')
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
    const id = nanoid()
    addUserMemory({
      id,
      userId,
      fact: cmd.fact,
      source: 'user_command',
      createdAt: Date.now(),
    })
    void embedAndStoreSlashMemory('user', id, cmd.fact)
    return `✓ Saved as a permanent memory:\n\n> ${cmd.fact}`
  }
  if (cmd.kind === 'remember-here') {
    const id = nanoid()
    addDocMemory({
      id,
      docId,
      userId,
      fact: cmd.fact,
      createdAt: Date.now(),
    })
    void embedAndStoreSlashMemory('doc', id, cmd.fact)
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


/** Fire-and-forget embed + persist for memories saved via the
 *  /remember and /remember-here slash commands. Swallows errors —
 *  the row is already in SQLite; the boot-time backfill picks up
 *  any NULLs on the next restart. */
async function embedAndStoreSlashMemory(
  scope: 'user' | 'doc',
  id: string,
  fact: string,
): Promise<void> {
  try {
    const { embedMemoryFact } = await import('../services/memoryEmbed.js')
    const { setUserMemoryEmbedding, setDocMemoryEmbedding } = await import('../db/memoriesRepo.js')
    const vec = await embedMemoryFact(fact)
    if (!vec) return
    if (scope === 'user') setUserMemoryEmbedding(id, vec)
    else setDocMemoryEmbedding(id, vec)
  } catch {
    /* swallow */
  }
}
