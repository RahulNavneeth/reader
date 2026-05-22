import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Send, Trash2, Square, X, Sparkles, FileText, ChevronDown, ChevronRight, Loader2, AlertCircle, Copy, Check, RefreshCw, ThumbsDown, Brain, Quote, BookText, List, Search as SearchIcon, FileEdit, MessageSquare, Plus, Eye } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useNavigate } from 'react-router-dom'
import 'highlight.js/styles/github.css'
import {
  api,
  chatStream,
  type ChatMessageDTO,
  type ChatCitationDTO,
  type ChatThreadDTO,
  type DocumentMeta,
  type MemoryUsedDTO,
  type ToolTraceEntryDTO,
} from '../lib/api'
import { useConfirm, usePrompt } from '../lib/confirm'
import { ProposedEditCard } from './ProposedEditCard'
import { ReasoningTrace } from './ReasoningTrace'
import { MentionMenu, type MentionDoc } from './MentionMenu'

type Props = {
  meta: DocumentMeta | null
  /** Caller closes the sidebar via this. Closing keeps server-side
   *  history intact — reopening picks up where the user left off. */
  onClose: () => void
  /** External trigger to send a chat message — e.g. the
   *  selection-popover ("Explain with Reader AI") hands a pre-
   *  composed message in via this prop. ChatDock consumes it via
   *  useEffect and notifies via onPendingConsumed so the parent
   *  can clear its state. */
  pendingMessage?: string | null
  onPendingConsumed?: () => void
  /** External trigger from the "Reply with Reader AI" popover
   *  action. Unlike pendingMessage this is NOT auto-sent — it
   *  becomes a quote chip above the composer and the user types
   *  their freeform question against it. Cleared via
   *  onPendingQuoteConsumed once ChatDock takes ownership. */
  pendingQuote?: string | null
  onPendingQuoteConsumed?: () => void
  /** Called after the user successfully Applies a proposed edit
   *  on a chat turn, so the parent doc viewer can refetch its
   *  body + meta and reflect the new content without a reload. */
  onDocEdited?: () => void
}

/**
 * Right-rail AI chat sidebar — matches the Outline aside pattern so
 * the two coexist cleanly. Sits next to the document instead of
 * over it, full-height, with a composer pinned to the bottom of
 * the rail. Scales naturally for long conversations because the
 * thread is the only scrollable region.
 *
 * Server-side persistence keys on (docId, userId) — closing the
 * panel and reopening (or leaving the file and coming back)
 * resumes the same thread.
 *
 * Long-thread handling: the visible message list is windowed —
 * default to the most-recent 50 turns with a "Show earlier" button.
 * Avoids painting hundreds of bubbles when a thread accumulates.
 */

const INITIAL_WINDOW = 50
const WINDOW_STEP = 50

