/**
 * Reader AI agent — tool-calling orchestrator over Ollama.
 *
 * Why this exists:
 *   The previous chat path was a single-shot RAG prompt with elaborate
 *   rules + few-shot examples telling the model how to produce JSON-y
 *   XML blocks (proposed_edit) inline. At small model sizes (0.5–1.5b)
 *   the model could not reliably hold all of that — answer the
 *   question, don't echo, emit valid XML, look up the right heading,
 *   avoid leaking the few-shots. Every prompt patch was a workaround.
 *
 *   This agent flips the shape: the model only ever decides "which
 *   tool to call next, with what args?". Each tool has a tight JSON
 *   schema the orchestrator validates. The model never has to write
 *   free-form XML for an edit — it calls `propose_edit({op, heading,
 *   content})` and we structure the result. Echo / no-meta-commentary
 *   problems vanish because the only user-visible text is whatever
 *   the model passes to `answer({text})`.
 *
 * Loop contract:
 *   • Build initial messages = [system, ...history, user].
 *   • Call Ollama with the tool catalog. Stream the response.
 *   • If the model emits tool_calls: dispatch each, append the
 *     assistant + tool messages, continue.
 *   • If the model emits content with no tool_calls: take that as
 *     the answer (graceful fallback — some models give up on tool
 *     use mid-loop and just answer).
 *   • If `answer` is called: that text is the final answer.
 *   • Hard cap: MAX_ITER iterations.
 *
 * Streaming events (consumed by the route → SSE):
 *   { kind: 'tool_call_start', id, name, args }
 *   { kind: 'tool_call_result', id, ok, summary }
 *   { kind: 'thinking_text', text }      — model preamble before a
 *                                          tool call (collapsed in UI)
 *   { kind: 'token', token }             — final answer tokens
 *   { kind: 'done', result }             — final answer + collected
 *                                          proposed_edits
 *   { kind: 'error', message }
 */

import { config } from '../config.js'
import { outline, getSection } from '../lib/mdx.js'
import {
  ChatError,
  retrieveAnchorFocus,
  retrieveRagChunks,
} from './chat.js'
import type { DocumentMeta } from '../types.js'
import type { ChatMessage, ProposedEditOp } from '../db/chatRepo.js'

/** Max model rounds. Each round = one Ollama call. Six rounds is
 *  plenty for: list_sections → search_doc → read_section →
 *  propose_edit → answer (4 tool turns + 1 answer turn) with a
 *  spare. Beyond that the model is almost always looping. Larger
 *  models (qwen3 27B, llama3.1 70B) explore more aggressively —
 *  6 wasn't enough headroom for them to finish, hence 12. The
 *  prompt nudges the model to finalize with answer() as iterations
 *  approach the cap (see lastChanceNote). */
const MAX_ITER = 12

/** Per-iteration generation cap. Higher than legacy 1536 because
 *  some iterations produce a small text + a tool_call payload and
 *  we need budget for both. */
const NUM_PREDICT = 2048

type OllamaTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

type OllamaToolCall = {
  function: { name: string; arguments: Record<string, unknown> }
}

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  /** Per Ollama's tool-calling spec, tool-role messages MUST carry
   *  the name of the tool whose result they're delivering. Without
   *  this the model loses track of which call the result is for
   *  and either re-calls the same tool or stalls. */
  tool_name?: string
}

