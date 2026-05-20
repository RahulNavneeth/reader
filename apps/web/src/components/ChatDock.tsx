import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Send, Trash2, Square, X, Sparkles, FileText, ChevronDown, ChevronRight, Loader2, AlertCircle, Copy, Check, RefreshCw, ThumbsDown, Brain } from 'lucide-react'
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
  type DocumentMeta,
  type MemoryUsedDTO,
} from '../lib/api'
import { useConfirm } from '../lib/confirm'

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

export function ChatDock({ meta, onClose, pendingMessage, onPendingConsumed }: Props) {
  const navigate = useNavigate()
  const confirmDialog = useConfirm()
  const [messages, setMessages] = useState<ChatMessageDTO[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamCitations, setStreamCitations] = useState<ChatCitationDTO[]>([])
  const [streamMemoriesUsed, setStreamMemoriesUsed] = useState<MemoryUsedDTO[]>([])
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

  // Load history when the doc changes. If the last turn is a
  // user turn with no following assistant reply AND it was sent
  // recently, a background generation is probably in flight on
  // the server (the user navigated away mid-stream). Poll for the
  // assistant turn to land — matching Notion AI's "you can leave
  // and come back" behavior.
  useEffect(() => {
    if (!meta) return
    let cancelled = false
    setError(null)
    setWindowSize(INITIAL_WINDOW)
    setHistoryLoaded(false)
    // Doc changed → previous doc's consumed token is no longer
    // relevant; clear so a new pendingMessage for this doc can fire.
    consumedRef.current = null

    const poll = async (markLoaded: boolean) => {
      const r = await api.chatHistory(meta.id).catch(() => null)
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
  }, [meta?.id])

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
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
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
    const text = (explicitText ?? draft).trim()
    if (!text || streaming || !indexedOk) return
    setDraft('')
    setError(null)
    setStreamText('')
    setStreamCitations([])
    setStreamMemoriesUsed([])
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
            // inspect what context the answer is grounded in.
            setStreamCitations(e.citations)
            setStreamMemoriesUsed(e.memoriesUsed ?? [])
            setStreamPhase('generating')
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
              .chatHistory(meta.id)
              .then((r) => {
                setMessages(r.messages)
                setError(null)
              })
              .catch(() => {/* keep local state */})
          } else if (e.kind === 'done') {
            // Reload history FIRST, then clear streaming state. If
            // we cleared eagerly, there's a render-frame window
            // where neither `streamText` nor `messages` holds the
            // assistant turn, and the answer briefly vanishes.
            api
              .chatHistory(meta.id)
              .then((r) => {
                setMessages(r.messages)
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamPhase(null)
              })
              .catch(() => {
                // History fetch failed — clear stream state anyway
                // so the UI doesn't hang. Local optimistic state
                // shows the answer until the next history load.
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamPhase(null)
              })
          }
        },
        ac.signal,
      )
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        setError((e as Error)?.message ?? 'chat failed')
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    // Aborts cancel the in-flight regen — drop the anchor so the
    // inline streaming bubble (which has nothing more to fill) hides.
    setRegenAnchorUserId(null)
  }

  /** Re-run the question that produced this assistant turn. The
   *  server is told this is a regenerate via `regenerateOf` — it
   *  drops the stale assistant row and doesn't persist a new user
   *  turn, so the thread stays `(Q, A')` rather than growing into
   *  `(Q, Q, A')`. */
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
          } else if (e.kind === 'token') {
            accumulated += e.token
            setStreamText(accumulated)
          } else if (e.kind === 'error') {
            setError(e.error)
            api.chatHistory(meta.id).then((r) => {
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
              .chatHistory(meta.id)
              .then((r) => {
                setMessages(r.messages)
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamPhase(null)
                setRegenAnchorUserId(null)
              })
              .catch(() => {
                setStreamText('')
                setStreamCitations([])
                setStreamMemoriesUsed([])
                setStreamPhase(null)
                setRegenAnchorUserId(null)
              })
          }
        }, ac.signal, { regenerateOf: assistantId })
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

  const handleClear = async () => {
    const ok = await confirmDialog({
      title: 'Clear chat history?',
      message: `All messages with Reader AI in "${filename}" will be deleted. This can't be undone.`,
      confirmLabel: 'Clear',
      cancelLabel: 'Keep',
      destructive: true,
    })
    if (!ok) return
    await api.chatClear(meta.id).catch(() => null)
    setMessages([])
    setStreamText('')
    setStreamCitations([])
    setError(null)
  }

  /** Submit a thumbs-down correction to the failure log. The
   *  server appends a chat_error_note; subsequent chat turns will
   *  surface it via <known_mistakes> in the prompt so the model
   *  avoids repeating the mistake. Errors are swallowed silently
   *  by the bubble's local state — UX-wise the worst case is the
   *  "Saving…" indicator never flips, which is enough signal. */
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
        className="text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: 'var(--fg-subtle)' }}
      >
        Reader AI
      </div>
      {streaming && streamPhase && (
        <div className="mb-3">
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
      className="w-[380px] shrink-0 border-l flex flex-col"
      style={{ borderColor: 'var(--border-soft)', background: 'var(--panel)' }}
    >
      {/* Header height pinned to h-10 so it lines up exactly with
          the Outline aside's header when both rails are open. */}
      <div
        className="sticky top-0 h-10 px-3 border-b flex items-center gap-2 shrink-0"
        style={{ background: 'var(--panel-2)', borderColor: 'var(--border-soft)' }}
      >
        <Sparkles size={11} className="text-accent shrink-0" />
        <span className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex-1 truncate">
          Ask about {filename}
        </span>
        {hasHistory && (
          <button
            className="btn-ghost h-6 w-6 px-0"
            onClick={handleClear}
            title="Clear chat history for this document"
            aria-label="Clear"
          >
            <Trash2 size={11} />
          </button>
        )}
        <button
          className="btn-ghost h-6 w-6 px-0"
          onClick={onClose}
          title="Close (history is kept)"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto text-[13px]">
        {!hasHistory && !streamText && !resuming && !streaming && (
          // Centered empty state — vertically + horizontally
          // anchored to the pane so the user lands on something
          // welcoming instead of a dense top-aligned paragraph.
          <div className="h-full flex flex-col items-center justify-center px-6 text-center">
            <div
              className="h-10 w-10 rounded-full inline-flex items-center justify-center mb-3"
              style={{ background: 'var(--selected)', color: 'var(--accent)' }}
            >
              <Sparkles size={18} />
            </div>
            {indexedOk ? (
              <>
                <div className="font-semibold text-fg text-[14px]">
                  Ask about {filename}
                </div>
                <div className="text-[12px] text-subtle mt-1 leading-relaxed max-w-[280px]">
                  Reader AI answers from this document and related chunks in your vault.
                </div>
              </>
            ) : (
              <>
                <div className="font-semibold text-fg text-[14px]">
                  This document isn't indexed yet
                </div>
                <div className="text-[12px] text-subtle mt-1 leading-relaxed max-w-[280px]">
                  Run <span className="font-medium text-fg">Index</span> from the toolbar so Reader AI can read it.
                </div>
              </>
            )}
          </div>
        )}
        {(hasHistory || streamText || streaming || resuming) && (
        <div className="px-3 py-3" style={{ borderColor: 'var(--border-soft)' }}>
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
                onCitation={openCitation}
                onRegenerate={handleRegenerate}
                onFeedback={handleFeedback}
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
        style={{ borderTop: '1px solid var(--border-soft)', background: 'var(--panel-2)' }}
      >
        {/* Slash-command suggestions — popped above the composer
            when the draft starts with `/`. Click to accept the
            verb + a trailing space so the user can type the arg. */}
        <SlashMenu draft={draft} onAccept={(verb) => setDraft(verb + ' ')} />
        <div
          className="rounded-lg flex items-end gap-2 px-2.5 py-1.5"
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
          }}
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={indexedOk ? `Ask about ${filename}  (try /remember)` : `Index ${filename} to enable chat`}
            rows={1}
            className="flex-1 resize-none bg-transparent outline-none text-[13px] leading-snug py-1"
            style={{ color: 'var(--fg)' }}
            disabled={!indexedOk || streaming}
          />
          {streaming ? (
            <button
              className="h-7 w-7 inline-flex items-center justify-center rounded-md"
              style={{ background: 'var(--selected)', color: 'var(--accent)' }}
              onClick={handleStop}
              title="Stop generating"
              aria-label="Stop"
            >
              <Square size={11} />
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
      )}
    </aside>
  )
}