export function ChatDock({
  meta,
  onClose,
  pendingMessage,
  onPendingConsumed,
  pendingQuote,
  onPendingQuoteConsumed,
  onDocEdited,
}: Props) {
  const navigate = useNavigate()
  const confirmDialog = useConfirm()
  const promptDialog = usePrompt()
  /** Threads available for this (doc, user). The dropdown menu in
   *  the header lists these by most-recent-activity. */
  const [threads, setThreads] = useState<ChatThreadDTO[]>([])
  /** Currently visible thread. Null until the initial threads load
   *  picks one (or creates a fresh one for empty docs). All chat
   *  messages displayed are scoped to this id. */
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  /** Ref to the header chevron button. Passed to ThreadMenu so its
   *  close-on-outside-click handler excludes this button — otherwise
   *  clicking the trigger fires the document listener (close) and
   *  immediately the trigger's onClick (open again), causing a
   *  visible flicker. */
  const threadTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [messages, setMessages] = useState<ChatMessageDTO[]>([])
  const [draft, setDraft] = useState('')
  /** Quoted excerpt from a "Reply with Reader AI" click — sits as
   *  a chip above the composer. On send it's prepended to the
   *  outgoing message as a single-line blockquote so the model
   *  sees: > "<excerpt>"\n\n<user question>. Cleared after send
   *  or via the chip's dismiss button. */
  const [quote, setQuote] = useState<string | null>(null)
  /** Docs the user has @-mentioned. Forced into the agent's context
   *  for the next turn alongside the anchor doc. Cleared after send,
   *  or via the chip's × button. */
  const [attachedDocs, setAttachedDocs] = useState<MentionDoc[]>([])
  /** When non-null, the user is mid-mention. Holds the partial query
   *  (text after the most recent unclosed `@`) and the textarea
   *  index where the `@` sits — used to remove the token after the
   *  user picks a doc. */
  const [mentionState, setMentionState] = useState<{ query: string; atIndex: number } | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamCitations, setStreamCitations] = useState<ChatCitationDTO[]>([])
  const [streamMemoriesUsed, setStreamMemoriesUsed] = useState<MemoryUsedDTO[]>([])
  /** Agent tool-call trace for the in-flight stream. Persisted onto
   *  the assistant turn at the end so the rendered bubble carries
   *  the same "Reasoning" accordion once the message lands in
   *  history. */
  const [streamToolTrace, setStreamToolTrace] = useState<ToolTraceEntryDTO[]>([])
  const [streamPhase, setStreamPhase] = useState<'retrieving' | 'generating' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW)
  /** True when ChatDock loaded a thread whose tail is a user turn
   *  with no assistant reply yet — a generation is presumed to be
   *  running in the background. Drives a "Generating…" indicator
   *  + a polling loop that swaps in the assistant turn when ready. */
  const [resuming, setResuming] = useState(false)
  /** Flips to true after the initial history load completes for
   *  the current doc. The auto-send-on-pendingMessage effect gates
   *  on this so it never races with the history fetch — without
   *  this gate, history loading second would overwrite the
   *  optimistic user turn with the empty pre-persistence state. */
  const [historyLoaded, setHistoryLoaded] = useState(false)
  /** When a regeneration is in flight, this holds the id of the
   *  user turn whose answer is being regenerated. The streaming
   *  bubble renders right after that user turn instead of at the
   *  bottom of the thread — so the user sees the new answer
   *  appearing exactly where the old one was. Null for fresh
   *  questions (no in-place anchor; bottom-streaming is correct). */
  const [regenAnchorUserId, setRegenAnchorUserId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  /** Prevents the consume-pending effect from firing twice for the
   *  same message — strict mode runs effects twice on mount, which
   *  would otherwise POST the same message to the server twice and
   *  persist a duplicate user turn. */
  const consumedRef = useRef<string | null>(null)
  /** Messages the user clicked send on WHILE a stream was already
   *  running. Drained by the in-flight stream's `done` handler so
   *  the user can keep typing follow-ups without waiting. */
  const pendingSendsRef = useRef<string[]>([])
  /** Snapshot of the composer state at the moment the active
   *  stream's question was sent. Lets handleStop restore the
   *  question (raw text + quote + @-attachments) into the composer
   *  so the user can edit and retry without retyping. Cleared
   *  when the stream completes successfully. */
  const lastSentRef = useRef<{
    rawDraft: string
    quote: string | null
    attachedDocs: MentionDoc[]
  } | null>(null)

  // Reset per-doc state when the doc changes. Critical that this
  // ONLY runs on meta.id change — the polling effect below also
  // depends on activeThreadId, and if we reset here on every
  // activeThreadId change we'd nuke the just-set thread back to
  // null in a loop, ending up on the empty state after a
  // successful generation.
  useEffect(() => {
    setError(null)
    setWindowSize(INITIAL_WINDOW)
    setHistoryLoaded(false)
    setActiveThreadId(null)
    setThreads([])
    setThreadMenuOpen(false)
    consumedRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id])

  // Load history when the doc changes OR the active thread changes.
  // If the last turn is a user turn with no following assistant
  // reply AND it was sent recently, a background generation is
  // probably in flight on the server (the user navigated away
  // mid-stream). Poll for the assistant turn to land — matching
  // Notion AI's "you can leave and come back" behavior.
  useEffect(() => {
    if (!meta) return
    let cancelled = false

    const poll = async (markLoaded: boolean) => {
      // First call after mount: load the thread list so the header
      // dropdown is populated and we know which thread to default
      // to (most-recently-active). Subsequent polls reuse the
      // already-resolved activeThreadId.
      const tlist = await api.listChatThreads(meta.id).catch(() => null)
      if (cancelled) return false
      if (tlist) setThreads(tlist.threads)
      // Pick a thread to load messages from. If we already chose
      // one earlier (user switched threads), respect that. Otherwise
      // default to most-recent or null when there are none yet.
      let targetThreadId = activeThreadId
      if (!targetThreadId) {
        targetThreadId = tlist && tlist.threads.length > 0 ? tlist.threads[0].id : null
        if (targetThreadId) setActiveThreadId(targetThreadId)
      }
      // No thread = no messages to fetch yet.
      if (!targetThreadId) {
        setMessages([])
        if (markLoaded) setHistoryLoaded(true)
        return false
      }
      const r = await api.chatHistory(meta.id, targetThreadId).catch(() => null)
      if (cancelled || !r) return false
      setMessages(r.messages)
      if (markLoaded) setHistoryLoaded(true)
      const last = r.messages[r.messages.length - 1]
      const pending =
        !!last &&
        last.role === 'user' &&
        Date.now() - last.createdAt < 5 * 60_000
      return pending
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let firstRun = true
    const run = async () => {
      const pending = await poll(firstRun)
      firstRun = false
      if (cancelled) return
      setResuming(pending)
      if (pending) {
        timer = setTimeout(run, 2_000)
      } else {
        setResuming(false)
      }
    }
    run()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, activeThreadId])

  useEffect(() => {
    if (!threadEndRef.current) return
    // Skip auto-scroll-to-bottom when a regeneration is in flight —
    // the new answer is materializing inline next to an OLDER turn,
    // not at the bottom of the thread. Pulling the viewport to the
    // bottom would yank the user away from where they actually
    // wanted to look.
    if (regenAnchorUserId) return
    threadEndRef.current.scrollIntoView({ block: 'end' })
  }, [messages.length, streamText, regenAnchorUserId])

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
    return () => abortRef.current?.abort()
  }, [meta?.id])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    // Floor is the min-h-[44px] baseline (~2 visible rows). Ceiling
    // bumped from 140 → 200 so longer drafts breathe without
    // forcing the user to scroll inside a cramped textarea.
    el.style.height = `${Math.max(44, Math.min(el.scrollHeight, 200))}px`
  }, [draft])

  // Consume externally-pushed messages (e.g. the selection popover's
  // "Explain with Reader AI" button).
  //  - Gated on historyLoaded so the auto-send happens AFTER the
  //    initial history fetch settles. Otherwise the load's
  //    setMessages(historyFromServer) would arrive after handleSend's
  //    optimistic setMessages and wipe the user turn from view.
  //  - Guarded by consumedRef so strict-mode double-fires don't
  //    POST the same message twice (which previously persisted two
  //    duplicate user turns on the server).
  useEffect(() => {
    if (!pendingMessage || !meta) return
    if (!historyLoaded) return
    if (streaming || !meta.ingest?.embedded) return
    if (consumedRef.current === pendingMessage) return
    consumedRef.current = pendingMessage
    handleSend(pendingMessage)
    onPendingConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage, meta?.id, historyLoaded])

  // Consume an externally-pushed quote (e.g. the selection popover's
  // "Reply with Reader AI" button). Quotes are NOT auto-sent — they
  // park above the composer until the user types their question and
  // hits send. We focus the textarea so the user can type immediately.
  useEffect(() => {
    if (!pendingQuote || !meta) return
    setQuote(pendingQuote)
    onPendingQuoteConsumed?.()
    setTimeout(() => inputRef.current?.focus(), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuote, meta?.id])

  const visibleMessages = useMemo(() => {
    if (messages.length <= windowSize) return messages
    return messages.slice(messages.length - windowSize)
  }, [messages, windowSize])
  const hiddenCount = messages.length - visibleMessages.length

  if (!meta) return null

  const indexedOk = !!meta.ingest?.embedded
  const filename = meta.title || meta.originalFilename || 'this document'
  const hasHistory = messages.length > 0

  const handleSend = async (explicitText?: string) => {
    // explicitText lets external callers (selection popover, etc.)
    // bypass the controlled draft input. When omitted, falls back
    // to whatever the user has typed.
    const userText = (explicitText ?? draft).trim()
    if (!userText || !indexedOk) return
    // Already streaming → queue the new message and clear the
    // draft. The done-handler for the in-flight stream drains the
    // queue when it completes (or aborts cleanly). Lets the user
    // keep typing follow-ups without waiting.
    if (streaming) {
      pendingSendsRef.current.push(userText)
      setDraft('')
      setQuote(null)
      setMentionState(null)
      return
    }
    // If the user clicked "Reply" on a selection, prepend the quote
    // as a blockquote line so the model sees the excerpt as context.
    // The server's selection-isolation regex (`> "…"`) treats this
    // as a fresh topic and strips history. Quote always uses the
    // original selection — don't include it when an explicit string
    // was passed in (those come from buttons that already encode
    // their own context, e.g. "Explain this: …").
    const text =
      !explicitText && quote
        ? `> "${quote.replace(/"/g, '\\"')}"\n\n${userText}`
        : userText
    // Snapshot composer state BEFORE clearing — so handleStop can
    // restore the question (raw text + quote + attached docs)
    // into the composer if the user aborts mid-stream. We capture
    // the freeform draft (not the wrapped `> "…"` form) because
    // the restoration path resets the quote chip separately.
    lastSentRef.current = {
      rawDraft: explicitText ?? userText,
      quote: !explicitText ? quote : null,
      attachedDocs: [...attachedDocs],
    }
    setDraft('')
    setQuote(null)
    // Snapshot attached docs for this turn, then clear so the next
    // turn starts fresh. The IDs flow through chatStream's opts.
    const turnAttachedDocIds = attachedDocs.map((d) => d.docId)
    setAttachedDocs([])
    setMentionState(null)
    setError(null)
    setStreamText('')
    setStreamCitations([])
    setStreamMemoriesUsed([])
    setStreamToolTrace([])
    setStreamPhase('retrieving')
    setMessages((cur) => [
      ...cur,
      {
        id: `local-${Date.now()}`,
        docId: meta.id,
        userId: 'me',
        role: 'user',
        content: text,
        citations: null,
        createdAt: Date.now(),
      },
    ])
    setStreaming(true)
    const ac = new AbortController()
    abortRef.current = ac
    let accumulated = ''
    try {
      await chatStream(
        meta.id,
        text,
        (e) => {
          if (e.kind === 'meta') {
            // Server has finished retrieval and is now feeding the
            // model. Surface the chunks it pulled so the user can
            // inspect what context the answer is grounded in. Also
            // capture the threadId — important for brand-new chats
            // where the client didn't know the threadId before the
            // stream started; without this the cancel endpoint
            // would have no thread to abort.
            setStreamCitations(e.citations)
            setStreamMemoriesUsed(e.memoriesUsed ?? [])
            if (e.threadId) setActiveThreadId((cur) => cur ?? e.threadId!)
            setStreamPhase('generating')
          } else if (e.kind === 'tool_call_start') {
            setStreamToolTrace((cur) => [
              ...cur,
              { id: e.id, name: e.name, args: e.args },
            ])
          } else if (e.kind === 'tool_call_result') {
            setStreamToolTrace((cur) =>
              cur.map((t) => (t.id === e.id ? { ...t, ok: e.ok, summary: e.summary } : t)),
            )
          } else if (e.kind === 'thinking_text') {
            // Surfaced for completeness but not rendered as a chip
            // — the tool trace already captures the agent's
            // reasoning shape. Kept here so the event isn't
            // silently dropped (useful for future debug surfacing).
            void e.text
          } else if (e.kind === 'token') {
            accumulated += e.token
            setStreamText(accumulated)
          } else if (e.kind === 'error') {
            // Server has persisted this failure as an assistant
            // turn; refresh history so the error row joins the
            // thread and survives a reload. Clear the in-flight
            // error after the refresh so we don't double-render
            // (persisted turn + transient banner).
            setError(e.error)
            api
              .chatHistory(meta.id, activeThreadId ?? undefined)
              .then((r) => {
                setMessages(r.messages)
                setError(null)
              })
              .catch(() => {/* keep local state */})
          } else if (e.kind === 'done') {
            // Stream succeeded — drop the restoration snapshot so a
            // later Stop doesn't replay a stale question.
            lastSentRef.current = null
            // Reload history FIRST, then clear streaming state. If
            // we cleared eagerly, there's a render-frame window
            // where neither `streamText` nor `messages` holds the
            // assistant turn, and the answer briefly vanishes.
            api
              .chatHistory(meta.id, activeThreadId ?? undefined)
              .then((r) => {
                setMessages(r.messages)
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamToolTrace([])
                setStreamPhase(null)
                // The server may have created a thread if we had none —
                // refresh the thread list and adopt it.
                if (r.threadId && r.threadId !== activeThreadId) {
                  setActiveThreadId(r.threadId)
                }
                api.listChatThreads(meta.id).then((t) => setThreads(t.threads)).catch(() => {/**/})
              })
              .catch(() => {
                // History fetch failed — clear stream state anyway
                // so the UI doesn't hang. Local optimistic state
                // shows the answer until the next history load.
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamToolTrace([])
                setStreamPhase(null)
              })
          }
        },
        ac.signal,
        {
          ...(activeThreadId ? { threadId: activeThreadId } : null),
          ...(turnAttachedDocIds.length > 0 ? { attachedDocs: turnAttachedDocIds } : null),
        },
      )
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        setError((e as Error)?.message ?? 'chat failed')
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      // Drain any messages the user queued while this stream was
      // in flight. Fire the next send on a microtask so React has
      // a chance to flush setStreaming(false) — otherwise the
      // recursive call would see streaming=true and re-queue.
      if (pendingSendsRef.current.length > 0) {
        const next = pendingSendsRef.current.shift()!
        setTimeout(() => { void handleSend(next) }, 0)
      }
    }
  }

  const handleStop = () => {
    // Tell the server to mark this stream as user-cancelled +
    // delete the user turn that triggered it. Then abort the
    // local fetch. Order matters — calling cancel first ensures
    // the server's flag is set before the route's catch fires.
    if (meta && activeThreadId) {
      void api.cancelChatStream(meta.id, activeThreadId).catch(() => {/**/})
    }
    abortRef.current?.abort()
    // Drop the optimistic user turn locally so the bubble vanishes
    // alongside the aborted answer (matches the server-side delete).
    setMessages((cur) => {
      // Drop the most-recent user turn (the one whose stream we
      // just cancelled). It always sits at the end of the list at
      // the moment Stop is clicked.
      for (let i = cur.length - 1; i >= 0; i--) {
        if (cur[i].role === 'user') {
          return [...cur.slice(0, i), ...cur.slice(i + 1)]
        }
      }
      return cur
    })
    // Restore the stopped question into the composer so the user
    // can edit + retry without retyping. Only restore when the
    // composer is empty / clean — if the user has already started
    // typing a follow-up (or queued one), we don't clobber it.
    const snap = lastSentRef.current
    const composerIsClean =
      !draft.trim() && !quote && attachedDocs.length === 0 && pendingSendsRef.current.length === 0
    if (snap && composerIsClean) {
      setDraft(snap.rawDraft)
      setQuote(snap.quote)
      setAttachedDocs(snap.attachedDocs)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    lastSentRef.current = null
    // Also drain any queued follow-ups — the user explicitly hit
    // Stop, so the safest behaviour is to clear the queue rather
    // than fire the next message into a freshly-empty thread.
    pendingSendsRef.current = []
    // Aborts cancel the in-flight regen — drop the anchor so the
    // inline streaming bubble (which has nothing more to fill) hides.
    setRegenAnchorUserId(null)
  }

  /** Re-run the question that produced this assistant turn. The
   *  server is told this is a regenerate via `regenerateOf` — it
   *  drops the stale assistant row and doesn't persist a new user
   *  turn, so the thread stays `(Q, A')` rather than growing into
   *  `(Q, Q, A')`. */
  /** Lift a previous user question back into the composer so the
   *  user can edit it and resend. Deletes the old user turn + its
   *  paired assistant turn from the server so the chat history
   *  doesn't accumulate stale Q+A pairs every time the user edits.
   *  The composer's textarea gets focused at the end. */
  const handleEditQuestion = async (userMsgId: string) => {
    if (streaming || !meta) return
    const idx = messages.findIndex((m) => m.id === userMsgId)
    if (idx < 0) return
    const userMsg = messages[idx]
    if (userMsg.role !== 'user') return
    // The assistant turn that followed (if any). Edit drops both.
    const assistantAfter = messages[idx + 1]?.role === 'assistant' ? messages[idx + 1] : null
    // Re-fill the composer with the original content. If the
    // message was a Reply-quote (`> "…"` prefix), restore the
    // quote chip + the freeform question separately.
    const replyMatch = userMsg.content.match(/^\s*>\s*"([^]*?)"\s*\n+([^]*)$/)
    if (replyMatch) {
      setQuote(replyMatch[1])
      setDraft(replyMatch[2].trim())
    } else {
      setQuote(null)
      setDraft(userMsg.content)
    }
    // Optimistically drop the pair locally so the UI updates
    // immediately. Server delete + history refresh confirms.
    setMessages((cur) => cur.filter((m) => {
      if (m.id === userMsg.id) return false
      if (assistantAfter && m.id === assistantAfter.id) return false
      return true
    }))
    try {
      await api.deleteChatMessage(meta.id, userMsg.id)
      if (assistantAfter) {
        await api.deleteChatMessage(meta.id, assistantAfter.id).catch(() => {/**/})
      }
    } catch {
      /* if server delete fails, the next history refresh will
       * surface the rows again — UX is recoverable. */
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleRegenerate = (assistantId: string) => {
    if (streaming || !indexedOk) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx < 1) return
    const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user')
    if (!prevUser) return
    const question = prevUser.content
    // Locally drop the stale assistant turn while the new one
    // streams in. The chatHistory refresh on `done` will reconcile.
    setMessages((cur) => cur.filter((m) => m.id !== assistantId))
    // Anchor the streaming bubble to the preceding user turn so
    // the regen appears in place, not at the bottom of the thread.
    setRegenAnchorUserId(prevUser.id)
    setError(null)
    setStreamText('')
    setStreamCitations([])
    setStreamMemoriesUsed([])
    setStreamToolTrace([])
    setStreamPhase('retrieving')
    setStreaming(true)
    const ac = new AbortController()
    abortRef.current = ac
    let accumulated = ''
    ;(async () => {
      try {
        await chatStream(meta.id, question, (e) => {
          if (e.kind === 'meta') {
            setStreamCitations(e.citations)
            setStreamMemoriesUsed(e.memoriesUsed ?? [])
            setStreamPhase('generating')
          } else if (e.kind === 'tool_call_start') {
            setStreamToolTrace((cur) => [
              ...cur,
              { id: e.id, name: e.name, args: e.args },
            ])
          } else if (e.kind === 'tool_call_result') {
            setStreamToolTrace((cur) =>
              cur.map((t) => (t.id === e.id ? { ...t, ok: e.ok, summary: e.summary } : t)),
            )
          } else if (e.kind === 'thinking_text') {
            void e.text
          } else if (e.kind === 'token') {
            accumulated += e.token
            setStreamText(accumulated)
          } else if (e.kind === 'error') {
            setError(e.error)
            api.chatHistory(meta.id, activeThreadId ?? undefined).then((r) => {
              setMessages(r.messages)
              setError(null)
              // Clear regen anchor only after history loads so the
              // inline streaming bubble doesn't flicker to the
              // bottom while waiting for the persisted turn.
              setRegenAnchorUserId(null)
            }).catch(() => {
              setRegenAnchorUserId(null)
            })
          } else if (e.kind === 'done') {
            api
              .chatHistory(meta.id, activeThreadId ?? undefined)
              .then((r) => {
                setMessages(r.messages)
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamToolTrace([])
                setStreamPhase(null)
                setRegenAnchorUserId(null)
              })
              .catch(() => {
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamToolTrace([])
                setStreamPhase(null)
                setRegenAnchorUserId(null)
              })
          }
        }, ac.signal, { regenerateOf: assistantId, threadId: activeThreadId ?? undefined })
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') {
          setError((e as Error)?.message ?? 'chat failed')
        }
      } finally {
        setStreaming(false)
        setStreamPhase(null)
        // NOTE: regenAnchorUserId is NOT cleared here — the
        // done/error handlers clear it after history loads so the
        // inline bubble stays put until the persisted turn slots
        // back into place. For aborts (handleStop) we clear it
        // there explicitly.
        abortRef.current = null
      }
    })()
  }

  const currentThread = activeThreadId
    ? threads.find((t) => t.id === activeThreadId) ?? null
    : null

  /** Spawn a fresh thread and switch to it.
   *
   *  Anti-spam: if the active thread already has zero messages
   *  (it's a "New chat" the user hasn't typed into yet), we don't
   *  create another one — we just focus the composer. Otherwise
   *  hammering the New-chat button would accumulate empty rows
   *  in the dropdown. */
  const handleNewThread = async () => {
    if (!meta) return
    if (activeThreadId && messages.length === 0) {
      setTimeout(() => inputRef.current?.focus(), 0)
      return
    }
    try {
      const r = await api.createChatThread(meta.id)
      setThreads((cur) => [r.thread, ...cur.filter((t) => t.id !== r.thread.id)])
      setActiveThreadId(r.thread.id)
      setMessages([])
      setStreamText('')
      setStreamCitations([])
      setStreamMemoriesUsed([])
      setStreamToolTrace([])
      setStreamPhase(null)
      setError(null)
      setTimeout(() => inputRef.current?.focus(), 0)
    } catch {
      /* swallow — user can retry */
    }
  }

  /** Submit a thumbs-down correction to the failure log. The
   *  server appends a chat_error_note; subsequent chat turns will
   *  surface it via <known_mistakes> in the prompt so the model
   *  avoids repeating the mistake. Errors are swallowed silently
   *  by the bubble's local state — UX-wise the worst case is the
   *  "Saving…" indicator never flips, which is enough signal. */
  /** Refresh history from the server. Called after Apply / Discard
   *  on a proposed edit so the persisted state (editAppliedAt,
   *  pendingEdit cleared) flows back into the rendered messages. */
  const reloadHistory = async () => {
    if (!meta) return
    try {
      const r = await api.chatHistory(meta.id, activeThreadId ?? undefined)
      setMessages(r.messages)
    } catch {
      /* keep optimistic local state on transient failure */
    }
  }

  const handleFeedback = async (note: {
    messageId: string
    question: string
    wrongAnswer: string
    correction: string
  }) => {
    if (!meta) return
    await api.submitChatFeedback(meta.id, note)
  }

  /** Render the in-flight assistant turn — phase indicator, sources
   *  panel, memories footer, streaming markdown, or the inline
   *  error. Reused at two anchors:
   *   - inline (right after the regen's anchor user turn) when a
   *     regeneration is in progress, so the new answer streams in
   *     where the old one was
   *   - at the bottom of the thread for fresh questions
   *  showDividerAbove keeps the exchange-boundary divider rule
   *  consistent with the Bubble component. */
  const renderStreamingBubble = (showDividerAbove = false) => (
    <div
      className={`min-w-0 py-3 first:pt-0 ${showDividerAbove ? 'border-t mt-3 pt-6' : ''}`}
      style={showDividerAbove ? { borderColor: 'var(--border-soft)' } : undefined}
    >
      <div
        className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
        style={{ color: 'var(--fg-subtle)' }}
      >
        Reader AI
      </div>
      {streaming && streamPhase && (
        <div className="mb-1.5">
          <PhaseIndicator
            phase={streamPhase}
            sourceCount={distinctSourceCount(streamCitations)}
          />
        </div>
      )}
      {streamCitations.length > 0 && (
        <div className="mb-3">
          <SourcesPanel
            citations={streamCitations}
            onCitation={openCitation}
            defaultOpen
          />
        </div>
      )}
      {streamMemoriesUsed.length > 0 && (
        <UsedMemoryFooter memories={streamMemoriesUsed} className="mb-3" />
      )}
      {streamToolTrace.length > 0 && (
        <ReasoningTrace entries={streamToolTrace} streaming={streaming} />
      )}
      {streamText && (
        <div className="chat-md mt-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {streamText}
          </ReactMarkdown>
          {streaming && (
            <span
              className="inline-block w-1.5 h-3 ml-0.5 align-middle animate-pulse"
              style={{ background: 'var(--accent)' }}
            />
          )}
        </div>
      )}
      {error && <ChatError raw={error} />}
    </div>
  )

  const openCitation = (c: ChatCitationDTO) => {
    if (!c.docPath) return
    const clean = c.docPath.replace(/^\/+/, '')
    navigate(`/${clean}`)
  }

  return (
    <aside
      className="w-[380px] shrink-0 border-l flex flex-col relative"
      style={{ borderColor: 'var(--border-soft)', background: 'var(--bg)' }}
    >
      {/* Header height pinned to h-11 so the h-7 trigger button
          has 8px of vertical air top + bottom, matching the px-2
          side gaps. The Outline aside's header uses the same h-11
          so both rails align when open. */}
      <div
        className="sticky top-0 z-30 h-11 px-2 border-b flex items-center gap-1 shrink-0 relative"
        style={{ background: 'var(--bg)', borderColor: 'var(--border-soft)' }}
      >
        {/* Thread switcher dropdown. Click opens a popover listing
            every thread for this (doc, user) plus a "New chat"
            row at the top. Mirrors Notion AI's "New AI chat ▾". */}
        <button
          ref={threadTriggerRef}
          type="button"
          onClick={() => setThreadMenuOpen((v) => !v)}
          className="flex-1 min-w-0 h-7 px-3 inline-flex items-center gap-2 rounded transition-colors hover:bg-[var(--hover)]"
          aria-expanded={threadMenuOpen}
        >
          <Sparkles size={11} className="text-accent shrink-0" />
          <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold text-fg text-left">
            {currentThread?.title ?? (hasHistory ? 'Conversation' : 'New chat')}
          </span>
          <ChevronDown size={11} className="text-subtle shrink-0" />
        </button>
        <button
          className="btn-ghost h-6 w-6 px-0"
          onClick={handleNewThread}
          title="New chat"
          aria-label="New chat"
        >
          <Sparkles size={11} />
        </button>
        <button
          className="btn-ghost h-6 w-6 px-0"
          onClick={onClose}
          title="Close (history is kept)"
          aria-label="Close"
        >
          <X size={12} />
        </button>
        {threadMenuOpen && (
          <ThreadMenu
            threads={threads}
            activeId={activeThreadId}
            triggerRef={threadTriggerRef}
            onPick={(id) => {
              setThreadMenuOpen(false)
              if (id !== activeThreadId) {
                setActiveThreadId(id)
              }
            }}
            onCreate={() => {
              setThreadMenuOpen(false)
              handleNewThread()
            }}
            onRename={async (id, current) => {
              const next = await promptDialog({
                title: 'Rename chat',
                placeholder: 'Chat name',
                defaultValue: current,
                confirmLabel: 'Rename',
              })
              const trimmed = next?.trim()
              if (!trimmed || trimmed === current) return
              try {
                if (!meta) return
                await api.renameChatThread(meta.id, id, trimmed)
                const r = await api.listChatThreads(meta.id)
                setThreads(r.threads)
              } catch {/* swallow — user can retry */}
            }}
            onDelete={async (id) => {
              if (!meta) return
              const ok = await confirmDialog({
                title: 'Delete chat',
                message: 'Delete this chat and all its messages? This cannot be undone.',
                destructive: true,
              })
              if (!ok) return
              try {
                await api.deleteChatThread(meta.id, id)
                const r = await api.listChatThreads(meta.id)
                setThreads(r.threads)
                if (id === activeThreadId) {
                  // Switch to the most-recent remaining thread or
                  // null (lets the empty-state render).
                  setActiveThreadId(r.threads[0]?.id ?? null)
                  setMessages([])
                }
              } catch {/* swallow */}
            }}
            onClose={() => setThreadMenuOpen(false)}
          />
        )}
      </div>

      <div
        className="flex-1 text-[13px]"
        style={{ overflowY: threadMenuOpen ? 'hidden' : 'auto' }}
      >
        {historyLoaded && !hasHistory && !streamText && !resuming && !streaming && (
          // Empty state — Notion-AI style. Bottom-anchored content
          // block with a brief intro and a stack of clickable
          // starter prompts. The composer is right below so the
          // suggestions sit visually attached to it, inviting the
          // user to either pick one or just start typing.
          <div className="h-full flex flex-col justify-end px-4 pb-3">
            <div className="flex flex-col items-start gap-3">
              <div
                className="h-9 w-9 rounded-full inline-flex items-center justify-center"
                style={{ background: 'var(--selected)', color: 'var(--accent)' }}
              >
                <Sparkles size={16} />
              </div>
              {indexedOk ? (
                <>
                  <div>
                    <div className="font-semibold text-fg text-[15px] leading-tight">
                      Reader AI
                    </div>
                    <div className="text-[12.5px] text-subtle mt-0.5 leading-snug">
                      Here are a few things I can do, or ask me anything.
                    </div>
                  </div>
                  <div className="w-full flex flex-col gap-0.5 mt-1">
                    <StarterPrompt
                      icon={<BookText size={13} />}
                      label="Summarize this document"
                      onClick={() => handleSend('Summarize this document.')}
                    />
                    <StarterPrompt
                      icon={<List size={13} />}
                      label="Show the outline"
                      onClick={() => handleSend('List the sections in this document.')}
                    />
                    <StarterPrompt
                      icon={<SearchIcon size={13} />}
                      label="Find a topic"
                      onClick={() => {
                        setDraft('Find the part about ')
                        setTimeout(() => inputRef.current?.focus(), 0)
                      }}
                    />
                    <StarterPrompt
                      icon={<FileEdit size={13} />}
                      label="Rewrite a section"
                      onClick={() => {
                        setDraft('Rewrite the ')
                        setTimeout(() => inputRef.current?.focus(), 0)
                      }}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <div className="font-semibold text-fg text-[15px] leading-tight">
                    Not indexed yet
                  </div>
                  <div className="text-[12.5px] text-subtle mt-0.5 leading-snug">
                    Run <span className="font-medium text-fg">Index</span> from the toolbar so Reader AI can read this document.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {(hasHistory || streamText || streaming || resuming) && (
        <div className="px-3 pt-1.5 pb-3" style={{ borderColor: 'var(--border-soft)' }}>
          {hiddenCount > 0 && (
            <div className="flex justify-center pb-2">
              <button
                className="btn-ghost text-[11.5px] px-2 py-0.5"
                onClick={() => setWindowSize((n) => n + WINDOW_STEP)}
              >
                Show earlier ({hiddenCount} more)
              </button>
            </div>
          )}
        {visibleMessages.map((m, i) => {
          const showDivider = i > 0 && m.role === 'user' && visibleMessages[i - 1].role === 'assistant'
          // Preceding user turn supplies the "question" field for
          // the 👎 feedback form. We look this up against the FULL
          // messages array (not visibleMessages) so the button
          // still appears for regenerated turns whose preceding
          // user message might be just outside the windowed slice.
          let precedingQuestion = ''
          if (m.role === 'assistant') {
            const fullIdx = messages.findIndex((x) => x.id === m.id)
            if (fullIdx > 0) {
              // Walk back to the nearest user turn — regenerated
              // turns can have an assistant turn immediately before
              // them if a prior regen disrupted normal Q/A order,
              // so a single-step lookup isn't sufficient.
              for (let j = fullIdx - 1; j >= 0; j--) {
                if (messages[j].role === 'user') {
                  precedingQuestion = messages[j].content
                  break
                }
              }
            }
          }
          // Inline streaming bubble — appears immediately after the
          // anchor user turn during an in-place regeneration so the
          // new answer materializes where the old one was, instead
          // of at the bottom of the thread.
          const showStreamingInline =
            !!regenAnchorUserId && m.id === regenAnchorUserId && (streaming || streamText || error)
          return (
            <Fragment key={m.id}>
              <Bubble
                message={m}
                showDividerAbove={showDivider}
                precedingQuestion={precedingQuestion}
                docId={meta.id}
                onCitation={openCitation}
                onRegenerate={handleRegenerate}
                onEditQuestion={handleEditQuestion}
                suppressHoverActions={false}
                onFeedback={handleFeedback}
                onEditChanged={reloadHistory}
                onDocApplied={onDocEdited}
                canRegenerate={!streaming}
              />
              {showStreamingInline && renderStreamingBubble(false)}
            </Fragment>
          )
        })}
        {/* Background-generation indicator. We polled history on
            mount and saw a dangling user turn — generation is
            running on the server even though this client wasn't
            connected during it. */}
        {resuming && !streaming && (() => {
          // Exchange-boundary divider — same rule as Bubble. In
          // practice this block almost always follows a user turn
          // (so no divider), but the check is defensive.
          const last = visibleMessages[visibleMessages.length - 1]
          const showDivider = !!last && last.role === 'assistant'
          return (
            <div
              className={`min-w-0 py-3 first:pt-0 ${showDivider ? 'border-t mt-3 pt-6' : ''}`}
              style={showDivider ? { borderColor: 'var(--border-soft)' } : undefined}
            >
              <div
                className="text-[10px] uppercase tracking-wider font-semibold mb-1"
                style={{ color: 'var(--fg-subtle)' }}
              >
                Reader AI
              </div>
              <div className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                <Loader2 size={11} className="animate-spin" />
                <span>Still generating…</span>
              </div>
            </div>
          )
        })()}
        {/* Bottom streaming block — only when NOT regenerating
            in place. Regenerations render their streaming bubble
            inline (just after the anchor user turn) so the user
            sees the new answer build where the old one was. */}
        {!regenAnchorUserId && (streaming || streamText || error) && renderStreamingBubble()}
        <div ref={threadEndRef} />
        </div>
        )}
      </div>

      {/* Composer pinned to the rail's bottom. Sits inside the
          aside's flex so it stays put while the thread scrolls.
          Hidden entirely when the doc isn't indexed — there's no
          point showing a disabled input; the centered empty state
          tells the user what to do instead. */}
      {indexedOk && (
      <div
        className="shrink-0 px-3 py-2.5 relative"
        style={{ background: 'var(--bg)' }}
      >
        {/* Slash-command suggestions — popped above the composer
            when the draft starts with `/`. Click to accept the
            verb + a trailing space so the user can type the arg. */}
        <SlashMenu draft={draft} onAccept={(verb) => setDraft(verb + ' ')} />
        {mentionState && (
          <MentionMenu
            query={mentionState.query}
            attachedIds={attachedDocs.map((d) => d.docId)}
            excludeDocId={meta.id}
            onPick={(doc) => {
              // Replace the user's `@<partial>` token with the full
              // resolved mention (`@<filename>`) so the placement of
              // the reference stays visible in the question text.
              // Result reads like "Also check @document.md if you
              // don't understand @document_2.md" — the model sees
              // where each attached doc applies.
              const at = mentionState.atIndex
              const before = draft.slice(0, at)
              const afterAt = draft.slice(at + 1)
              const tokenEndRel = afterAt.search(/\s|$/)
              const tokenEnd = at + 1 + (tokenEndRel === -1 ? afterAt.length : tokenEndRel)
              const after = draft.slice(tokenEnd)
              // Use the doc's filename as the mention label. Strip
              // any trailing extension for compactness? No — keep
              // the extension; matches how the chip renders.
              const mentionLabel = `@${doc.name}`
              // Always append a space after the mention so the user
              // can keep typing immediately — even at end-of-input.
              // Skip only when the next character is already
              // whitespace (avoid double spaces in the middle of a
              // sentence).
              const trailingSpace = /^\s/.test(after) ? '' : ' '
              setDraft(before + mentionLabel + trailingSpace + after)
              setAttachedDocs((cur) =>
                cur.some((d) => d.docId === doc.docId) ? cur : [...cur, doc],
              )
              setMentionState(null)
              // Move the caret to just after the inserted mention +
              // any trailing space we added.
              setTimeout(() => {
                const el = inputRef.current
                if (!el) return
                el.focus()
                const caret = (before + mentionLabel + trailingSpace).length
                el.setSelectionRange(caret, caret)
              }, 0)
            }}
            onClose={() => setMentionState(null)}
          />
        )}
        <div
          className="rounded-lg"
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
          }}
        >
          {/* Reply quote — when the user clicks "Reply" on a
              selection, the excerpt parks here as a slim attached
              row above the textarea. Single-line, italic, muted —
              visually subordinate to the question the user is about
              to type. Dismissable via X. */}
          {quote && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px]"
              style={{
                borderBottom: '1px solid var(--border-soft)',
                color: 'var(--fg-subtle)',
              }}
            >
              <Quote size={10} className="shrink-0" />
              <span
                className="flex-1 min-w-0 truncate italic"
                title={quote}
              >
                {quote}
              </span>
              <button
                type="button"
                className="shrink-0 h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--selected)]"
                onClick={() => setQuote(null)}
                aria-label="Remove quote"
                title="Remove quote"
              >
                <X size={10} />
              </button>
            </div>
          )}
          {/* Mention chips row — the auto-attached anchor doc plus
              any docs the user has @-mentioned. Anchor doc has no
              dismiss; user-attached docs show an × on hover. Type
              `@` in the textarea below to add more. */}
          {indexedOk && (
            <div className="px-2.5 pt-1.5 flex flex-wrap items-center gap-1">
              <MentionChip
                label={filename}
                kind="anchor"
                title={`Chat is grounded in ${filename}`}
              />
              {attachedDocs.map((d) => (
                <MentionChip
                  key={d.docId}
                  label={d.name}
                  kind="attached"
                  title={d.path}
                  onRemove={() => setAttachedDocs((cur) => cur.filter((x) => x.docId !== d.docId))}
                />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 px-2.5 py-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              const next = e.target.value
              setDraft(next)
              // Detect an unclosed `@token` — find the latest `@`
              // preceded by whitespace or start-of-input, then take
              // everything between it and the caret as the query.
              // Closing the mention happens when the user types a
              // space, deletes the `@`, or picks/escapes.
              const caret = e.target.selectionStart ?? next.length
              const upToCaret = next.slice(0, caret)
              const atIndex = upToCaret.lastIndexOf('@')
              if (atIndex === -1) {
                setMentionState(null)
                return
              }
              const charBefore = atIndex === 0 ? '' : upToCaret[atIndex - 1]
              const isWordBoundary = atIndex === 0 || /\s/.test(charBefore)
              const token = upToCaret.slice(atIndex + 1)
              if (!isWordBoundary || /\s/.test(token)) {
                setMentionState(null)
                return
              }
              setMentionState({ query: token, atIndex })
            }}
            onKeyDown={(e) => {
              // When the mention popover is open, route Enter +
              // arrow keys to it instead of sending the chat or
              // moving the textarea caret. Without this gate React's
              // synthetic onKeyDown fires before the document-level
              // listener MentionMenu added, so Enter would send the
              // message instead of picking the highlighted doc.
              if (mentionState) {
                if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape') {
                  // MentionMenu owns these keys while open.
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={indexedOk ? `Ask Reader AI` : `Index ${filename} to enable chat`}
            rows={2}
            className="flex-1 resize-none bg-transparent outline-none text-[13px] leading-relaxed py-1 min-h-[44px]"
            style={{ color: 'var(--fg)' }}
            disabled={!indexedOk}
          />
          {streaming && !draft.trim() ? (
            // Streaming AND nothing typed → Stop button.
            <button
              className="h-7 w-7 inline-flex items-center justify-center rounded-md"
              style={{ background: 'var(--selected)', color: 'var(--accent)' }}
              onClick={handleStop}
              title="Stop generating"
              aria-label="Stop"
            >
              <Square size={11} />
            </button>
          ) : streaming ? (
            // Streaming + user typed something → Queue button. The
            // send handler detects `streaming` and pushes onto
            // pendingSendsRef instead of starting a new request.
            <button
              className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-opacity"
              style={{ background: 'var(--accent)', color: 'white' }}
              onClick={() => handleSend()}
              title="Queue (send when current finishes)"
              aria-label="Queue"
            >
              <Send size={11} />
            </button>
          ) : (
            <button
              className="h-7 w-7 inline-flex items-center justify-center rounded-md disabled:opacity-40 transition-opacity"
              style={{
                background: draft.trim() ? 'var(--accent)' : 'var(--panel-2)',
                color: draft.trim() ? 'white' : 'var(--fg-subtle)',
              }}
              onClick={() => handleSend()}
              disabled={!draft.trim() || !indexedOk}
              aria-label="Send"
              title="Send (↵)"
            >
              <Send size={11} />
            </button>
          )}
          </div>
        </div>
      </div>
      )}
      {/* Scrim overlay shown while the thread-switcher dropdown is
          open. Lives at aside-level (not inside the scroll container)
          so it covers the full chat area below the header — including
          the composer — and doesn't get clipped by scroll bounds.
          z-25 sits below the header's z-30 stacking context, so the
          dropdown (z-50 inside the header) stays sharp on top. */}
      {threadMenuOpen && (
        <div
          className="absolute left-0 right-0 bottom-0"
          style={{
            top: '44px',
            background: 'rgba(0, 0, 0, 0.35)',
            zIndex: 25,
          }}
          onClick={() => setThreadMenuOpen(false)}
          aria-hidden="true"
        />
      )}
    </aside>
  )
}

function Bubble({
  message,
  showDividerAbove,
  precedingQuestion,
  docId,
  onCitation,
  onRegenerate,
  onFeedback,
  onEditChanged,
  onDocApplied,
  onEditQuestion,
  suppressHoverActions,
  canRegenerate,
}: {
  message: ChatMessageDTO
  showDividerAbove?: boolean
  /** Content of the user turn immediately preceding this one, if
   *  any. Used to seed the feedback form's "question" field — the
   *  failure log needs to know what the user asked, not just what
   *  the assistant got wrong. */
  precedingQuestion?: string
  /** Doc id this thread is anchored on — needed by proposed-edit
   *  cards so they can call the apply/discard endpoints. */
  docId: string
  onCitation: (c: ChatCitationDTO) => void
  onRegenerate: (assistantId: string) => void
  onFeedback?: (note: { messageId: string; question: string; wrongAnswer: string; correction: string }) => Promise<void>
  /** Called after Apply or Discard succeeds — parent refreshes
   *  history so the persisted state flows back through props. */
  onEditChanged?: () => void
  /** Called specifically after Apply succeeds (NOT Discard) so the
   *  parent doc viewer can refetch the doc body + meta and reflect
   *  the new content without a reload. */
  onDocApplied?: () => void
  /** Called when the user clicks Edit on a USER turn. The parent
   *  drops the old user+assistant pair, re-fills the composer
   *  with the user's content, and focuses the textarea. */
  onEditQuestion?: (userMsgId: string) => void
  /** When true, hide all hover-revealed actions (Edit, Copy,
   *  Regenerate, Wrong). Set while an overlay popover (thread
   *  menu, slash menu, etc.) is open so the chips underneath
   *  don't fade in/out as the overlay covers them. */
  suppressHoverActions?: boolean
  canRegenerate: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [correctionDraft, setCorrectionDraft] = useState('')
  const [feedbackState, setFeedbackState] = useState<'idle' | 'submitting' | 'submitted'>('idle')
  const isUser = message.role === 'user'
  const isErrored = !!message.error
  const handleCopy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {/* user can still select-copy */})
  }
  const handleSubmitFeedback = async () => {
    const correction = correctionDraft.trim()
    if (!correction || !onFeedback || !precedingQuestion) return
    setFeedbackState('submitting')
    try {
      await onFeedback({
        messageId: message.id,
        question: precedingQuestion,
        wrongAnswer: message.content,
        correction,
      })
      setFeedbackState('submitted')
      setTimeout(() => {
        setShowFeedback(false)
        setCorrectionDraft('')
        setFeedbackState('idle')
      }, 1500)
    } catch {
      setFeedbackState('idle')
    }
  }
  return (
    <div
      className={`min-w-0 py-3 first:pt-0 group ${showDividerAbove ? 'border-t mt-3 pt-6' : ''}`}
      style={showDividerAbove ? { borderColor: 'var(--border-soft)' } : undefined}
    >
      <div
        className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
        style={{ color: isUser ? 'var(--accent)' : 'var(--fg-subtle)' }}
      >
        {isUser ? 'You' : 'Reader AI'}
      </div>
      {!isUser && !isErrored && message.citations && message.citations.length > 0 && (
        <SourcesPanel
          citations={message.citations}
          onCitation={onCitation}
        />
      )}
      {!isUser && !isErrored && message.toolTrace && message.toolTrace.length > 0 && (
        <ReasoningTrace entries={message.toolTrace} />
      )}
      {isErrored ? (
        <ChatError raw={message.error as string} />
      ) : (
        <div
          className={`text-[13px] leading-relaxed break-words ${!isUser && message.citations?.length ? 'mt-2' : ''}`}
          style={{ color: 'var(--fg)' }}
        >
          {isUser ? (
            // User question rendered in semibold + slightly larger
            // so it visually leads the turn — the AI reply below is
            // the body, the question is the headline.
            //
            // When the message came from the Reply popover it starts
            // with a `> "…"` blockquote followed by the user's
            // question. Render the two as a single composed unit —
            // a thin accent-left quote tile glued to the question
            // below — instead of two disconnected text blocks.
            (() => {
              const m = message.content.match(/^\s*>\s*"([^]*?)"\s*\n+([^]*)$/)
              if (m) {
                const [, quoted, question] = m
                return (
                  <div
                    className="rounded-lg"
                    style={{ background: 'var(--panel-2)', border: '1px solid var(--border)' }}
                  >
                    <div
                      className="flex items-start gap-1.5 px-2.5 py-1.5 text-[11.5px] leading-snug"
                      style={{
                        borderBottom: '1px solid var(--border-soft)',
                        color: 'var(--fg-subtle)',
                      }}
                    >
                      <Quote size={10} className="shrink-0 mt-0.5" />
                      <span className="flex-1 min-w-0 italic break-words">
                        {quoted}
                      </span>
                    </div>
                    <div
                      className="px-2.5 py-1.5 whitespace-pre-wrap font-semibold text-[14px]"
                      style={{ color: 'var(--fg)' }}
                    >
                      {question.trim()}
                    </div>
                  </div>
                )
              }
              // Plain user question (no Reply quote). Wrap in the
              // same rounded gray tile as the quote+question
              // composite so every user turn — quoted or not —
              // reads as a defined card, not floating text.
              return (
                <div
                  className="rounded-lg px-2.5 py-1.5 whitespace-pre-wrap font-semibold text-[14px]"
                  style={{
                    background: 'var(--panel-2)',
                    border: '1px solid var(--border)',
                    color: 'var(--fg)',
                  }}
                >
                  {message.content}
                </div>
              )
            })()
          ) : (
            <div className="chat-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
      {!isUser && !isErrored && message.memoriesUsed && message.memoriesUsed.length > 0 && (
        <UsedMemoryFooter memories={message.memoriesUsed} className="mt-1.5" />
      )}
      {/* Edit-this-question affordance on user turns. Click pulls
          the content back into the composer + drops the old Q+A
          pair so the resend appears as a fresh turn at the bottom.
          Only shown for non-streaming, non-error user turns. */}
      {isUser && canRegenerate && !suppressHoverActions && message.id && !message.id.startsWith('local-') && onEditQuestion && (
        <div className="mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="btn-ghost h-5 px-1.5 text-[10.5px]"
            onClick={() => onEditQuestion(message.id)}
            title="Edit and resend"
          >
            <FileEdit size={9} className="-mb-px" />
            Edit
          </button>
        </div>
      )}
      {/* Proposed-edit cards. One per <proposed_edit> the model
          emitted in this turn. Each renders its own pending /
          applied / discarded / conflict state independently. */}
      {!isUser && !isErrored && message.pendingEdit && message.pendingEdit.length > 0 && (
        <div className="mt-1">
          {message.pendingEdit.map((edit, i) => (
            <ProposedEditCard
              key={`${message.id}:${i}`}
              docId={docId}
              messageId={message.id}
              edit={edit}
              appliedAt={message.editAppliedAt}
              onApplied={() => {
                onEditChanged?.()
                onDocApplied?.()
              }}
              onDiscarded={onEditChanged}
            />
          ))}
        </div>
      )}
      {/* Notion-AI-style row actions on the assistant's reply.
          Only shows on hover to keep the thread visually quiet,
          and only when the turn has real content (not on errors). */}
      {!isUser && !isErrored && message.content && !suppressHoverActions && (
        <div className="mt-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="btn-ghost h-5 px-1.5 text-[10.5px]"
            onClick={handleCopy}
            title="Copy assistant reply"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            className="btn-ghost h-5 px-1.5 text-[10.5px]"
            onClick={() => onRegenerate(message.id)}
            disabled={!canRegenerate}
            title="Re-run the question to get a fresh answer"
          >
            <RefreshCw size={10} />
            Regenerate
          </button>
          {onFeedback && precedingQuestion && (
            <button
              className="btn-ghost h-5 px-1.5 text-[10.5px]"
              onClick={() => setShowFeedback((v) => !v)}
              title="Tell Reader AI this answer was wrong"
              style={showFeedback ? { color: 'var(--accent)', background: 'var(--selected)' } : undefined}
            >
              <ThumbsDown size={10} />
              Wrong
            </button>
          )}
        </div>
      )}
      {/* Inline feedback form — opens below the assistant turn when
          the user clicks 👎. Submits the correction to the failure
          log; subsequent chat turns surface it via <known_mistakes>
          in the prompt so the model avoids repeating the mistake. */}
      {showFeedback && (
        <div
          className="mt-2 rounded-md p-2.5"
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}
        >
          {feedbackState === 'submitted' ? (
            <div className="text-[12px] text-fg flex items-center gap-1.5">
              <Check size={12} className="text-accent" />
              Recorded — Reader AI will avoid this in future answers.
            </div>
          ) : (
            <>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                What should the answer have been?
              </div>
              <textarea
                value={correctionDraft}
                onChange={(e) => setCorrectionDraft(e.target.value)}
                placeholder="Type the correct answer here…"
                rows={2}
                className="w-full resize-none text-[12.5px] px-2 py-1.5 rounded"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)',
                  outline: 'none',
                }}
                disabled={feedbackState === 'submitting'}
                autoFocus
              />
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  className="h-7 px-2.5 inline-flex items-center gap-1 rounded text-[12px] font-medium disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: 'white' }}
                  onClick={handleSubmitFeedback}
                  disabled={!correctionDraft.trim() || feedbackState === 'submitting'}
                >
                  {feedbackState === 'submitting' ? 'Saving…' : 'Save correction'}
                </button>
                <button
                  className="btn-ghost h-7 px-2 text-[12px]"
                  onClick={() => {
                    setShowFeedback(false)
                    setCorrectionDraft('')
                  }}
                  disabled={feedbackState === 'submitting'}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Distinct doc count from a citations list, deduped the same way
 *  the SourcesPanel groups them. Keeps "Found N sources" in the
 *  phase indicator aligned with "N sources (this doc + vault)" in
 *  the collapsed panel. */
/** A document tag in the chat composer's chips row. Two flavours:
 *   • "anchor" — the doc the chat is bound to. No dismiss button;
 *     subtle gray styling.
 *   • "attached" — a doc the user @-mentioned. Accent-tinted with a
 *     small × button to remove it. Reads as a deliberate tag, not a
 *     passive label.
 */
function MentionChip({
  label,
  kind,
  title,
  onRemove,
}: {
  label: string
  kind: 'anchor' | 'attached'
  title?: string
  onRemove?: () => void
}) {
  const isAttached = kind === 'attached'
  return (
    <span
      className="group inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] max-w-[60%]"
      style={{
        background: isAttached ? 'var(--selected)' : 'var(--bg)',
        border: `1px solid ${isAttached ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border-soft)'}`,
        color: isAttached ? 'var(--accent)' : 'var(--fg-subtle)',
      }}
      title={title}
    >
      {isAttached ? (
        <span className="font-semibold opacity-70">@</span>
      ) : (
        <FileText size={10} className="shrink-0" />
      )}
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          className="ml-0.5 inline-flex items-center justify-center w-3.5 h-3.5 rounded hover:bg-white/50"
        >
          <X size={8} />
        </button>
      )}
    </span>
  )
}

function distinctSourceCount(citations: ChatCitationDTO[]): number {
  const keys = new Set<string>()
  for (const c of citations) keys.add(c.docPath ?? c.docId)
  return keys.size
}

/** Thread switcher popover, opened from the header chevron. Lists
 *  threads with most-recent first, plus a "New chat" row at the top
 *  for quick spawn. Each row has hover-only rename / delete actions.
 *  Click-outside closes the menu. */
function ThreadMenu({
  threads,
  activeId,
  triggerRef,
  onPick,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: {
  threads: ChatThreadDTO[]
  activeId: string | null
  /** The button that toggles this menu. Excluded from the close-on-
   *  outside-click check; without this, clicking the trigger to
   *  close fires the document listener (close), then the trigger's
   *  onClick toggles back to open — producing a visible flicker. */
  triggerRef: React.RefObject<HTMLElement | null>
  onPick: (id: string) => void
  onCreate: () => void
  onRename: (id: string, current: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current && ref.current.contains(target)) return
      if (triggerRef.current && triggerRef.current.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose, triggerRef])
  const [hover, setHover] = useState<number>(-1)
  return (
    <div
      ref={ref}
      className="absolute left-2 right-2 top-full mt-2 z-50 rounded-md shadow-card overflow-hidden"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
      }}
    >
      {/* "Create" row at the top — mirrors TagsButton's "Create <tag>"
          leading affordance. Plus icon + accent label, with the
          border-bottom separating it from the saved-chats list below. */}
      <button
        type="button"
        onClick={onCreate}
        onMouseEnter={() => setHover(-1)}
        className="w-full flex items-center gap-2 px-2.5 h-8 text-[12.5px] text-left text-fg"
        style={{
          borderBottom: threads.length > 0 ? '1px solid var(--border-soft)' : undefined,
          ...(hover === -1 ? { background: 'var(--hover)' } : null),
        }}
      >
        <Plus size={11} className="text-accent" />
        <span className="text-fg">New chat</span>
      </button>
      <div className="max-h-[260px] overflow-y-auto">
        {threads.length === 0 && (
          <div className="px-2.5 py-2 text-[11.5px] text-subtle">
            No saved chats yet.
          </div>
        )}
        {threads.map((t, i) => {
          const isActive = t.id === activeId
          return (
            <div
              key={t.id}
              className="group flex items-center gap-2 px-2.5 h-8 text-[12.5px]"
              style={hover === i ? { background: 'var(--hover)' } : undefined}
              onMouseEnter={() => setHover(i)}
            >
              <MessageSquare
                size={11}
                style={{ color: isActive ? 'var(--accent)' : 'var(--fg-subtle)' }}
              />
              <button
                type="button"
                onClick={() => onPick(t.id)}
                className="flex-1 min-w-0 text-left truncate"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--fg)',
                  fontWeight: isActive ? 600 : 400,
                }}
                title={t.title}
              >
                {t.title}
              </button>
              {/* Meta column. By default shows recency ("2d", "5h"),
                  matching the "count" column in TagsButton's
                  suggestions. On hover, swap to rename + delete
                  actions in the same slot — no layout shift. */}
              <span
                className="text-[10.5px] text-subtle group-hover:hidden whitespace-nowrap"
                title={new Date(t.updatedAt).toLocaleString()}
              >
                {formatRelativeTime(t.updatedAt)}
              </span>
              <span className="hidden group-hover:inline-flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRename(t.id, t.title) }}
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--panel-2)]"
                  title="Rename chat"
                  aria-label="Rename chat"
                >
                  <FileEdit size={10} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDelete(t.id) }}
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--panel-2)]"
                  title="Delete chat"
                  aria-label="Delete chat"
                >
                  <Trash2 size={10} />
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Short relative-time label for the thread menu's right column.
 *  Mirrors the count column in TagsButton's suggestion list — same
 *  font size + muted color — so the two popovers feel related. */
function formatRelativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  const s = Math.floor(delta / 1000)
  if (s < 30) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.floor(d / 365)}y`
}

/** One row in the empty-state starter list. Click sends the prompt
 *  (or pre-fills the draft if the caller wants the user to finish
 *  typing). Visual: full-width row, left-aligned icon + label,
 *  subtle hover state — modelled on Notion-AI's starter list so
 *  the empty surface feels like a menu of capabilities, not a
 *  blank panel. */
function StarterPrompt({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-left transition-colors hover:bg-[var(--selected)]"
      style={{ color: 'var(--fg)' }}
    >
      <span
        className="shrink-0 inline-flex items-center justify-center w-5 h-5"
        style={{ color: 'var(--fg-subtle)' }}
      >
        {icon}
      </span>
      <span>{label}</span>
    </button>
  )
}

/** Phase indicator while the assistant turn is in-flight. Two
 *  states: 'retrieving' (waiting for the meta event) and
 *  'generating' (tokens streaming in). Gives the user something to
 *  watch instead of an empty bubble. */
function PhaseIndicator({
  phase,
  sourceCount,
}: {
  phase: 'retrieving' | 'generating'
  sourceCount: number
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-subtle">
      <Loader2 size={11} className="animate-spin" />
      {phase === 'retrieving' ? (
        <span>Searching your vault…</span>
      ) : (
        <span>
          {sourceCount > 0
            ? `Found ${sourceCount} source${sourceCount === 1 ? '' : 's'} · generating…`
            : 'Generating…'}
        </span>
      )}
    </div>
  )
}

type FriendlyError = {
  title: string
  body: string
  /** Suggested action — usually a shell command or admin path. */
  hint?: string
  /** Original raw string, kept reachable behind a "details" toggle
   *  so power users can still see the underlying server message. */
  raw: string
}

/** Map raw chat-stream error strings to actionable, friendly
 *  messages. Catches the common Ollama failure modes — missing
 *  model, daemon down, runner crash, timeout — and falls through
 *  to a generic fallback for everything else. */
function formatChatError(raw: string): FriendlyError {
  const trimmed = raw.trim()
  // Ollama: model not installed.
  const missing = trimmed.match(/model '([^']+)' not found/i)
  if (missing) {
    return {
      title: 'Chat model not installed',
      body: `Ollama doesn't have the model "${missing[1]}" pulled. Either install it on the Ollama host or pick a different model under Admin → Settings → Embeddings.`,
      hint: `ollama pull ${missing[1]}`,
      raw: trimmed,
    }
  }
  // Network: Ollama unreachable.
  if (/cannot reach ollama/i.test(trimmed)) {
    return {
      title: 'Ollama is unreachable',
      body: 'The chat server can\'t contact the Ollama daemon. Make sure it\'s running and reachable from this host.',
      raw: trimmed,
    }
  }
  // Runner crash — usually OOM or unsupported model.
  if (/llama runner process has terminated/i.test(trimmed)) {
    return {
      title: 'The model failed to load',
      body: 'Ollama\'s runner exited while loading this model. Common cause: not enough RAM/VRAM for the model size. Try a smaller model.',
      raw: trimmed,
    }
  }
  // Admin disabled.
  if (/ai chat is disabled/i.test(trimmed)) {
    return {
      title: 'AI chat is disabled',
      body: 'An administrator turned chat off in workspace settings.',
      raw: trimmed,
    }
  }
  // Empty output (small model returned zero tokens).
  if (/produced no output/i.test(trimmed)) {
    return {
      title: 'No response from the model',
      body: 'The model returned zero tokens for this prompt. This happens with small (<3B) local models on hard or fragmentary content. Try rephrasing the question more specifically, or switch to a larger chat model in Admin → Settings → Embeddings.',
      raw: trimmed,
    }
  }
  // Timeout.
  if (/timed out|timeout/i.test(trimmed)) {
    return {
      title: 'The model took too long',
      body: 'The chat request timed out before the model finished. Try a smaller model or a shorter question.',
      raw: trimmed,
    }
  }
  // Permission.
  if (/not allowed to read|forbidden/i.test(trimmed)) {
    return {
      title: 'You don\'t have access',
      body: 'You can\'t chat about this document — your account doesn\'t have read access.',
      raw: trimmed,
    }
  }
  // Generic fallback.
  return {
    title: 'Chat failed',
    body: 'The model didn\'t produce a response.',
    raw: trimmed,
  }
}

function ChatError({ raw }: { raw: string }) {
  const [showDetails, setShowDetails] = useState(false)
  const err = formatChatError(raw)
  return (
    <div
      className="mt-2 rounded-md text-[12.5px] leading-relaxed"
      style={{
        background: 'var(--danger-bg)',
        color: 'var(--danger-fg)',
        border: '1px solid color-mix(in srgb, var(--danger-fg) 20%, transparent)',
      }}
    >
      <div className="px-3 py-2.5 flex gap-2">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold mb-0.5">{err.title}</div>
          <div className="opacity-90">{err.body}</div>
          {err.hint && (
            <code
              className="block mt-2 px-2 py-1 rounded text-[12px] font-mono break-all"
              style={{
                background: 'rgba(0,0,0,0.06)',
                color: 'inherit',
              }}
            >
              {err.hint}
            </code>
          )}
          <button
            className="mt-1.5 text-[11px] opacity-70 hover:opacity-100 inline-flex items-center gap-1"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          {showDetails && (
            <pre
              className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-all opacity-80"
              style={{ maxHeight: '120px', overflowY: 'auto' }}
            >
              {err.raw}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

/** Collapsible "Sources" block — lists the vault chunks the model
 *  received as context, with previews. Clickable rows open the
 *  source doc. Reveals "what the model saw" so users can sanity-
 *  check whether an answer is grounded in real material. */
function SourcesPanel({
  citations,
  onCitation,
  defaultOpen = false,
}: {
  citations: ChatCitationDTO[]
  onCitation: (c: ChatCitationDTO) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  // Group by doc so multiple chunks from the same doc collapse into
  // a single source entry. Highest-scoring chunk wins as the
  // entry's text + chunkIdx; total chunk count surfaces beside it.
  // Within a group, primary (open doc) goes first.
  const grouped = (() => {
    const byDoc = new Map<
      string,
      {
        primary: boolean
        docTitle?: string
        docPath?: string
        docId: string
        topScore: number
        topText?: string
        topIdx: number
        count: number
        clickable: boolean
      }
    >()
    for (const c of citations) {
      const key = c.docPath ?? c.docId
      const existing = byDoc.get(key)
      if (!existing) {
        byDoc.set(key, {
          primary: !!c.primary,
          docTitle: c.docTitle,
          docPath: c.docPath,
          docId: c.docId,
          topScore: c.score,
          topText: c.text,
          topIdx: c.chunkIdx,
          count: 1,
          clickable: !!c.docPath,
        })
      } else {
        existing.count++
        existing.primary = existing.primary || !!c.primary
        if (c.score > existing.topScore) {
          existing.topScore = c.score
          existing.topText = c.text
          existing.topIdx = c.chunkIdx
        }
      }
    }
    const all = Array.from(byDoc.values())
    // Primary first, then by score desc.
    all.sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1
      return b.topScore - a.topScore
    })
    return all
  })()

  const totalSources = grouped.length
  const hasPrimary = grouped.some((g) => g.primary)

  return (
    <div
      className="rounded-md text-[12px] mb-1"
      style={{
        background: 'var(--panel-2)',
        border: '1px solid var(--border-soft)',
      }}
    >
      <button
        className="w-full px-2.5 py-1.5 flex items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Eye size={11} style={{ color: 'var(--accent)' }} />
        <span className="text-[11.5px] font-medium text-fg">
          {hasPrimary ? 'Looked at this doc' : `Looked at ${totalSources} source${totalSources === 1 ? '' : 's'}`}
        </span>
        <span className="text-[11px] text-subtle">
          · {totalSources} source{totalSources === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div
          className="flex flex-col"
          style={{ borderTop: '1px solid var(--border-soft)' }}
        >
          {grouped.map((g, i) => {
            const label = g.docTitle ?? `${g.docId.slice(0, 6)}…`
            // Narrative phrasing per source. Reads like a sentence
            // ("Pulled 6 chunks from this doc") instead of a
            // function-call signature, matching the Reasoning trace
            // pattern.
            const verb = g.primary ? 'this doc' : 'the vault'
            const chunkPhrase = g.count > 1
              ? `${g.count} passages`
              : '1 passage'
            return (
              <button
                key={`${g.docId}:${g.topIdx}`}
                type="button"
                disabled={!g.clickable}
                onClick={() => {
                  if (!g.clickable) return
                  onCitation({
                    docId: g.docId,
                    chunkIdx: g.topIdx,
                    score: g.topScore,
                    docTitle: g.docTitle,
                    docPath: g.docPath,
                  })
                }}
                title={g.docPath ?? label}
                className="px-2.5 h-8 flex items-center gap-2 text-left text-[12.5px] hover:bg-hover disabled:hover:bg-transparent"
                style={i > 0 ? { borderTop: '1px solid var(--border-soft)' } : undefined}
              >
                <FileText
                  size={11}
                  className="shrink-0"
                  style={{ color: g.primary ? 'var(--accent)' : 'var(--fg-subtle)' }}
                />
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ color: 'var(--fg)' }}
                >
                  {g.primary ? 'Pulled' : 'Pulled'} {chunkPhrase} from{' '}
                  <span
                    className="font-semibold"
                    style={{ color: g.clickable ? 'var(--accent)' : 'var(--fg)' }}
                  >
                    {g.primary ? verb : label}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** "Used memory" footer — appears below assistant turns whose
 *  prompt drew on a saved memory or known-mistake. Collapsed by
 *  default, click to expand the list. Source-of-truth for what
 *  the model actually saw. */
function UsedMemoryFooter({
  memories,
  className = '',
}: {
  memories: MemoryUsedDTO[]
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const userCount = memories.filter((m) => m.kind === 'user').length
  const docCount = memories.filter((m) => m.kind === 'doc').length
  const mistakeCount = memories.filter((m) => m.kind === 'mistake').length
  const summary = [
    userCount > 0 ? `${userCount} permanent` : '',
    docCount > 0 ? `${docCount} doc` : '',
    mistakeCount > 0 ? `${mistakeCount} correction${mistakeCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className={className}>
      <button
        className="inline-flex items-center gap-1 text-[10.5px] text-subtle hover:text-fg transition-colors"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide details' : 'Show details'}
      >
        <Brain size={10} />
        <span>Used memory: {summary}</span>
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {open && (
        <div
          className="mt-1 px-2 py-1.5 rounded text-[11.5px] leading-relaxed space-y-0.5"
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}
        >
          {memories.map((m) => (
            <div key={`${m.kind}:${m.id}`} className="flex items-start gap-1.5">
              <span
                className="text-[9px] uppercase tracking-wider font-semibold shrink-0 mt-0.5"
                style={{ color: m.kind === 'mistake' ? 'var(--danger-fg)' : 'var(--accent)' }}
              >
                {m.kind === 'user' ? 'PERM' : m.kind === 'doc' ? 'DOC' : 'FIX'}
              </span>
              <span className="text-subtle break-words">{m.preview}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Slash-command suggestions. Compact tags-popover-style rows —
 *  small slash icon, verb, hint on the right — that match the
 *  rest of the app's autocomplete chrome. Filters live as the
 *  user types the verb; once they move past the verb (typed a
 *  space) the menu hides so it doesn't cover the input. */
function SlashMenu({ draft, onAccept }: { draft: string; onAccept: (verb: string) => void }) {
  const trimmed = draft.trimStart()
  if (!trimmed.startsWith('/')) return null
  const firstSpace = trimmed.search(/\s/)
  if (firstSpace >= 0) return null
  const typed = trimmed.toLowerCase()
  const commands = [
    { verb: '/remember', hint: 'Save a permanent fact' },
    { verb: '/remember-here', hint: 'Save for this doc only' },
    { verb: '/memories', hint: 'List all your memories' },
    { verb: '/forget', hint: 'Delete by substring' },
  ].filter((c) => c.verb.startsWith(typed))
  if (commands.length === 0) return null
  return (
    <div
      className="absolute bottom-full left-3 right-3 mb-1 rounded-lg overflow-hidden"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 6px 16px rgba(15, 23, 42, 0.10)',
      }}
    >
      {commands.map((c) => (
        <button
          key={c.verb}
          className="w-full flex items-center gap-2 px-2.5 h-8 text-left text-[12.5px] text-fg hover:bg-hover transition-colors"
          onMouseDown={(e) => {
            e.preventDefault()
            onAccept(c.verb)
          }}
        >
          <Sparkles size={11} className="text-muted shrink-0" />
          <span className="font-medium" style={{ color: 'var(--accent)' }}>{c.verb}</span>
          <span className="flex-1 text-[10.5px] text-subtle truncate text-right">{c.hint}</span>
        </button>
      ))}
    </div>
  )
}