export type AgentEvent =
  | { kind: 'tool_call_start'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_call_result'; id: string; ok: boolean; summary: string }
  | { kind: 'thinking_text'; text: string }
  | { kind: 'token'; token: string }
  | { kind: 'done'; answer: string; proposedEdits: ProposedEditOp[] }
  | { kind: 'error'; message: string }

export type AgentInput = {
  anchor: DocumentMeta
  /** Full doc body. Read once by the route; passed in so we don't
   *  hit disk on every tool dispatch. */
  docText: string
  history: Pick<ChatMessage, 'role' | 'content'>[]
  query: string
  user: { username: string; role: string }
  signal?: AbortSignal
  /** Extra docs the user @-mentioned in the composer. Their text
   *  is included verbatim in the system prompt so the agent can
   *  cite them even when RAG didn't surface them on its own. */
  attachedDocs?: Array<{ title: string; path: string; text: string }>
}

/** Public entry point. The route consumes this generator and forwards
 *  events to its SSE writer. */
export async function* runAgent(
  input: AgentInput,
): AsyncGenerator<AgentEvent, void, void> {
  if (!config.ollama.enabled) {
    yield { kind: 'error', message: 'Ollama is disabled — set OLLAMA_ENABLED=true and pull a chat model' }
    return
  }

  const tools = buildToolCatalog()
  const sectionHeadings = outline(input.docText).map((s) => s.heading)
  const systemPrompt = buildSystemPrompt(input.anchor, sectionHeadings, input.attachedDocs ?? [])

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
  ]
  // Recent conversation history for follow-up coherence. We trim
  // to the last 4 turns — agent loops re-establish doc context on
  // their own via tool calls, so long history matters less here
  // than it does in the legacy single-shot path.
  for (const m of input.history.slice(-4)) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }
  messages.push({ role: 'user', content: input.query })

  // Collected proposed_edit ops — the route persists these on the
  // assistant turn at the end.
  const proposedEdits: ProposedEditOp[] = []
  let finalAnswer: string | null = null
  /** Most recent non-empty assistantContent the model emitted
   *  alongside tool_calls. Used as a graceful fallback if we hit
   *  the iteration cap without ever calling answer() — better to
   *  surface the model's last prose than the canned "couldn't
   *  finish" message. */
  let lastThinking: string | null = null

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Last-chance nudge: 3 iterations before the cap, inject a
    // system-role reminder that the model should be wrapping up.
    // Without this, larger models (qwen3 27B etc.) tend to keep
    // gathering sources past the budget and we end up firing the
    // "could not finish" fallback even on questions that have
    // plenty of context already.
    if (iter === MAX_ITER - 3) {
      messages.push({
        role: 'system',
        content: 'You are approaching the iteration budget. Finalize your answer with answer({text: "..."}) on this or the next turn — you have enough context already. Do not call any more search/read tools unless absolutely critical.',
      })
    }
    let assistantContent = ''
    let toolCalls: OllamaToolCall[] = []
    try {
      ;({ content: assistantContent, toolCalls } = await ollamaCall(
        messages,
        tools,
        input.signal,
      ))
    } catch (e) {
      yield { kind: 'error', message: e instanceof Error ? e.message : 'agent call failed' }
      return
    }

    // Push the assistant message into history so the next iteration
    // sees what the model produced.
    messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    })

    // No tool calls → the model is just answering directly. Take
    // whatever content it produced as the final answer and stream
    // it out token-by-token (chunked for UI feel).
    if (toolCalls.length === 0) {
      finalAnswer = assistantContent.trim()
      if (finalAnswer) {
        for (const chunk of chunkForStreaming(finalAnswer)) {
          yield { kind: 'token', token: chunk }
        }
      }
      break
    }

    // If the model emitted some content alongside its tool calls,
    // surface that as "thinking_text" so the UI can show it in a
    // collapsed reasoning trace. Don't stream as `token` — that's
    // reserved for the final answer.
    if (assistantContent.trim()) {
      lastThinking = assistantContent.trim()
      yield { kind: 'thinking_text', text: lastThinking }
    }

    // Dispatch each tool call. If the model called `answer`, we
    // terminate with its text (a clean exit). If it called multiple
    // tools, we execute them in order and feed all results back.
    let terminated = false
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const tc = toolCalls[ti]
      const id = `${iter}.${ti}`
      yield { kind: 'tool_call_start', id, name: tc.function.name, args: tc.function.arguments }
      const result = await dispatchTool(tc, input, proposedEdits)
      yield { kind: 'tool_call_result', id, ok: result.ok, summary: result.summary }
      messages.push({
        role: 'tool',
        tool_name: tc.function.name,
        content: JSON.stringify(result.payload),
      })
      if (result.terminates) {
        finalAnswer = result.finalAnswer ?? ''
        if (finalAnswer) {
          for (const chunk of chunkForStreaming(finalAnswer)) {
            yield { kind: 'token', token: chunk }
          }
        }
        terminated = true
        break
      }
    }
    if (terminated) break
  }

  // If we exited without an explicit answer:
  //   • If proposed_edits accumulated, the agent did real work —
  //     just forgot to call `answer`. Synthesise a one-line summary
  //     of what it proposed so the user sees a sensible message
  //     above the Apply card instead of a "Chat failed" panel.
  //   • Otherwise it hit the iteration cap or produced nothing.
  //     Show a clean fallback message.
  if (!finalAnswer) {
    if (proposedEdits.length > 0) {
      finalAnswer = summariseProposedEdits(proposedEdits)
    } else if (lastThinking && lastThinking.length > 40) {
      // Cap hit but the model emitted reasoning prose along the
      // way — surface that as the answer rather than dropping it
      // for a canned message. The 40-char floor filters out
      // one-line "I will now…" preambles that aren't really
      // answers.
      finalAnswer = lastThinking
    } else {
      finalAnswer =
        'I could not finish the reasoning loop in time. Try a simpler question or break it into steps.'
    }
    for (const chunk of chunkForStreaming(finalAnswer)) {
      yield { kind: 'token', token: chunk }
    }
  }

  yield { kind: 'done', answer: finalAnswer, proposedEdits }
}

