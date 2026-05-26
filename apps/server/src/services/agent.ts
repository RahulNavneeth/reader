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
// 20 iterations covers multi-section workflows (e.g. "update all
// gold mentions across the document") that need list_sections +
// N×read_section + N×propose_edit + answer. 12 was tight enough that
// the agent would burn the budget on reads before committing to any
// propose_edit calls. Each iteration is bounded by NUM_PREDICT
// tokens so total wall time is still capped by the 5-min stream cap.
const MAX_ITER = 20

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
  /** Semantically-retrieved older turns from THIS thread that fell
   *  outside the recent-window budget but are similar to the current
   *  query. Injected as a separate system note so the model can
   *  reference what was discussed long ago without us having to
   *  re-send the entire transcript. Empty / undefined disables. */
  relevantPast?: Array<{
    role: 'user' | 'assistant'
    content: string
    createdAt: number
  }>
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

  // Tool surface is mime-aware: markdown docs get section-oriented
  // tools, non-markdown (CSV/JSON/YAML/txt) get the full-text /
  // rewrite_file path. Mixing them confuses the model on either side
  // — a 27B will happily call `get_full_text` then `rewrite_file` on
  // a 5K-line markdown doc when a surgical `replace_section` would
  // suffice, blowing the iteration budget.
  const isMarkdown =
    /markdown|mdx/i.test(input.anchor.mime ?? '') ||
    /\.(md|markdown|mdx)$/i.test(input.anchor.storageKey)
  const tools = buildToolCatalog({ isMarkdown })
  const sectionHeadings = outline(input.docText).map((s) => s.heading)
  const systemPrompt = buildSystemPrompt(input.anchor, sectionHeadings, input.attachedDocs ?? [], isMarkdown)

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
  ]
  // Conversation continuity. Old code trimmed to the last 4 turns
  // flat; this loses thread context once a conversation gets long.
  // Hybrid policy:
  //   1. Token-budget the recent window so the prompt fits comfortably
  //      regardless of how long the last message is.
  //   2. Anything that falls outside the window gets compressed into
  //      a one-line bullet summary so the model can still reference
  //      "you asked about X earlier" without us re-sending the full
  //      text.
  const { inWindow, summary } = packHistory(input.history)
  if (summary) {
    messages.push({ role: 'system', content: summary })
  }
  // Semantically-retrieved older turns. Render as a compact
  // mini-transcript so the model can quote/refer to it. Skip
  // entirely when the route didn't supply any (Ollama down, fresh
  // thread, all relevant turns already in the recent window, etc.).
  if (input.relevantPast && input.relevantPast.length > 0) {
    const rendered = input.relevantPast
      .map((m) => {
        const label = m.role === 'user' ? 'User' : 'Assistant'
        const flat = m.content.replace(/\s+/g, ' ').trim()
        const clipped = flat.length > 600 ? flat.slice(0, 600) + '…' : flat
        return `${label}: ${clipped}`
      })
      .join('\n\n')
    messages.push({
      role: 'system',
      content: `Possibly relevant earlier turns from this same thread (similarity match, may or may not be useful):\n\n${rendered}`,
    })
  }
  for (const m of inWindow) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }
  messages.push({ role: 'user', content: input.query })

  // Collected proposed_edit ops — the route persists these on the
  // assistant turn at the end.
  const proposedEdits: ProposedEditOp[] = []
  // Tally of read-side tool calls (list_sections / read_section /
  // search_doc / get_full_text). Surfaced in the fallback message
  // so a user who hit the iteration cap sees what the agent DID do
  // ("I read 4 sections but ran out…") instead of a flat "couldn't
  // finish". A bigger / more honest signal than the canned message.
  let readToolCalls = 0
  let finalAnswer: string | null = null
  /** Most recent non-empty assistantContent the model emitted
   *  alongside tool_calls. Used as a graceful fallback if we hit
   *  the iteration cap without ever calling answer() — better to
   *  surface the model's last prose than the canned "couldn't
   *  finish" message. */
  let lastThinking: string | null = null

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Two-stage nudge — large models (qwen3 27B etc.) often keep
    // gathering sources past the budget. Mid-loop we remind them they
    // can BATCH propose_edits (multiple tool_calls in one assistant
    // turn); near the end we force a finalize. Without these nudges
    // multi-section workflows fall off the cliff at MAX_ITER without
    // ever calling propose_edit.
    if (iter === Math.floor(MAX_ITER / 2)) {
      messages.push({
        role: 'system',
        content:
          "You're halfway through your iteration budget. If the user asked you to edit multiple sections, STOP reading and start proposing. You can emit MULTIPLE propose_edit tool_calls in a single assistant turn — one per section. Don't read every section before committing; read the next one, propose its edit, then move on.",
      })
    }
    if (iter === MAX_ITER - 3) {
      messages.push({
        role: 'system',
        content:
          "You are approaching the iteration budget. STOP exploring. If you have pending edits to propose, emit them NOW (batched if multiple). Then call answer({text: '...'}). If you have nothing to propose, call answer with whatever partial result you have. Do NOT call any more search/read tools.",
      })
    }
    // Tool-result context editing. The previous iteration's tool
    // payloads pile up across iterations — by iter 5 we may be
    // re-sending ~10k tokens of tool output the model already
    // distilled into its next tool_call. Mirrors Anthropic's
    // `clear_tool_uses_20250919` strategy: keep the tool *call*
    // (so the model sees what it asked for) but replace older tool
    // *result* payloads with a short placeholder. The most recent
    // iteration's results stay verbatim so the model can chain.
    pruneStaleToolResults(messages)
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
      // Count read-side calls so the fallback message can be honest
      // about what the agent did before hitting the iteration cap.
      if (
        tc.function.name === 'list_sections' ||
        tc.function.name === 'read_section' ||
        tc.function.name === 'search_doc' ||
        tc.function.name === 'search_vault' ||
        tc.function.name === 'get_full_text'
      ) {
        readToolCalls += 1
      }
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
    } else if (readToolCalls > 0) {
      // Agent did real exploration but never reached propose_edit
      // or answer. Be honest about it — the user can decide whether
      // to retry with a narrower ask or accept the partial result.
      finalAnswer =
        `I explored ${readToolCalls} section${readToolCalls === 1 ? '' : 's'} but ran out of iterations before proposing an edit. ` +
        `Try a more targeted ask (e.g. naming the specific section) or break the change into smaller steps.`
    } else {
      finalAnswer =
        "I couldn't make progress on this. Try rephrasing — naming a specific section or quoting the passage to change usually helps."
    }
    for (const chunk of chunkForStreaming(finalAnswer)) {
      yield { kind: 'token', token: chunk }
    }
  }

  yield { kind: 'done', answer: finalAnswer, proposedEdits }
}

