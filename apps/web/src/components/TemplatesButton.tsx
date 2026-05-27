import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Loader2, X, AlertCircle, Plus, Filter } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import { useVault } from '../lib/vault-context'

type TemplateVarDecl = {
  name: string
  label?: string
  help?: string
  type?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number' | 'date'
  default?: string
  options?: string[]
  required?: boolean
}

type Template = {
  path: string
  name: string
  title: string
  bytes: number
  updatedAt: number
  preview: string
  vars: TemplateVarDecl[]
  schedule?: string
}

/** Built-in placeholders the server auto-fills. Must stay in
 *  sync with `BUILTIN_KEYS` in apps/server/src/routes/templates.ts
 *  — the server's /api/templates response includes the
 *  authoritative list, but we mirror it here for the offline
 *  preview path. Excluded from the "you fill" chip row + resolved
 *  inline in the list preview so the user sees what the rendered
 *  doc looks like, not the raw {{template syntax}}. */
const BUILTINS = new Set([
  'date', 'datetime', 'time', 'year', 'month', 'month_name', 'day',
  'weekday', 'week', 'quarter', 'timestamp',
  'title', 'slug', 'user', 'filename', 'folder', 'uuid',
])

/** Turn a slot key into a human-readable label.
 *  `fuel_pct` → `Fuel pct`, `vessel` → `Vessel`, `whyNow` → `Why now`. */
function humanizeSlotName(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNr = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - dayNr + 3)
  const firstThursday = t.getTime()
  t.setUTCMonth(0, 1)
  if (t.getUTCDay() !== 4) {
    t.setUTCMonth(0, 1 + ((4 - t.getUTCDay()) + 7) % 7)
  }
  return 1 + Math.ceil((firstThursday - t.getTime()) / 604800000)
}

type PreviewToken =
  | { kind: 'text'; value: string }
  | { kind: 'slot'; name: string }
  | { kind: 'builtin'; key: string; value: string }

type PreviewLine = {
  level: 'h1' | 'h2' | 'h3' | 'quote' | 'list' | 'normal'
  tokens: PreviewToken[]
}

/** Parse a template body into structured lines for rich rendering.
 *  Built-ins resolve to today's preview values; custom slots become
 *  `{kind: 'slot'}` tokens so the renderer can draw them as inline
 *  chips — way easier to read than raw `{{name}}` or `<name>`.
 *
 *  Also drops the leading `# {{title}}` heading if a template has
 *  one: the card's filename already serves as the title, and the
 *  user picks the doc title in the next step, so showing a fake
 *  "# Untitled" is just noise. */
