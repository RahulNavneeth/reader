import { useState } from 'react'
import { ChevronRight, ChevronDown, Sparkles, Check, AlertTriangle, List, BookOpen, Search, FileEdit, MessageCircle, Library } from 'lucide-react'
import type { ToolTraceEntryDTO } from '../lib/api'

type Props = {
  entries: ToolTraceEntryDTO[]
  /** When true, the loop is still running. The currently-pending
   *  step gets a shimmer treatment so it reads as "actively
   *  thinking," matching Notion AI's reasoning trace. */
  streaming?: boolean
}

/**
 * "Reasoning" panel — narrates what the agent is doing in plain
 * present-tense English. Modelled on Notion AI's thinking trace:
 *
 *   • Closed pill: "Thought for 3 steps" (or "Thinking…" while live).
 *   • Open: a list of natural-language lines, one per tool call.
 *     The active step shimmers; finished steps are muted; failures
 *     are red with a friendly explanation.
 *
 * The verb form switches by state:
 *   pending  → "Reading the **Risks** section…"
 *   done     → "Read the **Risks** section"
 *   failed   → "Couldn't find a section called **Risks**"
 *
 * Tool args are rendered inline as bold accents, not as separate
 * chips, so each line reads like a sentence rather than a function
 * call signature.
 */
export function ReasoningTrace({ entries, streaming }: Props) {
  const [open, setOpen] = useState(false)
  if (!entries || entries.length === 0) return null

  const isThinking = !!streaming
  const completedCount = entries.filter((e) => e.ok !== undefined).length
  const pillLabel = isThinking
    ? 'Thinking'
    : completedCount === 1
      ? 'Thought for 1 step'
      : `Thought for ${completedCount} steps`

  return (
    <div
      className="mt-1.5 mb-2 rounded-md text-[12px]"
      style={{
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
      }}
    >
      <button
        type="button"
        className="w-full px-2.5 py-1.5 flex items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Sparkles
          size={11}
          className={isThinking ? 'animate-pulse' : ''}
          style={{ color: 'var(--accent)' }}
        />
        <span
          className={[
            'text-[11.5px] font-medium',
            isThinking ? 'reader-shimmer' : 'text-fg',
          ].join(' ')}
        >
          {pillLabel}
          {isThinking && '…'}
        </span>
        {!isThinking && (
          <span className="text-[11px] text-subtle">
            · {completedCount} step{completedCount === 1 ? '' : 's'}
          </span>
        )}
      </button>

      {open && (
        <div
          className="flex flex-col"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          {entries.map((e, i) => (
            <ThinkingStep
              key={e.id}
              entry={e}
              showDivider={i > 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ThinkingStep({ entry, showDivider }: { entry: ToolTraceEntryDTO; showDivider: boolean }) {
  const pending = entry.ok === undefined
  const failed = entry.ok === false
  const Icon = TOOL_ICONS[entry.name] ?? Sparkles
  const phrase = narrate(entry, pending)

  return (
    <div
      className="px-2.5 h-8 flex items-center gap-2"
      style={showDivider ? { borderTop: '1px solid var(--border)' } : undefined}
      title={entry.summary ?? undefined}
    >
      <Icon
        size={11}
        className={['shrink-0', pending ? 'animate-pulse' : ''].join(' ')}
        style={{
          color: failed ? 'var(--danger-fg, #b91c1c)' : pending ? 'var(--accent)' : 'var(--fg-subtle)',
        }}
      />
      <span
        className={[
          'flex-1 min-w-0 truncate text-[12.5px]',
          pending ? 'reader-shimmer' : '',
        ].join(' ')}
        style={{
          color: failed ? 'var(--danger-fg, #b91c1c)' : pending ? undefined : 'var(--fg)',
        }}
        // dangerouslySetInnerHTML — phrase is HTML-escaped + only
        // contains controlled <strong> tags we wrap around args.
        dangerouslySetInnerHTML={{ __html: phrase }}
      />
      {!pending && !failed && (
        <Check size={10} className="shrink-0" style={{ color: 'var(--accent)' }} />
      )}
      {failed && (
        <AlertTriangle size={10} className="shrink-0" style={{ color: 'var(--danger-fg, #b91c1c)' }} />
      )}
    </div>
  )
}

const TOOL_ICONS: Record<string, typeof List> = {
  list_sections: List,
  read_section: BookOpen,
  search_doc: Search,
  search_vault: Library,
  propose_edit: FileEdit,
  answer: MessageCircle,
}

/** Compose a present-tense / past-tense sentence describing the
 *  step. Returns HTML so we can bold the key argument inline. The
 *  only HTML inserted is `<strong>` around an arg we pulled out of
 *  the tool call — caller still escapes everything else. */
function narrate(entry: ToolTraceEntryDTO, pending: boolean): string {
  const args = (entry.args ?? {}) as Record<string, unknown>
  const name = entry.name
  const failed = entry.ok === false

  // Helper: bold an arg string after escaping it.
  const arg = (key: string): string | null => {
    const v = args[key]
    if (typeof v !== 'string' || !v) return null
    const trimmed = v.replace(/\s+/g, ' ').trim()
    const capped = trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed
    return `<strong>${escapeHtml(capped)}</strong>`
  }

  if (failed) {
    if (name === 'propose_edit' || name === 'read_section') {
      const heading = arg('heading')
      return heading
        ? `Couldn’t find a section called ${heading}`
        : 'That section isn’t in the document'
    }
    if (name === 'search_doc' || name === 'search_vault') {
      return 'Search came back empty'
    }
    if (name === 'answer') return 'Empty answer'
    return `Tool ${escapeHtml(name)} failed`
  }

  const verbing = (present: string, past: string) => (pending ? present : past)

  switch (name) {
    case 'list_sections':
      return verbing('Looking at the outline', 'Scanned the outline')
    case 'read_section': {
      const h = arg('heading')
      return h
        ? `${verbing('Reading', 'Read')} the ${h} section`
        : verbing('Reading a section', 'Read a section')
    }
    case 'search_doc': {
      const q = arg('query')
      return q
        ? `${verbing('Searching this doc for', 'Searched this doc for')} ${q}`
        : verbing('Searching this document', 'Searched this document')
    }
    case 'search_vault': {
      const q = arg('query')
      return q
        ? `${verbing('Searching the vault for', 'Searched the vault for')} ${q}`
        : verbing('Searching the vault', 'Searched the vault')
    }
    case 'propose_edit': {
      const h = arg('heading')
      return h
        ? `${verbing('Drafting an edit to', 'Drafted an edit to')} ${h}`
        : verbing('Drafting an edit', 'Drafted an edit')
    }
    case 'answer':
      return verbing('Writing the answer', 'Wrote the answer')
    default:
      return verbing(`Running ${escapeHtml(name)}`, `Ran ${escapeHtml(name)}`)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