// ── History packing ──────────────────────────────────────────────
// Each Ollama request is stateless; the model has no memory between
// calls. We rebuild the chat context every turn. To keep prompts
// affordable yet preserve thread continuity, we split the history
// into a recent token-budgeted window (sent verbatim as turns) plus
// an older bucket we compress into a single one-line-per-turn
// summary that rides as a system note.

/** Cheap LLM-agnostic token estimate. Real BPE is ~3–5 chars/token
 *  for English; 4 is a safe overestimate for budget gating. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/** How many tokens of recent turns to send verbatim. ~3000 tokens
 *  ≈ 12k chars of conversation history — enough room for a ~20-turn
 *  active thread without crowding the doc context the agent's tools
 *  fetch on top. */
const HISTORY_WINDOW_TOKENS = 3_000

/** How many tokens the older-history summary may consume. Hard cap
 *  so a 100-turn-old thread can't slowly blow up the prompt. */
const HISTORY_SUMMARY_TOKENS = 400

export function packHistory(
  history: Pick<ChatMessage, 'role' | 'content'>[],
): {
  inWindow: Pick<ChatMessage, 'role' | 'content'>[]
  summary: string | null
} {
  if (history.length === 0) return { inWindow: [], summary: null }
  // Walk newest → oldest, accumulating until the budget is spent.
  // Always include at least the last turn even if it's huge — losing
  // the most recent exchange entirely would defeat the purpose.
  let used = 0
  const inWindowReversed: Pick<ChatMessage, 'role' | 'content'>[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    const t = approxTokens(m.content)
    if (inWindowReversed.length > 0 && used + t > HISTORY_WINDOW_TOKENS) break
    used += t
    inWindowReversed.push(m)
  }
  const inWindow = inWindowReversed.reverse()
  const older = history.slice(0, history.length - inWindow.length)
  const summary = summariseOlderHistory(older)
  return { inWindow, summary }
}