function parseTemplatePreview(
  raw: string,
): { lines: PreviewLine[]; customs: string[] } {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const builtinValues: Record<string, string> = {
    date: `${yyyy}-${mm}-${dd}`,
    datetime: now.toISOString(),
    time: `${hh}:${mi}`,
    year: String(yyyy),
    month: mm,
    month_name: now.toLocaleDateString('en-US', { month: 'long' }),
    day: dd,
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    week: String(isoWeek(now)).padStart(2, '0'),
    quarter: `Q${Math.floor(now.getMonth() / 3) + 1}`,
    timestamp: String(Math.floor(now.getTime() / 1000)),
    title: 'Untitled',
    slug: 'untitled',
    user: 'you',
    filename: 'untitled',
    folder: '',
    uuid: '·····',
  }
  const customs = new Set<string>()

  // Detect markdown table separator rows (|---|---|, also with
  // colon alignment markers) so we can drop them entirely instead
  // of letting `--- | ---` litter the preview.
  const TABLE_SEPARATOR =
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
  let inFrontmatter = false
  // Pass 1: parse each line into a level + tokens. null = blank.
  const raw1: Array<PreviewLine | null> = []
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    // YAML frontmatter — skip the whole block. Common on imported
    // notes; renders as `---\nkey: val\n---` and is pure metadata
    // noise inside a tiny preview card.
    if (trimmed === '---') {
      inFrontmatter = !inFrontmatter
      raw1.push(null)
      continue
    }
    if (inFrontmatter) {
      raw1.push(null)
      continue
    }
    if (trimmed === '') {
      raw1.push(null)
      continue
    }
    // Drop markdown table separator rows outright — they're pure
    // formatting and never read well as prose.
    if (TABLE_SEPARATOR.test(trimmed)) {
      raw1.push(null)
      continue
    }
    let level: PreviewLine['level'] = 'normal'
    let text = trimmed
    if (text.startsWith('### ')) {
      level = 'h3'
      text = text.slice(4)
    } else if (text.startsWith('## ')) {
      level = 'h2'
      text = text.slice(3)
    } else if (text.startsWith('# ')) {
      level = 'h1'
      text = text.slice(2)
    } else if (text.startsWith('> ')) {
      level = 'quote'
      text = text.slice(2)
    } else if (/^[-*]\s+/.test(text)) {
      level = 'list'
      text = text.replace(/^[-*]\s+/, '')
    }
    // Strip light inline markdown so the preview reads as content,
    // not markdown source. Slots stay intact for the next pass.
    text = text
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|\s)\*([^*]+)\*(?=\s|$|[.,;:!?])/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      // Markdown links [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // For lines that look like markdown table data rows
    // (|col1|col2|...), strip outer pipes and convert inner pipes
    // to " · " so the values stay readable as one line.
    if (/^\|.*\|$/.test(text)) {
      text = text
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' · ')
    }
    // Collapse any stray multi-space runs left behind by stripping.
    text = text.replace(/\s{2,}/g, ' ').trim()
    if (!text) {
      raw1.push(null)
      continue
    }

    const tokens: PreviewToken[] = []
    const re = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) tokens.push({ kind: 'text', value: text.slice(last, m.index) })
      const key = m[1]
      if (BUILTINS.has(key)) {
        tokens.push({
          kind: 'builtin',
          key,
          value: builtinValues[key] ?? `{{${key}}}`,
        })
      } else {
        customs.add(key)
        tokens.push({ kind: 'slot', name: key })
      }
      last = re.lastIndex
    }
    if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) })
    raw1.push({ level, tokens })
  }

  // Pass 2: collapse blank runs + trim edges.
  const collapsed: Array<PreviewLine | null> = []
  let prevBlank = true
  for (const l of raw1) {
    if (l === null) {
      if (!prevBlank) collapsed.push(null)
      prevBlank = true
    } else {
      collapsed.push(l)
      prevBlank = false
    }
  }
  while (collapsed.length && collapsed[0] === null) collapsed.shift()
  while (collapsed.length && collapsed[collapsed.length - 1] === null) collapsed.pop()

  // Drop the leading "# {{title}}" line — see fn docstring.
  if (collapsed.length > 0 && collapsed[0]) {
    const first = collapsed[0]
    const onlyTitle =
      (first.level === 'h1' || first.level === 'h2') &&
      first.tokens.length === 1 &&
      first.tokens[0].kind === 'builtin' &&
      first.tokens[0].key === 'title'
    if (onlyTitle) {
      collapsed.shift()
      if (collapsed.length && collapsed[0] === null) collapsed.shift()
    }
  }

  // Drop blanks from the visible set + cap to 2 lines of content so
  // the card stays compact in the picker list.
  const lines: PreviewLine[] = collapsed
    .filter((l): l is PreviewLine => l !== null)
    .slice(0, 2)

  return { lines, customs: Array.from(customs) }
}

function PreviewTokens({ tokens }: { tokens: PreviewToken[] }) {
  return (
    <>
      {tokens.map((tok, i) => {
        if (tok.kind === 'text') {
          return <span key={i}>{tok.value}</span>
        }
        if (tok.kind === 'builtin') {
          // Resolved built-ins render as ordinary inline text — the
          // user understands these are auto-filled (and the empty
          // state lists them explicitly).
          return <span key={i}>{tok.value}</span>
        }
        // Custom slot — quiet italic muted text so the slot
        // position is visible in context without a loud chip
        // competing with the structured preview around it.
        return (
          <span key={i} className="italic text-subtle opacity-80">
            {tok.name}
          </span>
        )
      })}
    </>
  )
}

