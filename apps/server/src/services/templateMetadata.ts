/**
 * Parse YAML frontmatter out of a template file and turn it into a
 * structured TemplateMetadata. The web "New from template" dialog
 * uses this to render typed inputs instead of plain text boxes for
 * every detected slot; the scheduler service uses the same shape to
 * read `schedule:` + `schedule_vars:` declarations.
 *
 * Frontmatter is recognised the conventional way: a leading `---`
 * line, YAML body, closing `---`. Anything before the closer is
 * treated as metadata; the rest is the template body the engine
 * renders.
 *
 *   ---
 *   vars:
 *     - name: type
 *       label: Workout type
 *       type: select
 *       options: [Upper Body, Lower Body, Cardio]
 *       required: true
 *     - name: notes
 *       type: textarea
 *   schedule: "0 6 * * 1,4"
 *   schedule_vars:
 *     type: Upper Body
 *   ---
 *
 * Unknown keys are tolerated (forward-compat). Malformed YAML is
 * NOT a fatal error — we fall back to "no metadata" so a template
 * that happens to start with `---` (a horizontal rule!) still
 * renders. Callers can opt into strict parsing via `parseStrict`.
 */
import { parse as parseYaml, type YAMLError } from 'yaml'

export type TemplateVarType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'number'
  | 'date'

export interface TemplateVarDecl {
  /** The placeholder name as referenced in `{{name}}`. */
  name: string
  /** Optional human-readable label. Falls back to a humanised name. */
  label?: string
  /** Optional longer hint shown beneath the input. */
  help?: string
  /** Input widget hint for the web dialog. Default `'text'`. */
  type?: TemplateVarType
  /** Default value pre-filled into the input. */
  default?: string
  /** Allowed values when `type: select`. */
  options?: string[]
  /** When true, the dialog blocks submit if the field is empty. */
  required?: boolean
}

/** One scheduled fire of a template. A template can declare any
 *  number of these via `schedules:` (or a single one via the
 *  legacy top-level `schedule:`+`schedule_vars:`). The scheduler
 *  treats each entry as an independent unit — its own cron, its
 *  own vars, its own target path. Lets a single workout-log
 *  template fire one cron for Upper Body + a second cron for
 *  Lower Body + a third for Cardio, each producing a doc that
 *  activates a different `{{#if type == …}}` branch in the body. */
export interface ScheduledFire {
  /** 5-field cron expression. Required. */
  cron: string
  /** Vars passed to the engine when this entry fires. */
  vars?: Record<string, string>
  /** Path template (or static path). Defaults to a date-stamped
   *  filename derived from the template's own name. */
  path?: string
  /** Title template for the resulting doc. */
  title?: string
  /** Optional human-friendly label so the admin UI can name the
   *  entry (otherwise we render the cron as the heading). */
  label?: string
  /** IANA timezone the cron should be evaluated in (e.g.
   *  `Asia/Kolkata`). Without this, cron-parser uses the server
   *  process's TZ — which in a typical container is UTC, so a
   *  user who wrote `0 6 * * 1,4` expecting their local 6 AM
   *  would see the fire happen at 6 AM UTC. Per-schedule
   *  override; falls back to the file-level `tz`, then
   *  `READER_DEFAULT_TZ`, then the server TZ. */
  tz?: string
}

export interface TemplateMetadata {
  /** Variable schema, if declared. Empty array = no schema (UI
   *  falls back to auto-detected slots). */
  vars: TemplateVarDecl[]
  /** All scheduled-fire entries, normalised. The parser folds the
   *  legacy single-`schedule:`/`schedule_vars:` shape into a
   *  one-entry array, so the scheduler only has to handle one
   *  case. Empty array = no scheduling. */
  schedules: ScheduledFire[]
  /** Legacy convenience getter. Set when the file used the old
   *  single-schedule shape. Surfaced in list_templates so a
   *  client expecting the old shape keeps working. */
  schedule?: string
  /** File-level default timezone for all `schedules[]` entries
   *  that don't override `tz` themselves. */
  tz?: string
}

export interface TemplateParseResult {
  metadata: TemplateMetadata
  body: string
}

/** Split `---` frontmatter from the template body. Returns the raw
 *  YAML string (or null if no frontmatter) and the body that
 *  remains. Tolerant of trailing whitespace after the openers and
 *  CRLF line endings; rejects a `---` that doesn't have a matching
 *  closer so a horizontal rule at the top of the file isn't
 *  mis-detected as metadata. */
function splitFrontmatter(src: string): { yaml: string | null; body: string } {
  // Allow a UTF-8 BOM before the opener; some editors prepend one.
  const trimmed = src.startsWith('﻿') ? src.slice(1) : src
  const openMatch = trimmed.match(/^---\s*\r?\n/)
  if (!openMatch) return { yaml: null, body: src }
  const after = trimmed.slice(openMatch[0].length)
  // Find the closing `---` on its own line. We require it on its
  // own line (not inline) to avoid eating content with a literal
  // `---` somewhere inside.
  const closer = after.match(/\r?\n---\s*(\r?\n|$)/)
  if (!closer) return { yaml: null, body: src }
  const yaml = after.slice(0, closer.index!)
  const body = after.slice(closer.index! + closer[0].length)
  return { yaml, body }
}

/** Coerce a YAML scalar to the string our vars schema expects.
 *  We accept booleans + numbers so a `default: true` doesn't fail
 *  the schema check, but everything ends up stringified before
 *  reaching the engine (which only speaks strings). */
function coerceString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  return String(v)
}