/** Extractive one-line-per-turn condensation. Bullet format keeps it
 *  scannable by the model and by humans reading prompts in logs.
 *  We cap each bullet at ~120 chars and the whole block at
 *  HISTORY_SUMMARY_TOKENS, dropping oldest first if we go over. */
function summariseOlderHistory(
  msgs: Pick<ChatMessage, 'role' | 'content'>[],
): string | null {
  if (msgs.length === 0) return null
  const PER_BULLET_CHARS = 120
  const toBullet = (m: Pick<ChatMessage, 'role' | 'content'>): string => {
    const flat = m.content.replace(/\s+/g, ' ').trim()
    const clipped =
      flat.length > PER_BULLET_CHARS ? flat.slice(0, PER_BULLET_CHARS) + '…' : flat
    const label = m.role === 'user' ? 'User' : 'You'
    return `• ${label}: ${clipped}`
  }
  let bullets = msgs.map(toBullet)
  const render = (truncated: boolean) =>
    (truncated ? 'Earlier in this conversation (older turns truncated):' : 'Earlier in this conversation:') +
    '\n' +
    bullets.join('\n')
  let truncated = false
  while (approxTokens(render(truncated)) > HISTORY_SUMMARY_TOKENS && bullets.length > 1) {
    bullets.shift()
    truncated = true
  }
  return render(truncated)
}

// ── Tool-result pruning ─────────────────────────────────────────
// Across agent iterations we accumulate `tool` messages whose
// `content` is the full JSON-stringified payload of every tool
// dispatch. By iter N that array can hold many KB of section text,
// search hits, and outline dumps that the model has already used
// to decide its next move. We keep recent results verbatim and
// replace older payloads with a one-line placeholder so the model
// still sees the call chain but doesn't pay tokens for stale data.
//
// Constants picked to leave room for: the system prompt + recent
// conversation window + one fresh batch of tool calls + the answer.
// On Ollama context windows (typically 8k for default qwen builds)
// this leaves ~5k tokens free for the model.
const TOOL_RESULT_BUDGET_TOKENS = 2_500
const TOOL_RESULT_KEEP_TAIL = 4 // never prune the last N tool messages