/** Default user-visible message when the agent terminates with one
 *  or more queued edits but never called `answer`. Reads each op
 *  back in friendly prose so the user understands what's about to
 *  appear in the Apply card. */
function summariseProposedEdits(ops: ProposedEditOp[]): string {
  if (ops.length === 1) {
    const op = ops[0]
    switch (op.op) {
      case 'replace_section': return `Proposed a rewrite of the **${op.heading}** section. Review and Apply below.`
      case 'insert_after': return `Proposed a new section after **${op.heading}**. Review and Apply below.`
      case 'delete_section': return `Proposed deleting the **${op.heading}** section. Review and Apply below.`
      case 'append_text': return `Proposed appending content to the end of the document. Review and Apply below.`
      case 'prepend_text': return `Proposed prepending content to the start of the document. Review and Apply below.`
    }
  }
  return `Proposed ${ops.length} edits. Review and Apply below.`
}

// ── System prompt ──────────────────────────────────────────────

function buildSystemPrompt(
  anchor: DocumentMeta,
  sectionHeadings: string[],
  attachedDocs: Array<{ title: string; path: string; text: string }>,
): string {
  // Deliberately compact. The agent doesn't need 60 lines of rules
  // when the tools enforce structure on their own.
  const headingsHint =
    sectionHeadings.length > 0
      ? `\nKnown section headings in this document: ${sectionHeadings.map((h) => `"${h}"`).join(', ')}.`
      : ''
  // Each attached doc capped at 6 KB so a few @-mentions don't
  // blow the prompt budget. The agent's tools still operate on the
  // anchor doc only — attached docs are read-only reference
  // material the model can quote and cite by title.
  const ATTACHED_DOC_CAP = 6_000
  const attachedBlock = attachedDocs.length > 0
    ? '\n\n' + attachedDocs
        .map((d) => {
          const body = d.text.length > ATTACHED_DOC_CAP
            ? d.text.slice(0, ATTACHED_DOC_CAP) + '\n…[truncated]'
            : d.text
          return `<attached_doc title="${d.title.replace(/"/g, '\\"')}" path="${d.path.replace(/"/g, '\\"')}">\n${body}\n</attached_doc>`
        })
        .join('\n\n')
    + '\n\n(The user @-mentioned these additional documents — treat them as authoritative reference material. You can quote and cite them in answer() by title.)'
    : ''
  return [
    `You are Reader AI, a document-grounded assistant for the document titled "${anchor.title}".`,
    ``,
    `Decide what to do next by calling one of the available tools.`,
    `Tools available:`,
    `  • list_sections — get the document's outline (headings + levels).`,
    `  • read_section — read the full body text of a specific heading.`,
    `  • search_doc — semantic search inside this document for a topic.`,
    `  • search_vault — semantic search across the user's other documents.`,
    `  • propose_edit — propose a structured edit to the document (does not apply; the user reviews and clicks Apply).`,
    `  • answer — deliver the final answer to the user. Always call this once you have enough information.`,
    ``,
    `IMPORTANT — Reply-popover format:`,
    `  When the user's message starts with a blockquoted line in this exact shape:`,
    `      > "<some text copied from the document>"`,
    ``,
    `      <user's instruction>`,
    `  ...the quoted text is a passage the user SELECTED from the document. Treat it as the EXPLICIT target of their instruction below. You must NOT ask "what are you referring to?" — they pointed at the quote already. Instead:`,
    `    1. Call search_doc with the quoted text (or part of it) to find which section contains it.`,
    `    2. If the instruction is "rephrase / rewrite / make this X / shorten / tighten", call propose_edit with op="replace_section" and the section's heading, putting the new body inside.`,
    `    3. If the instruction is "remove this / delete this / drop this", call read_section to get the current body, then call propose_edit with op="replace_section" and the same heading, with content = the body with the quoted line(s) removed.`,
    `    4. If the instruction is "explain / what does this mean", just call answer with a plain-English explanation of the quoted passage. Do NOT propose an edit.`,
    ``,
    `How to work:`,
    `  1. If the question is general (about the doc or vault), call list_sections or search_doc first to ground yourself.`,
    `  2. If the question quotes a passage and asks to rephrase/rewrite/edit, look up the section that contains it via search_doc, then call propose_edit with op="replace_section" and the matched heading.`,
    `  3. Cite sections by their heading text in your answer.`,
    `  4. ALWAYS call answer({text: "..."}) exactly once as your LAST step. Every conversation ends with answer — even after propose_edit, you must follow up with answer in the same turn or a follow-up turn. The text is rendered verbatim to the user — do NOT include meta-commentary, tool-call traces, JSON, or your own internal reasoning.`,
    `  5. After propose_edit, your answer can simply say what you proposed (e.g. "Proposed a tightened version of the Risks section.") — keep it brief; the diff card carries the actual content.`,
    `  6. If you cannot answer from the document, call answer with the text "That isn't in the document."`,
    `  7. If the question is off-topic (greetings, unrelated facts), call answer with a brief refusal.`,
    headingsHint,
    attachedBlock,
  ].join('\n')
}

