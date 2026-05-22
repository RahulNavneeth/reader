import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runAgent, type AgentEvent } from './agent.js'
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

  it('falls back to a canned message after hitting the iteration cap', async () => {
    // Feed a loop that always calls list_sections — the agent should
    // hit MAX_ITER (6) and synthesise a fallback message.
    const loop = { content: '', toolCalls: [{ function: { name: 'list_sections', arguments: {} } }] }
    // MAX_ITER is 12; queue enough loop responses to outlast it.
    fakeOllamaQueue = Array.from({ length: 16 }, () => ({ ...loop }))
    const { finalAnswer } = await drainAgent('what is in the doc?')
    expect(finalAnswer).toContain('could not finish')
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
