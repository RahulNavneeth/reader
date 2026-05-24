import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runAgent, packHistory, pruneStaleToolResults, type AgentEvent } from './agent.js'
import { config } from '../config.js'
import type { DocumentMeta } from '../types.js'

/**
 * Agent loop tests with a stubbed Ollama fetch.
 *
 * We can't run a real qwen2.5 model inside CI, so we drive the loop
 * by replaying a recorded sequence of Ollama responses (one per
 * iteration). Each fake response is `{message: {content, tool_calls?}}`
 * shaped like the real Ollama /api/chat output with stream=false.
 *
 * What this DOES cover:
 *   • Tool dispatch (list_sections, read_section, search_doc,
 *     propose_edit, answer) — args parsed, executor runs, payload
 *     fed back into the next iteration's messages.
 *   • Termination on `answer`.
 *   • Graceful fallback when the model produces content without
 *     tool_calls (bare answer mode).
 *   • Hard-cap behaviour when the model loops forever.
 *   • Tool-trace shape on the emitted `done` event.
 *
 * What this does NOT cover:
 *   • Actual model behaviour or tool-call quality. That requires a
 *     live Ollama probe (manual smoke).
 */

const anchor: DocumentMeta = {
  id: 'docX',
  owner: 'alice',
  storageKey: 'projection.md',
  title: 'projection',
  originalFilename: 'projection.md',
  mime: 'text/markdown',
  bytes: 0,
  sha256: '',
  createdAt: 0,
  updatedAt: 0,
  ingest: { status: 'embedded', embedded: true },
  acl: { role: 'owner' },
} as unknown as DocumentMeta

const docText = `# Risks

The portfolio carries equity drawdown risk.
Liquidity is constrained by the 3-year ELSS lock-in.

## Emergency Fund

Top up emergency fund to whatever 6× new monthly expenses looks like.
Park it in liquid funds.
`

/** Stack of fake responses returned by ollamaCall, one per call. */
let fakeOllamaQueue: Array<{
  content: string
  toolCalls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}> = []