export function pruneStaleToolResults(messages: OllamaMessage[]): void {
  // Find tool-role indices in order. The protected tail is the
  // most recent TOOL_RESULT_KEEP_TAIL messages — those almost
  // certainly drove the upcoming iteration's reasoning.
  const toolIdxs: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIdxs.push(i)
  }
  if (toolIdxs.length <= TOOL_RESULT_KEEP_TAIL) return
  const prunableIdxs = toolIdxs.slice(0, toolIdxs.length - TOOL_RESULT_KEEP_TAIL)

  // Sum bytes across ALL tool messages first; only prune if the
  // total exceeds the budget. Below threshold, leave the agent's
  // working memory intact.
  const totalChars = toolIdxs.reduce((n, i) => n + messages[i].content.length, 0)
  if (totalChars / 4 < TOOL_RESULT_BUDGET_TOKENS) return

  for (const i of prunableIdxs) {
    const m = messages[i]
    if (m.content.startsWith('[result cleared')) continue // already pruned
    const name = m.tool_name ?? 'tool'
    const sizeKb = (m.content.length / 1024).toFixed(1)
    m.content = `[result cleared — ${name} returned ${sizeKb} KB, already used in subsequent reasoning]`
  }
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
      case 'append_to_section': return `Proposed appending content inside the **${op.heading}** section. Review and Apply below.`
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
  isMarkdown = true,
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
  // Two prompt variants — keeps each one tight so a 27B model isn't
  // tempted to pick a tool that's hidden from its catalog anyway.
  const mdTools = [
    `  • list_sections — get the document's outline (headings + levels).`,
    `  • read_section — read the full body text of a specific heading.`,
    `  • search_doc — semantic search inside this document for a topic.`,
    `  • search_vault — semantic search across the user's other documents.`,
    `  • propose_edit — propose a structured edit to the document (does not apply; the user reviews and clicks Apply).`,
    `  • answer — deliver the final answer to the user. Always call this once you have enough information.`,
  ]
  const nonMdTools = [
    `  • get_full_text — return the full file content. This document is non-markdown so there are no sections to read individually.`,
    `  • search_doc — semantic search inside this document for a topic.`,
    `  • search_vault — semantic search across the user's other documents.`,
    `  • propose_edit — propose a rewrite of the file (does not apply; the user reviews and clicks Apply). Only the rewrite_file op is valid.`,
    `  • answer — deliver the final answer to the user. Always call this once you have enough information.`,
  ]
  const mdHowTo = [
    `How to work:`,
    `  1. If the question is general (about the doc or vault), call list_sections or search_doc first to ground yourself.`,
    `  2. If the question quotes a passage and asks to rephrase/rewrite/edit, look up the section that contains it via search_doc, then call propose_edit with op="replace_section" and the matched heading.`,
    `  3. Multi-section edits ("update all X to Y", "do this in every section that mentions Z"): for each affected section, call read_section then immediately call propose_edit for that section. You can emit MULTIPLE propose_edit calls in a SINGLE assistant turn (one tool_calls array with multiple entries) — prefer this over interleaving reads + edits. Don't try to read every section before proposing any edits.`,
    `  4. Cite sections by their heading text in your answer.`,
    `  5. ALWAYS call answer({text: "..."}) exactly once as your LAST step. Every conversation ends with answer — even after propose_edit, you must follow up with answer in the same turn or a follow-up turn. The text is rendered verbatim to the user — do NOT include meta-commentary, tool-call traces, JSON, or your own internal reasoning.`,
    `  6. After propose_edit, your answer can simply say what you proposed (e.g. "Proposed a tightened version of the Risks section.") — keep it brief; the diff card carries the actual content.`,
    `  7. If you cannot answer from the document, call answer with the text "That isn't in the document."`,
    `  8. If the question is off-topic (greetings, unrelated facts), call answer with a brief refusal.`,
  ]
  const nonMdHowTo = [
    `How to work:`,
    `  1. Call get_full_text ONCE to read the full file content.`,
    `  2. If the user asks to edit (update/replace/transform/filter rows/etc.), construct the COMPLETE modified file in your head, then call propose_edit({op:"rewrite_file", content:<full new content>}). Do NOT call propose_edit before get_full_text.`,
    `  3. For analytical questions (count/summary/lookup), reason over the text from get_full_text and call answer with the result.`,
    `  4. ALWAYS call answer({text: "..."}) exactly once as your LAST step.`,
    `  5. After propose_edit, your answer can simply say what you proposed (e.g. "Rewrote the file to update team values from platform to rahul.").`,
  ]
  const mdQuoted = [
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
  ]
  const nonMdQuoted = [
    `IMPORTANT — Reply-popover format:`,
    `  When the user's message starts with a blockquoted line in this exact shape:`,
    `      > "<some text>"`,
    ``,
    `      <user's instruction>`,
    `  ...the quoted text is what the user is pointing at inside the file. Use get_full_text to read the file, locate the quoted region, then construct a rewrite_file edit that applies the user's instruction to that region while keeping the rest of the file unchanged.`,
    ``,
  ]
  return [
    `You are Reader AI, a document-grounded assistant for the document titled "${anchor.title}" (mime: ${anchor.mime || 'unknown'}).`,
    ``,
    `Decide what to do next by calling one of the available tools.`,
    `Tools available:`,
    ...(isMarkdown ? mdTools : nonMdTools),
    ``,
    ...(isMarkdown ? mdQuoted : nonMdQuoted),
    ...(isMarkdown ? mdHowTo : nonMdHowTo),
    headingsHint,
    attachedBlock,
  ].join('\n')
}