function PreviewLines({ lines }: { lines: PreviewLine[] }) {
  return (
    <div>
      {lines.map((line, i) => {
        if (line.level === 'h1') {
          return (
            <div key={i} className="text-[12px] font-semibold text-fg leading-snug truncate">
              <PreviewTokens tokens={line.tokens} />
            </div>
          )
        }
        if (line.level === 'h2' || line.level === 'h3') {
          return (
            <div key={i} className="text-[11.5px] font-semibold text-fg leading-snug truncate">
              <PreviewTokens tokens={line.tokens} />
            </div>
          )
        }
        if (line.level === 'quote') {
          return (
            <div
              key={i}
              className="text-[11px] text-subtle italic pl-2 leading-snug truncate"
              style={{ borderLeft: '2px solid var(--border)' }}
            >
              <PreviewTokens tokens={line.tokens} />
            </div>
          )
        }
        if (line.level === 'list') {
          return (
            <div key={i} className="text-[11px] text-subtle leading-snug truncate pl-2">
              <span className="text-subtle/70">• </span>
              <PreviewTokens tokens={line.tokens} />
            </div>
          )
        }
        return (
          <div key={i} className="text-[11px] text-subtle leading-snug truncate">
            <PreviewTokens tokens={line.tokens} />
          </div>
        )
      })}
    </div>
  )
}

/** Built-ins, grouped for a clean reference card. Within each
 *  group the items render as an aligned 2-column grid so the
 *  placeholder names line up with their values — variable-width
 *  wrapping (the old design) looked chaotic. */
type BuiltinGroup = { label: string; items: Array<[string, string]> }

function computePreviewBuiltinGroups(username: string): BuiltinGroup[] {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  return [
    {
      label: 'Today',
      items: [
        ['date', `${yyyy}-${mm}-${dd}`],
        ['time', `${hh}:${mi}`],
        ['weekday', now.toLocaleDateString('en-US', { weekday: 'long' })],
        ['year', String(yyyy)],
        ['month', `${mm} (${now.toLocaleDateString('en-US', { month: 'long' })})`],
        ['day', dd],
        ['week', String(isoWeek(now)).padStart(2, '0')],
        ['quarter', `Q${Math.floor(now.getMonth() / 3) + 1}`],
        ['datetime', now.toISOString()],
        ['timestamp', String(Math.floor(now.getTime() / 1000))],
      ],
    },
    {
      label: 'You',
      items: [['user', username]],
    },
    {
      label: 'Per document',
      items: [
        ['title', 'picked on next screen'],
        ['slug', 'derived from title'],
        ['filename', 'derived from target path'],
        ['folder', 'derived from target path'],
        ['uuid', 'random ID'],
      ],
    },
  ]
}

/**
 * Reference table showing every built-in placeholder + the value
 * it'll resolve to right now. Flat list with cell borders — no
 * group headers so the user just sees a clean bordered table.
 */