// ── Tool catalog ───────────────────────────────────────────────

function buildToolCatalog(): OllamaTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_sections',
        description:
          "Return the outline of the current document: an array of headings and their nesting levels. Call this when you need to know what sections exist before deciding what to read.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_section',
        description:
          "Return the full body text under an exact heading in the current document. The heading must match one returned by list_sections.",
        parameters: {
          type: 'object',
          properties: {
            heading: { type: 'string', description: 'Exact ATX heading text (no leading #).' },
          },
          required: ['heading'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_doc',
        description:
          "Semantic search WITHIN the current document. Returns the top-K matching chunks with their text and approximate location. Use when the user's question doesn't directly name a section.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language search query.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_vault',
        description:
          "Semantic search ACROSS the user's other documents (not the current one). Use when the user is asking how the current doc connects to other things in their vault.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language search query.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'propose_edit',
        description:
          "Propose a structured edit to the current document. The edit is NOT applied immediately — it is shown to the user as a card they can Apply or Discard. Use this when the user asks to rewrite, rephrase, edit, fix, add, remove, or replace content in the document.",
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace_section', 'insert_after', 'delete_section', 'append_text', 'prepend_text'],
              description: 'The kind of edit. For "replace_section"/"insert_after"/"delete_section" provide heading. For "append_text"/"prepend_text" omit heading and provide content.',
            },
            heading: {
              type: 'string',
              description: 'Exact ATX heading text (required for section ops; matches an existing heading in the doc).',
            },
            content: {
              type: 'string',
              description: 'The new content (omit for delete_section). For replace_section, this is the BODY only — do NOT include the heading line, it is preserved automatically.',
            },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'answer',
        description:
          "Deliver the final user-visible answer. The text is rendered verbatim to the user. Always call this once — and exactly once — at the end of your reasoning.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: "The user-visible answer in markdown. Do NOT include tool traces, JSON, or meta-commentary." },
          },
          required: ['text'],
        },
      },
    },
  ]
}

// ── Tool dispatch ─────────────────────────────────────────────

type ToolDispatchResult = {
  ok: boolean
  /** Short human-readable summary for the UI's tool-trace accordion. */
  summary: string
  /** Structured payload fed back into the model as the next turn's
   *  tool message. Must be JSON-serialisable. */
  payload: unknown
  /** When true, the loop exits with `finalAnswer` after emitting
   *  this tool's result. Only set by the `answer` tool. */
  terminates?: boolean
  finalAnswer?: string
}