beforeEach(() => {
  // The agent reads config.ollama.enabled. Force-enable for tests.
  ;(config as { ollama: { enabled: boolean; baseUrl: string; chatModel: string } }).ollama = {
    enabled: true,
    baseUrl: 'http://stub',
    chatModel: 'qwen2.5:7b-instruct',
  }
  // Stub global fetch so the agent's POST /api/chat call returns the
  // next queued response instead of hitting a real Ollama server.
  vi.stubGlobal('fetch', vi.fn(async () => {
    const next = fakeOllamaQueue.shift()
    if (!next) {
      throw new Error('test bug: fakeOllamaQueue exhausted (agent called Ollama more times than expected)')
    }
    return new Response(
      JSON.stringify({
        message: {
          content: next.content,
          tool_calls: next.toolCalls,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }))
})

afterEach(() => {
  fakeOllamaQueue = []
  vi.unstubAllGlobals()
})

async function drainAgent(query: string): Promise<{
  events: AgentEvent[]
  finalAnswer: string
  proposedEdits: unknown[]
}> {
  const events: AgentEvent[] = []
  const gen = runAgent({
    anchor,
    docText,
    history: [],
    query,
    user: { username: 'alice', role: 'owner' },
  })
  let finalAnswer = ''
  let proposedEdits: unknown[] = []
  for await (const ev of gen) {
    events.push(ev)
    if (ev.kind === 'done') {
      finalAnswer = ev.answer
      proposedEdits = ev.proposedEdits
    }
  }
  return { events, finalAnswer, proposedEdits }
}

describe('runAgent', () => {
  it('dispatches list_sections → answer, terminating cleanly', async () => {
    fakeOllamaQueue = [
      { content: '', toolCalls: [{ function: { name: 'list_sections', arguments: {} } }] },
      { content: '', toolCalls: [{ function: { name: 'answer', arguments: { text: 'Two sections: Risks and Emergency Fund.' } } }] },
    ]
    const { events, finalAnswer, proposedEdits } = await drainAgent('what sections are in this doc?')
    expect(finalAnswer).toBe('Two sections: Risks and Emergency Fund.')
    expect(proposedEdits).toEqual([])
    const toolNames = events
      .filter((e): e is AgentEvent & { kind: 'tool_call_start' } => e.kind === 'tool_call_start')
      .map((e) => e.name)
    expect(toolNames).toEqual(['list_sections', 'answer'])
  })

  it('treats bare content (no tool_calls) as the final answer', async () => {
    fakeOllamaQueue = [{ content: 'Equity drawdown risk and ELSS lock-in.', toolCalls: undefined }]
    const { finalAnswer, proposedEdits } = await drainAgent('what is the doc about?')
    expect(finalAnswer).toBe('Equity drawdown risk and ELSS lock-in.')
    expect(proposedEdits).toEqual([])
  })

  it('validates propose_edit against the doc outline — rejects unknown headings', async () => {
    fakeOllamaQueue = [
      {
        content: '',
        toolCalls: [
          {
            function: {
              name: 'propose_edit',
              arguments: { op: 'replace_section', heading: 'Nonexistent', content: 'whatever' },
            },
          },
        ],
      },
      { content: '', toolCalls: [{ function: { name: 'answer', arguments: { text: 'Could not find that heading.' } } }] },
    ]
    const { events, proposedEdits } = await drainAgent('rewrite the Nonexistent section')
    expect(proposedEdits).toEqual([])
    const editResult = events.find(
      (e): e is AgentEvent & { kind: 'tool_call_result' } =>
        e.kind === 'tool_call_result' && e.summary !== undefined,
    )
    expect(editResult?.ok).toBe(false)
  })

  it('accepts a well-formed propose_edit and collects it on the done event', async () => {
    fakeOllamaQueue = [
      {
        content: '',
        toolCalls: [
          {
            function: {
              name: 'propose_edit',
              arguments: {
                op: 'replace_section',
                heading: 'Risks',
                content: 'Tighter risks paragraph.',
              },
            },
          },
        ],
      },
      { content: '', toolCalls: [{ function: { name: 'answer', arguments: { text: 'Tightened the Risks section.' } } }] },
    ]
    const { finalAnswer, proposedEdits } = await drainAgent('rewrite the Risks section')
    expect(finalAnswer).toBe('Tightened the Risks section.')
    expect(proposedEdits).toEqual([
      { op: 'replace_section', heading: 'Risks', content: 'Tighter risks paragraph.' },
    ])
  })

  it('falls back to an honest "explored N sections" message after hitting the iteration cap', async () => {
    // Feed a loop that always calls list_sections — the agent should
    // hit MAX_ITER and synthesise a fallback message reflecting what
    // it actually did (read tool calls), not a flat "could not
    // finish" lie. MAX_ITER is 20; queue more responses than that.
    const loop = { content: '', toolCalls: [{ function: { name: 'list_sections', arguments: {} } }] }
    fakeOllamaQueue = Array.from({ length: 24 }, () => ({ ...loop }))
    const { finalAnswer } = await drainAgent('what is in the doc?')
    expect(finalAnswer).toMatch(/explored \d+ section/i)
    expect(finalAnswer).toMatch(/ran out of iterations/i)
  })

  it('streams the final answer in chunks via the `token` event kind', async () => {
    fakeOllamaQueue = [
      { content: '', toolCalls: [{ function: { name: 'answer', arguments: { text: 'A'.repeat(95) } } }] },
    ]
    const { events, finalAnswer } = await drainAgent('whatever')
    expect(finalAnswer).toBe('A'.repeat(95))
    const tokenEvents = events.filter((e): e is AgentEvent & { kind: 'token' } => e.kind === 'token')
    // 95 / 40 = 3 chunks (40, 40, 15)
    expect(tokenEvents.length).toBe(3)
    expect(tokenEvents.map((t) => t.token).join('')).toBe('A'.repeat(95))
  })
})

describe('packHistory', () => {
  it('returns empty + no summary for an empty history', () => {
    const r = packHistory([])
    expect(r.inWindow).toEqual([])
    expect(r.summary).toBeNull()
  })

  it('puts every message in the window when total fits the budget', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `short message ${i}`,
    }))
    const r = packHistory(history)
    expect(r.inWindow).toHaveLength(10)
    expect(r.summary).toBeNull()
  })

  it('summarises older messages once the budget is spent', () => {
    // 50 messages of ~400 chars each = ~5000 tokens worth, way over
    // the 3000-token window. Newest should stay verbatim; oldest
    // should land in the summary bullets.
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}: ${'x'.repeat(400)}`,
    }))
    const r = packHistory(history)
    // Window stays under budget.
    expect(r.inWindow.length).toBeGreaterThan(0)
    expect(r.inWindow.length).toBeLessThan(history.length)
    // Newest message is the last in the window.
    expect(r.inWindow[r.inWindow.length - 1].content).toBe(history[49].content)
    // Older messages got summarized.
    expect(r.summary).not.toBeNull()
    expect(r.summary).toMatch(/Earlier in this conversation/)
    // Summary references the oldest message somehow.
    expect(r.summary).toMatch(/User|You/)
  })

  it('keeps at least the last turn even if it exceeds the budget alone', () => {
    const giant = { role: 'user' as const, content: 'q'.repeat(50_000) }
    const r = packHistory([{ role: 'user', content: 'old' }, giant])
    expect(r.inWindow).toContain(giant)
  })

  it('truncates the summary itself when too many older turns exist', () => {
    // Generate 200 short turns. Window will grab the most recent ~70-ish;
    // the remaining ~130 must compress into ≤ 400 tokens (~1600 chars).
    const history = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}: ${'x'.repeat(150)}`,
    }))
    const r = packHistory(history)
    expect(r.summary).not.toBeNull()
    // Approx-token check: each char ≈ 0.25 tokens; summary must be
    // ≤ 400 tokens ⇒ ≤ ~1600 chars.
    expect(r.summary!.length).toBeLessThan(2000)
    // When truncation kicks in, the header changes.
    expect(r.summary).toMatch(/older turns truncated/)
  })

  it('clips per-bullet content so a verbose old message does not dominate', () => {
    const history = [
      { role: 'user' as const, content: 'a'.repeat(5_000) },
      { role: 'assistant' as const, content: 'reply' },
      // A bunch of newer messages so the verbose one falls outside
      // the window.
      ...Array.from({ length: 40 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `recent ${i}: ${'y'.repeat(500)}`,
      })),
    ]
    const r = packHistory(history)
    expect(r.summary).not.toBeNull()
    // The verbose user message should be clipped in the summary
    // (≤ 120 chars + an ellipsis), not 5000.
    const firstBullet = r.summary!.split('\n')[1] // header is line 0
    expect(firstBullet.length).toBeLessThan(150)
    expect(firstBullet).toMatch(/…$/)
  })
})