// ── Tool catalog ───────────────────────────────────────────────

/**
 * Mime-aware tool surface. Markdown docs get section-oriented tools
 * (list_sections / read_section / section ops); non-markdown docs
 * get full-text + rewrite_file. We deliberately HIDE the unused set
 * for each kind so the model isn't tempted to take the wrong path:
 *   - a 27B model handed both `get_full_text` and `read_section` on a
 *     long markdown doc will often fetch the whole text and then try
 *     to `rewrite_file` it (blowing the iteration budget) when the
 *     surgical answer was a single `replace_section`.
 *   - conversely, exposing `read_section` on a CSV is meaningless and
 *     the model wastes turns calling it before realising.
 */
function buildToolCatalog(opts: { isMarkdown: boolean }): OllamaTool[] {
  const all = buildAllTools()
  if (opts.isMarkdown) {
    // Hide non-markdown writers/readers.
    return all.filter((t) => {
      const name = t.function.name
      if (name === 'get_full_text') return false
      return true
    })
  }
  // Non-markdown: hide list_sections/read_section (no headings) and
  // drop the section ops from propose_edit's enum via a swap below.
  return all
    .filter((t) => t.function.name !== 'list_sections' && t.function.name !== 'read_section')
    .map((t) => {
      if (t.function.name !== 'propose_edit') return t
      // Re-author propose_edit so its enum advertises ONLY
      // rewrite_file. Section ops on a CSV / JSON / YAML would fail
      // validation anyway; hiding them prevents wasted tool turns.
      return {
        type: 'function',
        function: {
          ...t.function,
          description:
            "Propose a structured edit to the current document. The edit is NOT applied immediately — it is shown to the user as a card they can Apply or Discard.\n\nThis document is non-markdown, so the only valid op is `rewrite_file`: pass the COMPLETE new file content as `content`. The original file is fully replaced on Apply.",
          parameters: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rewrite_file'], description: 'Only `rewrite_file` is valid here.' },
              content: { type: 'string', description: 'The COMPLETE new file content.' },
            },
            required: ['op', 'content'],
          },
        },
      }
    })
}