async function dispatchTool(
  tc: OllamaToolCall,
  input: AgentInput,
  proposedEdits: ProposedEditOp[],
): Promise<ToolDispatchResult> {
  const name = tc.function.name
  const args = tc.function.arguments ?? {}
  try {
    switch (name) {
      case 'list_sections': {
        const sections = outline(input.docText).map((s) => ({ level: s.level, heading: s.heading }))
        return {
          ok: true,
          summary: `outline (${sections.length} headings)`,
          payload: { sections },
        }
      }
      case 'read_section': {
        const heading = String(args.heading ?? '')
        if (!heading) {
          return { ok: false, summary: 'missing heading', payload: { error: 'heading is required' } }
        }
        const body = getSection(input.docText, heading)
        if (body === null) {
          return {
            ok: false,
            summary: `heading not found: "${heading}"`,
            payload: { error: `No section found with heading "${heading}". Call list_sections to see available headings.` },
          }
        }
        // Cap to keep the next round's prompt small. 4 KB of section
        // body is plenty for a model to summarise / paraphrase /
        // search within.
        const capped = body.length > 4096 ? body.slice(0, 4096) + '\n…[truncated]' : body
        return {
          ok: true,
          summary: `${heading} (${body.length} chars)`,
          payload: { heading, content: capped },
        }
      }
      case 'search_doc': {
        const query = String(args.query ?? '')
        if (!query) {
          return { ok: false, summary: 'missing query', payload: { error: 'query is required' } }
        }
        const hits = await retrieveAnchorFocus(query, input.anchor, input.user)
        const results = hits.slice(0, 3).map((c) => ({
          chunkIdx: c.chunkIdx,
          score: c.score,
          snippet: c.text.length > 800 ? c.text.slice(0, 800) + '…' : c.text,
        }))
        return {
          ok: true,
          summary: `${results.length} hits for "${truncateForSummary(query)}"`,
          payload: { results },
        }
      }
      case 'search_vault': {
        const query = String(args.query ?? '')
        if (!query) {
          return { ok: false, summary: 'missing query', payload: { error: 'query is required' } }
        }
        const hits = await retrieveRagChunks(query, input.anchor, input.user)
        const results = hits.slice(0, 3).map((c) => ({
          docTitle: c.docTitle,
          docPath: c.docPath,
          score: c.score,
          snippet: c.text.length > 600 ? c.text.slice(0, 600) + '…' : c.text,
        }))
        return {
          ok: true,
          summary: `${results.length} vault hits for "${truncateForSummary(query)}"`,
          payload: { results },
        }
      }
      case 'propose_edit': {
        const op = String(args.op ?? '')
        const heading = args.heading != null ? String(args.heading) : undefined
        const content = args.content != null ? String(args.content) : undefined
        const validated = validateProposedEdit(op, heading, content, input.docText)
        if ('error' in validated) {
          return { ok: false, summary: validated.error, payload: { error: validated.error } }
        }
        proposedEdits.push(validated.op)
        return {
          ok: true,
          summary: describeOp(validated.op),
          payload: {
            accepted: true,
            note: 'Edit was queued for user review. Do not call propose_edit again for the same change. Call answer next.',
          },
        }
      }
      case 'answer': {
        const text = String(args.text ?? '').trim()
        if (!text) {
          return {
            ok: false,
            summary: 'empty answer',
            payload: { error: 'answer requires a non-empty text argument' },
          }
        }
        return {
          ok: true,
          summary: 'final answer',
          payload: { delivered: true },
          terminates: true,
          finalAnswer: text,
        }
      }
      default:
        return {
          ok: false,
          summary: `unknown tool: ${name}`,
          payload: { error: `No such tool: ${name}. Available: list_sections, read_section, search_doc, search_vault, propose_edit, answer.` },
        }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'tool dispatch failed'
    return { ok: false, summary: msg, payload: { error: msg } }
  }
}

function truncateForSummary(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

function describeOp(op: ProposedEditOp): string {
  switch (op.op) {
    case 'replace_section': return `replace_section "${op.heading}"`
    case 'insert_after': return `insert_after "${op.heading}"`
    case 'delete_section': return `delete_section "${op.heading}"`
    case 'append_text': return 'append_text'
    case 'prepend_text': return 'prepend_text'
  }
}

/** Validate the {op, heading, content} blob the model passed to
 *  propose_edit. Returns either the parsed op or an error string the
 *  model can read back. Heading must match an existing ATX heading. */
function validateProposedEdit(
  op: string,
  heading: string | undefined,
  content: string | undefined,
  docText: string,
): { op: ProposedEditOp } | { error: string } {
  switch (op) {
    case 'replace_section':
    case 'insert_after':
    case 'delete_section': {
      if (!heading) return { error: `${op} requires a "heading" argument.` }
      // Verify the heading actually exists in the doc — otherwise
      // the model is hallucinating and we'd persist an un-applyable
      // edit. Match is whitespace-tolerant: a heading with double
      // spaces or stray leading/trailing space resolves to the
      // canonical version. We then USE the canonical heading
      // (not the model's variant) in the persisted op so the
      // apply path can locate the section.
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
      const requested = norm(heading)
      const match = outline(docText).find((s) => norm(s.heading) === requested)
      if (!match) {
        return {
          error: `Heading "${heading}" does not exist in the document. Call list_sections to see available headings.`,
        }
      }
      const canonicalHeading = match.heading
      if (op === 'delete_section') return { op: { op: 'delete_section', heading: canonicalHeading } }
      if (!content) return { error: `${op} requires a "content" argument.` }
      return { op: { op, heading: canonicalHeading, content } }
    }
    case 'append_text':
    case 'prepend_text': {
      if (!content) return { error: `${op} requires a "content" argument.` }
      return { op: { op, content } }
    }
    default:
      return { error: `Unknown op: "${op}". Valid ops: replace_section, insert_after, delete_section, append_text, prepend_text.` }
  }
}

// ── Ollama call ───────────────────────────────────────────────

/** One non-streaming Ollama /api/chat call with tools. Returns the
 *  combined assistant content + any tool_calls.
 *
 *  We deliberately use non-streaming here: tool_calls arrive only
 *  at the end of the response, and we already need the full content
 *  before deciding whether to dispatch tools or treat it as the
 *  final answer. Streaming round-by-round would let us emit
 *  thinking_text earlier, but the gain is marginal and the simpler
 *  contract is easier to make correct. */
async function ollamaCall(
  messages: OllamaMessage[],
  tools: OllamaTool[],
  signal: AbortSignal | undefined,
): Promise<{ content: string; toolCalls: OllamaToolCall[] }> {
  const url = `${config.ollama.baseUrl.replace(/\/+$/, '')}/api/chat`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.chatModel,
        messages,
        tools,
        stream: false,
        options: {
          num_predict: NUM_PREDICT,
          temperature: 0.3,
          top_p: 0.85,
          top_k: 40,
          // Lighter repetition penalty — the tool-calling loop
          // sometimes wants to call the same tool with adjusted
          // args, and a heavy penalty steers the model away from
          // re-trying when it should.
          repeat_penalty: 1.05,
        },
      }),
    })
  } catch (e) {
    throw new ChatError(`cannot reach Ollama at ${url}`, e)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ChatError(`Ollama returned ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json().catch(() => null)) as {
    message?: { content?: string; tool_calls?: OllamaToolCall[] }
    error?: string
  } | null
  if (!json) throw new ChatError('Ollama returned a non-JSON body')
  if (json.error) throw new ChatError(`Ollama error: ${json.error}`)
  return {
    content: json.message?.content ?? '',
    toolCalls: Array.isArray(json.message?.tool_calls) ? (json.message!.tool_calls as OllamaToolCall[]) : [],
  }
}

// ── Streaming helpers ─────────────────────────────────────────

/** Split a final answer into ~40-char chunks so the UI's existing
 *  token-streaming code path keeps the "typewriter" feel even though
 *  we hold the full answer in memory before emitting. */
function chunkForStreaming(text: string): string[] {
  const out: string[] = []
  const CHUNK = 40
  for (let i = 0; i < text.length; i += CHUNK) {
    out.push(text.slice(i, i + CHUNK))
  }
  return out
}