describe('pruneStaleToolResults', () => {
  type Msg = {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_name?: string
  }

  it('no-ops when total tool content is under the budget', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'thinking' },
      { role: 'tool', tool_name: 'read_section', content: 'small payload' },
      { role: 'tool', tool_name: 'search_doc', content: 'small payload 2' },
    ]
    pruneStaleToolResults(msgs)
    expect(msgs[3].content).toBe('small payload')
    expect(msgs[4].content).toBe('small payload 2')
  })

  it('no-ops when total tool count is at or below the protected tail', () => {
    // Tail is 4 — three tool messages should never be touched, even
    // if they collectively exceed the byte budget.
    const big = 'x'.repeat(20_000)
    const msgs: Msg[] = [
      { role: 'tool', tool_name: 'a', content: big },
      { role: 'tool', tool_name: 'b', content: big },
      { role: 'tool', tool_name: 'c', content: big },
    ]
    pruneStaleToolResults(msgs)
    for (const m of msgs) expect(m.content.length).toBeGreaterThan(1000)
  })

  it('replaces the oldest tool payloads with a placeholder when over budget', () => {
    const big = 'x'.repeat(5_000) // ~1250 tokens each → 6 messages ≈ 7500 tokens
    const msgs: Msg[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: 'assistant', content: `iter ${i} thought` })
      msgs.push({ role: 'tool', tool_name: `t${i}`, content: big })
    }
    pruneStaleToolResults(msgs)
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    // Last 4 untouched.
    for (let i = 2; i < 6; i++) {
      expect(toolMsgs[i].content).toBe(big)
    }
    // First 2 cleared.
    for (let i = 0; i < 2; i++) {
      expect(toolMsgs[i].content).toMatch(/^\[result cleared/)
      expect(toolMsgs[i].content).toContain(`t${i}`)
    }
  })

  it('is idempotent — already-cleared payloads stay as the placeholder', () => {
    const big = 'x'.repeat(5_000)
    const msgs: Msg[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: 'tool', tool_name: `t${i}`, content: big })
    }
    pruneStaleToolResults(msgs)
    const afterFirst = msgs.map((m) => m.content)
    pruneStaleToolResults(msgs)
    const afterSecond = msgs.map((m) => m.content)
    expect(afterSecond).toEqual(afterFirst)
  })
})