function Bubble({
  message,
  showDividerAbove,
  precedingQuestion,
  onCitation,
  onRegenerate,
  onFeedback,
  canRegenerate,
}: {
  message: ChatMessageDTO
  showDividerAbove?: boolean
  /** Content of the user turn immediately preceding this one, if
   *  any. Used to seed the feedback form's "question" field — the
   *  failure log needs to know what the user asked, not just what
   *  the assistant got wrong. */
  precedingQuestion?: string
  onCitation: (c: ChatCitationDTO) => void
  onRegenerate: (assistantId: string) => void
  onFeedback?: (note: { messageId: string; question: string; wrongAnswer: string; correction: string }) => Promise<void>
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
        className="text-[10px] uppercase tracking-wider font-semibold mb-1"
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
            <div className="whitespace-pre-wrap font-semibold text-[14px]">{message.content}</div>
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
      {/* Notion-AI-style row actions on the assistant's reply.
          Only shows on hover to keep the thread visually quiet,
          and only when the turn has real content (not on errors). */}
      {!isUser && !isErrored && message.content && (
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
function distinctSourceCount(citations: ChatCitationDTO[]): number {
  const keys = new Set<string>()
  for (const c of citations) keys.add(c.docPath ?? c.docId)
  return keys.size
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
        className="w-full px-2 py-1 flex items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <FileText size={11} className="text-accent" />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-subtle">
          {totalSources} source{totalSources === 1 ? '' : 's'}
          {hasPrimary ? ' (this doc + vault)' : ' from your vault'}
        </span>
      </button>
      {open && (
        <div
          className="px-2 pb-2"
          style={{ borderTop: '1px solid var(--border-soft)' }}
        >
          {grouped.map((g, i) => {
            const label = g.docTitle ?? `${g.docId.slice(0, 6)}…`
            // Visual divider between primary section group and vault group.
            const prevWasPrimary = i > 0 && grouped[i - 1].primary
            const isFirstVault = !g.primary && prevWasPrimary
            return (
              <div
                key={`${g.docId}:${g.topIdx}`}
                className={`pt-2 ${isFirstVault ? 'mt-2 border-t pt-3' : ''}`}
                style={isFirstVault ? { borderColor: 'var(--border-soft)' } : undefined}
              >
                <div className="flex items-center gap-1.5">
                  {g.primary && (
                    <span
                      className="text-[9px] uppercase tracking-wider font-semibold px-1 py-0.5 rounded"
                      style={{
                        background: 'var(--selected)',
                        color: 'var(--accent)',
                      }}
                    >
                      this doc
                    </span>
                  )}
                  <button
                    className="inline-flex items-center gap-1 text-[11.5px] font-medium hover:underline min-w-0"
                    style={{ color: g.clickable ? 'var(--accent)' : 'var(--fg)' }}
                    onClick={() => {
                      if (g.clickable) {
                        onCitation({
                          docId: g.docId,
                          chunkIdx: g.topIdx,
                          score: g.topScore,
                          docTitle: g.docTitle,
                          docPath: g.docPath,
                        })
                      }
                    }}
                    disabled={!g.clickable}
                    title={g.clickable ? `Open ${g.docPath}` : label}
                  >
                    <span className="truncate max-w-[160px]">{label}</span>
                    {g.count > 1 && (
                      <span className="opacity-60">· {g.count} chunks</span>
                    )}
                    {/* Score is only a cosine for cross-doc vault chunks.
                        Primary (open-doc) entries use a section-match
                        heuristic that lives on a different scale —
                        hiding it avoids confusing the user with a
                        "1.67" next to a "0.67" cosine. */}
                    {!g.primary && (
                      <span className="opacity-60">· {g.topScore.toFixed(2)}</span>
                    )}
                  </button>
                </div>
                {g.docPath && g.docPath !== label && (
                  <div
                    className="mt-0.5 text-[10.5px] text-subtle truncate"
                    title={g.docPath}
                  >
                    {g.docPath}
                  </div>
                )}
                {g.topText && (
                  <div
                    className="mt-1 text-[11.5px] leading-snug text-subtle whitespace-pre-wrap break-words"
                    style={{
                      maxHeight: '5.5em',
                      overflow: 'hidden',
                      WebkitMaskImage:
                        'linear-gradient(to bottom, black 70%, transparent 100%)',
                      maskImage:
                        'linear-gradient(to bottom, black 70%, transparent 100%)',
                    }}
                  >
                    {g.topText}
                  </div>
                )}
              </div>
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