function buildAllTools(): OllamaTool[] {
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
        name: 'get_full_text',
        description:
          "Return the full extracted text of the current document. Use for non-markdown files (CSV, JSON, YAML, plain text) where there are no sections to read individually, or when you need the exact full-file content before a `rewrite_file` edit.",
        parameters: { type: 'object', properties: {}, required: [] },
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
          "Propose a structured edit to the current document. The edit is NOT applied immediately — it is shown to the user as a card they can Apply or Discard. Use this when the user asks to rewrite, rephrase, edit, fix, add, remove, or replace content in the document.\n\nOp selection:\n  • Markdown docs with headings → `replace_section` / `insert_after` / `append_to_section` / `delete_section` (preferred — surgical) or `append_text` / `prepend_text` for whole-file tail/head additions.\n  • `append_to_section` lands content at the END of a section's immediate body (before any nested sub-section). Use it to add a row to a table, a bullet to a list, or a paragraph to notes that live inside the section.\n  • CSV / JSON / YAML / TOML / any non-markdown text file → `rewrite_file` with the FULL new content (no section semantics apply).\n\nMarkdown table rules — strict. If the section contains a markdown table and you're editing it:\n  • Keep the FULL table intact in your content: header row + `---` separator row + every existing body row + your changes.\n  • Every row must have the same number of `|`-separated cells as the header. Mismatched cell counts corrupt the table.\n  • To add ONE row to a table, prefer `append_to_section` with just `| cell | cell | … |` as the content — the existing table absorbs it.\n  • Never emit a partial table (body rows without the header + separator). That renders as plain text and breaks the doc.",
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace_section', 'insert_after', 'append_to_section', 'delete_section', 'append_text', 'prepend_text', 'rewrite_file'],
              description: 'Edit kind. Section ops need `heading`. `append_text`/`prepend_text`/`rewrite_file` need just `content`.',
            },
            heading: {
              type: 'string',
              description: 'Exact ATX heading text (required for section ops; matches an existing heading in the doc).',
            },
            content: {
              type: 'string',
              description: 'The new content (omit for delete_section). For replace_section: BODY only, heading preserved. For rewrite_file: the COMPLETE new file content.',
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
      case 'get_full_text': {
        // Full extracted text of the current document. Use sparingly
        // — for non-markdown files (CSV, JSON, YAML) where there are
        // no sections to read individually, or when you need an
        // exact full-file view before a `rewrite_file` edit.
        return {
          ok: true,
          summary: `full text (${input.docText.length} chars)`,
          payload: { text: input.docText },
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
          payload: { error: `No such tool: ${name}. Available: list_sections, read_section, get_full_text, search_doc, search_vault, propose_edit, answer.` },
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
    case 'append_to_section': return `append_to_section "${op.heading}"`
    case 'delete_section': return `delete_section "${op.heading}"`
    case 'append_text': return 'append_text'
    case 'prepend_text': return 'prepend_text'
    case 'rewrite_file': return `rewrite_file (${op.content.length} chars)`
  }
}

/** Validate the {op, heading, content} blob the model passed to
 *  propose_edit. Returns either the parsed op or an error string the
 *  model can read back. Heading must match an existing ATX heading. */
/** Cheap detector for a GFM table: at least one `|`-leading row
 *  followed by a `---` (or `:---:`, etc.) separator row. Used by
 *  the validator to refuse table-mangling replace_section ops. */
function hasMarkdownTable(s: string): boolean {
  const lines = s.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const row = lines[i].trim()
    const sep = lines[i + 1].trim()
    if (!row.startsWith('|') || !row.endsWith('|')) continue
    // Separator row: pipe-delimited cells of optional `:` + `-`s.
    if (/^\|(\s*:?-+:?\s*\|)+$/.test(sep)) return true
  }
  return false
}

function validateProposedEdit(
  op: string,
  heading: string | undefined,
  content: string | undefined,
  docText: string,
): { op: ProposedEditOp } | { error: string } {
  switch (op) {
    case 'replace_section':
    case 'insert_after':
    case 'append_to_section':
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
      // Table safety net: if the existing section contains a markdown
      // table (`|...|` rows with a `---` separator), a `replace_section`
      // that drops the header + separator silently corrupts the doc on
      // apply. Refuse with a hint so the model can retry with the
      // complete table.
      if (op === 'replace_section') {
        const lines = docText.split('\n')
        const oldBody = lines.slice(match.bodyStart, match.endLine).join('\n')
        if (hasMarkdownTable(oldBody) && !hasMarkdownTable(content)) {
          return {
            error:
              `The "${canonicalHeading}" section contains a markdown table. Your replace_section content drops the header + \`---\` separator row, which would corrupt the table. Re-emit the complete table (header row, separator row, every body row) and keep the cell counts consistent.`,
          }
        }
      }
      return { op: { op, heading: canonicalHeading, content } }
    }
    case 'append_text':
    case 'prepend_text': {
      if (!content) return { error: `${op} requires a "content" argument.` }
      return { op: { op, content } }
    }
    case 'rewrite_file': {
      if (content == null) return { error: `rewrite_file requires a "content" argument.` }
      return { op: { op: 'rewrite_file', content } }
    }
    default:
      return { error: `Unknown op: "${op}". Valid ops: replace_section, insert_after, delete_section, append_text, prepend_text, rewrite_file.` }
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