function BuiltinsCard({ username }: { username: string }) {
  const groups = useMemo(() => computePreviewBuiltinGroups(username), [username])
  const items = useMemo(
    () => groups.flatMap((g) => g.items),
    [groups],
  )
  return (
    <div
      className="px-3 py-2.5 border-b shrink-0"
      style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
    >
      <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-2">
        Auto-fills when you create
      </div>
      <table
        className="w-full text-[11px] leading-snug"
        style={{
          borderCollapse: 'collapse',
          border: '1px solid var(--border)',
        }}
      >
        <tbody>
          {items.map(([k, v], i) => (
            <tr
              key={k}
              style={{
                background:
                  i % 2 === 0 ? 'var(--panel)' : 'transparent',
              }}
            >
              <td
                className="px-2 py-1 align-top text-accent whitespace-nowrap w-[1%]"
                style={{ border: '1px solid var(--border)' }}
              >
                {'{{' + k + '}}'}
              </td>
              <td
                className="px-2 py-1 align-top text-fg truncate max-w-0"
                title={v}
                style={{ border: '1px solid var(--border)' }}
              >
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * "New from template" toolbar button. Lists templates the user has
 * stashed under `_templates/*.md` in their vault, lets them pick
 * one, fills the placeholders, and lands the resulting doc in the
 * vault via the same ingest pipeline as upload.
 *
 * Centered modal so the picker feels like a deliberate creation
 * step (mirrors NewFolderButton / UploadDialog) rather than a tiny
 * icon-anchored popover.
 *
 * Two-stage flow: list → confirm with target path + title. The
 * confirm screen offers free-form fields for any `{{custom}}`
 * placeholders detected in the template body so the user doesn't
 * have to ALSO edit the doc after instantiation.
 */
export function TemplatesButton({
  currentDir = '',
  onCreated,
}: {
  currentDir?: string
  onCreated?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Template | null>(null)
  /** Live filter on the template list. Matches against the title,
   *  filename, AND the custom placeholders so the user can find
   *  templates by what they fill in too. */
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  // Confirm-screen state
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { currentUsername } = useVault()
  /** True until the user manually edits the target path. While true,
   *  the path auto-tracks whatever they type in the name field. */
  const [pathTracksName, setPathTracksName] = useState(true)

  useEffect(() => {
    if (!open) return
    setTemplates(null)
    setLoadErr(null)
    setPicked(null)
    setSubmitErr(null)
    setFilter('')
    api
      .listTemplates()
      .then((r) => setTemplates(r.templates))
      .catch((e) => setLoadErr(e instanceof ApiError ? e.message : String(e)))
    // Focus the filter input on open so the user can start typing
    // immediately — matches the ⌘K palette's behavior.
    setTimeout(() => filterRef.current?.focus(), 40)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (picked) setPicked(null)
        else setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, picked])

  // When a template gets picked, pre-fill the target with the
  // current folder + an unobtrusive default filename so the user
  // just hits Enter on a fast path. The confirm screen still lets
  // them edit anything.
  useEffect(() => {
    if (!picked) return
    const dir = currentDir ? currentDir.replace(/\/+$/, '') + '/' : ''
    // If the template's own filename has placeholders, treat that
    // as the user's preferred naming pattern — drop it in as-is so
    // {{date}}, {{slug}}, {{author}}, etc. resolve at create time.
    // Otherwise fall back to the date-stamp + slug convention.
    const filenameHasPlaceholders = /\{\{\s*[a-zA-Z0-9_-]+\s*\}\}/.test(picked.name)
    if (filenameHasPlaceholders) {
      setTarget(`${dir}${picked.name}`)
      // Leave the name field blank for placeholder-filenames so the
      // user picks the title themselves — the template's filename
      // is the naming pattern, not the title.
      setTitle('')
      // Path is encoded by the template, not derived from the name
      // field — disable the auto-tracking nudge.
      setPathTracksName(false)
    } else {
      const today = new Date()
      const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const slug = picked.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      setTarget(`${dir}${stamp}-${slug || 'untitled'}.md`)
      setTitle(picked.title)
      setPathTracksName(true)
    }
    // Build the vars object. The DECLARED schema (frontmatter
    // `vars:`) takes priority — those vars get typed inputs with
    // labels, defaults, and required gating. We still scan the
    // body + filename for `{{slot}}` patterns and add any that
    // weren't declared, so a template author who hasn't bothered
    // to write a schema yet still gets text-input fallbacks.
    const declared = new Map<string, TemplateVarDecl>()
    for (const decl of picked.vars) declared.set(decl.name, decl)

    const found = new Set<string>()
    const re = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g
    for (const src of [picked.preview, picked.name]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        if (!BUILTINS.has(m[1])) found.add(m[1])
      }
    }

    const nextVars: Record<string, string> = {}
    // Declared vars first, so the dialog renders them in author-
    // specified order. Defaults pre-fill so the user can submit
    // immediately when the template is happy with its defaults.
    for (const decl of picked.vars) {
      nextVars[decl.name] = decl.default ?? ''
    }
    // Add any auto-detected slots that weren't declared (lazy
    // template — schema not yet written). Empty value so the user
    // sees an empty field they need to fill.
    for (const k of found) {
      if (!declared.has(k)) nextVars[k] = ''
    }
    setVars(nextVars)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [picked, currentDir])

  const submit = async () => {
    if (!picked) return
    const t = target.trim()
    if (!t) {
      setSubmitErr('Target path is required.')
      return
    }
    // Client-side required-var gate so the user sees a clean error
    // here instead of a 400 from the server. The server still
    // re-checks — this is a UX shortcut, not a security boundary.
    const missing = picked.vars
      .filter((d) => d.required)
      .filter((d) => (vars[d.name] ?? '').trim() === '')
      .map((d) => d.label ?? humanizeSlotName(d.name))
    if (missing.length > 0) {
      setSubmitErr(`Fill in: ${missing.join(', ')}`)
      return
    }
    setSubmitting(true)
    setSubmitErr(null)
    try {
      const r = await api.instantiateTemplate({
        template: picked.path,
        target: t,
        title: title.trim() || undefined,
        vars: Object.keys(vars).length > 0 ? vars : undefined,
      })
      setOpen(false)
      setPicked(null)
      onCreated?.()
      // Jump to the new doc.
      const clean = r.document.storageKey.replace(/^\/+/, '')
      navigate(`/${clean}`)
    } catch (e) {
      setSubmitErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-hover text-subtle hover:text-fg transition-colors"
        onClick={() => setOpen(true)}
        title="New from template"
        aria-label="New from template"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <FileText size={13} />
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] px-4"
          style={{ background: 'var(--scrim)' }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-[480px] rounded-lg shadow-card overflow-hidden flex flex-col outline-none"
            style={{ background: 'var(--panel)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2.5 px-4 h-12 border-b shrink-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <FileText size={15} className="text-accent" />
              <div className="text-[13.5px] font-medium text-fg">
                {picked ? `New from "${picked.title}"` : 'New from template'}
              </div>
              <div className="flex-1" />
              <button
                className="btn-ghost h-7 w-7 px-0"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={13} />
              </button>
            </div>

            {!picked && (() => {
              // Pre-compute filtered list outside the JSX so the
              // footer status text can show the visible count.
              const q = filter.trim().toLowerCase()
              const filtered = (templates ?? [])
                .map((t) => {
                  const { lines, customs } = parseTemplatePreview(t.preview)
                  const haystacks = [
                    t.title.toLowerCase(),
                    t.name.toLowerCase(),
                    ...customs.map((c) => c.toLowerCase()),
                  ]
                  const hit = q === '' || haystacks.some((h) => h.includes(q))
                  return { t, lines, hit }
                })
                .filter((x) => x.hit)
              const hasTemplates = !!templates && templates.length > 0
              return (
                <>
                  {hasTemplates && (
                    <div
                      className="px-4 py-4 border-b shrink-0"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                        Filter
                      </div>
                      <div className="relative">
                        <Filter
                          size={13}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
                        />
                        <input
                          ref={filterRef}
                          className="input pl-8 pr-7 h-8 text-[13px]"
                          placeholder="Type to filter…"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape' && filter) {
                              e.preventDefault()
                              setFilter('')
                            }
                          }}
                        />
                        {filter && (
                          <button
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 btn-ghost h-6 w-6 px-0"
                            onClick={() => {
                              setFilter('')
                              filterRef.current?.focus()
                            }}
                            aria-label="Clear filter"
                          >
                            <X size={11} />
                          </button>
                        )}
                      </div>
                      <div className="text-[11px] text-subtle mt-1.5">
                        Matches name, filename, or fillable slot.
                      </div>
                    </div>
                  )}
                  <div className="max-h-[260px] overflow-y-auto py-1 shrink-0">
                    {hasTemplates && (
                      <div className="px-4 pt-1 pb-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                        Templates
                      </div>
                    )}
                    {templates == null && !loadErr && (
                      <div className="text-[12px] text-subtle flex items-center gap-1.5 px-4 py-2">
                        <Loader2 size={12} className="animate-spin" /> Loading templates…
                      </div>
                    )}
                    {loadErr && (
                      <div
                        className="mx-3 my-2 px-2 py-1.5 rounded text-[12px] flex items-start gap-1.5"
                        style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
                      >
                        <AlertCircle size={12} className="mt-0.5 shrink-0" />
                        {loadErr}
                      </div>
                    )}
                    {templates && templates.length === 0 && (
                      <div className="text-[12.5px] text-fg leading-snug px-4 py-3 space-y-2">
                        <div>
                          No templates yet. Create one by saving a markdown file to
                          {' '}<span className="text-accent">_templates/</span>{' '}
                          in your vault. Anything you write in <span className="text-accent">{'{{double-braces}}'}</span> becomes
                          a fillable slot.
                        </div>
                        <BuiltinsCard username={currentUsername} />
                      </div>
                    )}
                    {hasTemplates && filtered.length === 0 && (
                      <div className="text-[12px] text-subtle px-4 py-3">
                        No templates match <span className="text-fg font-medium">{filter}</span>.
                      </div>
                    )}
                    {hasTemplates && filtered.length > 0 && (
                      <ul>
                        {filtered.map(({ t, lines }) => (
                          <li key={t.path}>
                            <button
                              type="button"
                              onClick={() => setPicked(t)}
                              className="w-full text-left px-3 py-1.5 mx-1 rounded transition-colors hover:bg-hover flex items-start gap-2"
                              style={{ width: 'calc(100% - 0.5rem)' }}
                            >
                              <FileText size={13} className="text-accent shrink-0 mt-0.5" />
                              <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] text-fg truncate">
                                  {t.title}
                                </div>
                                {lines.length > 0 && (
                                  <div className="mt-0.5 text-[11px] text-subtle truncate">
                                    <PreviewLines lines={lines.slice(0, 1)} />
                                  </div>
                                )}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div
                    className="flex items-center gap-2 px-4 py-3 shrink-0"
                    style={{ borderTop: '1px solid var(--border)', background: 'var(--panel-2)' }}
                  >
                    <div className="flex-1 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                      {hasTemplates
                        ? `${filtered.length} of ${templates!.length} template${templates!.length === 1 ? '' : 's'}`
                        : ' '}
                    </div>
                    <button className="btn-ghost h-7" onClick={() => setOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </>
              )
            })()}

            {picked && (
              <>
                <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                    Name
                  </div>
                  <input
                    ref={inputRef}
                    className="input h-8 text-[13px]"
                    value={title}
                    onChange={(e) => {
                      const v = e.target.value
                      setTitle(v)
                      // Auto-derive path from the name until the
                      // user takes manual control. Keeps the common
                      // case zero-effort while preserving overrides.
                      if (pathTracksName) {
                        const today = new Date()
                        const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
                        const slug = v
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')
                          .replace(/^-+|-+$/g, '')
                        const dir = currentDir ? currentDir.replace(/\/+$/, '') + '/' : ''
                        setTarget(`${dir}${stamp}-${slug || 'untitled'}.md`)
                      }
                    }}
                    placeholder="e.g. Q3 Planning"
                  />
                </div>
                <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                    Save as
                  </div>
                  <input
                    className="input h-8 text-[13px]"
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value)
                      setPathTracksName(false)
                    }}
                    placeholder="folder/file.md"
                  />
                </div>
                {Object.keys(vars).length > 0 && (
                  <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                      Fields
                    </div>
                    <div className="space-y-3">
                      {Object.keys(vars).map((k) => {
                        // Match declared schema (if any) by name —
                        // gives this field its widget type, label,
                        // options, required flag. Auto-detected
                        // slots fall through to the plain text path.
                        const decl = picked.vars.find((d) => d.name === k)
                        const label = decl?.label ?? humanizeSlotName(k)
                        const required = decl?.required ?? false
                        const help = decl?.help
                        const value = vars[k]
                        const setValue = (v: string) =>
                          setVars((cur) => ({ ...cur, [k]: v }))
                        const labelEl = (
                          <div className="flex items-center gap-1 text-[11.5px] mb-1">
                            <span style={{ color: 'var(--fg-subtle)' }}>{label}</span>
                            {required && (
                              <span
                                title="required"
                                style={{ color: '#BF2600' }}
                                aria-label="required"
                              >
                                *
                              </span>
                            )}
                          </div>
                        )
                        const helpEl = help ? (
                          <div
                            className="text-[10.5px] mt-1"
                            style={{ color: 'var(--fg-subtle)' }}
                          >
                            {help}
                          </div>
                        ) : null
                        if (decl?.type === 'select' && decl.options?.length) {
                          return (
                            <div key={k}>
                              {labelEl}
                              <select
                                className="input h-8 text-[13px]"
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                              >
                                {!required && <option value="">—</option>}
                                {decl.options.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                              {helpEl}
                            </div>
                          )
                        }
                        if (decl?.type === 'checkbox') {
                          // Encode as "true"/"" so the engine's
                          // truthy check stays consistent with what
                          // an agent caller would pass.
                          const checked = value.trim().toLowerCase() === 'true'
                          return (
                            <label
                              key={k}
                              className="flex items-center gap-2 text-[13px]"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) =>
                                  setValue(e.target.checked ? 'true' : '')
                                }
                              />
                              <span style={{ color: 'var(--fg)' }}>{label}</span>
                              {required && (
                                <span style={{ color: '#BF2600' }} aria-label="required">
                                  *
                                </span>
                              )}
                              {help && (
                                <span
                                  className="text-[10.5px] ml-auto"
                                  style={{ color: 'var(--fg-subtle)' }}
                                >
                                  {help}
                                </span>
                              )}
                            </label>
                          )
                        }
                        if (decl?.type === 'textarea') {
                          return (
                            <div key={k}>
                              {labelEl}
                              <textarea
                                className="input text-[13px] min-h-[72px]"
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                placeholder={label}
                              />
                              {helpEl}
                            </div>
                          )
                        }
                        const htmlType: 'text' | 'number' | 'date' =
                          decl?.type === 'number'
                            ? 'number'
                            : decl?.type === 'date'
                              ? 'date'
                              : 'text'
                        return (
                          <div key={k}>
                            {labelEl}
                            <input
                              type={htmlType}
                              className="input h-8 text-[13px]"
                              value={value}
                              onChange={(e) => setValue(e.target.value)}
                              placeholder={label}
                            />
                            {helpEl}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div
                  className="flex items-center gap-2 px-4 py-3"
                  // The preceding section (SAVE AS or FIELDS) always
                  // ends with its own `border-b`, so we don't add a
                  // matching `borderTop` here — would stack into a
                  // visible double line. The panel-2 background is
                  // enough on its own to distinguish the action row.
                  style={{ background: 'var(--panel-2)' }}
                >
                  <div
                    className="flex-1 text-[11.5px]"
                    style={submitErr ? { color: '#BF2600' } : { color: 'var(--fg-subtle)' }}
                  >
                    {submitErr ?? (target.trim() ? `Creates /${target.trim()}` : 'Pick a name to continue')}
                  </div>
                  <button
                    className="btn-ghost h-7"
                    onClick={() => setPicked(null)}
                    disabled={submitting}
                  >
                    Back
                  </button>
                  <button
                    className="btn-primary h-7"
                    onClick={submit}
                    disabled={submitting || !target.trim()}
                  >
                    {submitting ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Creating…
                      </>
                    ) : (
                      <>
                        <Plus size={12} />
                        Create
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