function coerceVarDecl(raw: unknown): TemplateVarDecl | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return null
  const decl: TemplateVarDecl = { name }
  if (typeof r.label === 'string') decl.label = r.label
  if (typeof r.help === 'string') decl.help = r.help
  if (typeof r.type === 'string') {
    const t = r.type as TemplateVarType
    if (['text', 'textarea', 'select', 'checkbox', 'number', 'date'].includes(t)) {
      decl.type = t
    }
  }
  if (r.default != null) decl.default = coerceString(r.default)
  if (Array.isArray(r.options)) {
    decl.options = r.options.map(coerceString).filter((s) => s.length > 0)
  }
  if (typeof r.required === 'boolean') decl.required = r.required
  return decl
}

function coerceScheduleEntry(raw: unknown): ScheduledFire | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const cron = typeof r.cron === 'string' ? r.cron.trim() : ''
  if (!cron) return null
  const entry: ScheduledFire = { cron }
  if (r.vars && typeof r.vars === 'object') {
    const vars: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.vars as Record<string, unknown>)) {
      vars[k] = coerceString(v)
    }
    entry.vars = vars
  }
  if (typeof r.path === 'string' && r.path.trim()) entry.path = r.path.trim()
  if (typeof r.title === 'string' && r.title.trim()) entry.title = r.title.trim()
  if (typeof r.label === 'string' && r.label.trim()) entry.label = r.label.trim()
  if (typeof r.tz === 'string' && r.tz.trim()) entry.tz = r.tz.trim()
  return entry
}

function coerceMetadata(raw: unknown): TemplateMetadata {
  const meta: TemplateMetadata = { vars: [], schedules: [] }
  if (!raw || typeof raw !== 'object') return meta
  const r = raw as Record<string, unknown>
  if (Array.isArray(r.vars)) {
    for (const item of r.vars) {
      const decl = coerceVarDecl(item)
      if (decl) meta.vars.push(decl)
    }
  }
  if (typeof r.tz === 'string' && r.tz.trim()) meta.tz = r.tz.trim()
  // New shape: `schedules:` array of full fire configs.
  if (Array.isArray(r.schedules)) {
    for (const item of r.schedules) {
      const entry = coerceScheduleEntry(item)
      if (entry) meta.schedules.push(entry)
    }
  }
  // Legacy shape: single top-level `schedule:` + `schedule_vars:`
  // + `schedule_path:` + `schedule_title:`. Fold into a one-entry
  // schedules array so the scheduler only handles one case. Surface
  // `meta.schedule` too for clients that still read the old field.
  if (typeof r.schedule === 'string' && r.schedule.trim()) {
    const entry: ScheduledFire = { cron: r.schedule.trim() }
    if (r.schedule_vars && typeof r.schedule_vars === 'object') {
      const vars: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.schedule_vars as Record<string, unknown>)) {
        vars[k] = coerceString(v)
      }
      entry.vars = vars
    }
    if (typeof r.schedule_path === 'string' && r.schedule_path.trim()) {
      entry.path = r.schedule_path.trim()
    }
    if (typeof r.schedule_title === 'string' && r.schedule_title.trim()) {
      entry.title = r.schedule_title.trim()
    }
    meta.schedules.push(entry)
    meta.schedule = entry.cron
  }
  return meta
}

/** Parse a template source into metadata + body. Malformed YAML
 *  yields `{ metadata: { vars: [] }, body: src }` — i.e. we treat
 *  the file as if it had no frontmatter at all rather than erroring
 *  out. The web dialog will fall back to auto-detecting slots in
 *  the body, which is what every existing template relies on. */
export function parseTemplateSource(src: string): TemplateParseResult {
  const { yaml, body } = splitFrontmatter(src)
  if (!yaml) return { metadata: { vars: [], schedules: [] }, body: src }
  try {
    const parsed = parseYaml(yaml) as unknown
    return { metadata: coerceMetadata(parsed), body }
  } catch {
    return { metadata: { vars: [], schedules: [] }, body: src }
  }
}

/** Merge caller-provided vars with declared defaults. Caller values
 *  win — defaults only fill gaps. Returns a fresh object; callers
 *  can spread additional layers (builtins, request-time stamps) on
 *  top before passing to the engine.
 *
 *  Required-var validation happens at the route layer, not here:
 *  the scheduler service wants the same merge logic but treats
 *  missing-required as a "skip this fire" rather than throwing.
 *  Letting callers decide policy keeps this pure. */
export function applyVarDefaults(
  metadata: TemplateMetadata,
  vars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const decl of metadata.vars) {
    if (decl.default != null) out[decl.name] = decl.default
  }
  return { ...out, ...vars }
}

/** Names of declared vars that are flagged required AND missing
 *  (or empty) in the supplied vars object. Caller-facing error
 *  messages typically read better when they list every missing
 *  field at once instead of failing on the first one. */
export function missingRequiredVars(
  metadata: TemplateMetadata,
  vars: Record<string, string>,
): string[] {
  const missing: string[] = []
  for (const decl of metadata.vars) {
    if (!decl.required) continue
    const v = vars[decl.name]
    if (v == null || String(v).trim() === '') missing.push(decl.name)
  }
  return missing
}

/** Strict variant: throws on malformed YAML. Used by save-as-template
 *  and the scheduler so a typo in a template's metadata surfaces as
 *  a 400 instead of silently disabling its schedule. */
export function parseTemplateSourceStrict(
  src: string,
): TemplateParseResult {
  const { yaml, body } = splitFrontmatter(src)
  if (!yaml) return { metadata: { vars: [], schedules: [] }, body: src }
  try {
    const parsed = parseYaml(yaml) as unknown
    return { metadata: coerceMetadata(parsed), body }
  } catch (e) {
    const msg = (e as YAMLError)?.message ?? String(e)
    throw new Error(`template frontmatter is malformed YAML: ${msg}`)
  }
}
