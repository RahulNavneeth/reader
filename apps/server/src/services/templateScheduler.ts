/**
 * Scheduled template instantiation. Walks every user's `_templates/`
 * directory once a minute, parses frontmatter, and auto-instantiates
 * any template whose `schedule:` cron expression has fired since the
 * last tick.
 *
 * Frontmatter shape (see templateMetadata.ts for the full schema):
 *
 *   ---
 *   schedule: "0 6 * * 1,4"           # standard 5-field cron
 *   schedule_vars:                    # vars passed to the engine
 *     type: Upper Body
 *     upper: "true"
 *   schedule_path: "logs/{{date}}-workout.md"  # where to write
 *   schedule_title: "Workout {{date}}"          # optional title
 *   ---
 *
 * Design notes:
 *   - Tick granularity is 1 minute. Fine for cron — its smallest
 *     unit is also 1 minute. Coarser would miss intra-minute fires;
 *     finer wastes CPU.
 *   - Per-template state (lastFiredAt, lastError) lives in a JSON
 *     file under `dataDir/template-schedule-state.json`. Survives
 *     restarts so a process bounce doesn't fire every scheduled
 *     template at boot.
 *   - Source of truth is the template's frontmatter. No admin DB
 *     override — to disable a schedule, edit / remove the
 *     `schedule:` line in the template. This keeps the user model
 *     simple ("the .md file is the config") and matches how the
 *     rest of Reader works.
 *   - Fire policy: "missed fires don't catch up". If the server was
 *     down at 6 AM and you boot at 6:30, today's fire is skipped —
 *     `nextFireAt` rolls forward to tomorrow. Caller can still hit
 *     the manual run-now endpoint to trigger one immediately.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import parser from 'cron-parser'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import { audit } from '../stores/audit.js'
import { listUsers } from '../stores/users.js'
import { userVaultRoot } from '../lib/userVault.js'
import { applyTemplate, applyTemplateAsync } from './templateEngine.js'
import {
  parseTemplateSource,
  applyVarDefaults,
  missingRequiredVars,
  type ScheduledFire,
  type TemplateMetadata,
} from './templateMetadata.js'
import { computeBuiltins } from '../routes/templates.js'
import {
  makeVaultIncludeResolver,
  makeUrlFetchResolver,
} from './templateResolvers.js'
import { listAllDocuments, loadMeta, saveMeta } from '../stores/documents.js'
import type { DocumentMeta } from '../types.js'
import { broadcastEdit, flushDocSync } from './crdtRegistry.js'
import { nanoid } from 'nanoid'

async function findDocByPath(
  owner: string,
  storageKey: string,
): Promise<DocumentMeta | null> {
  const all = await listAllDocuments()
  return all.find((d) => d.owner === owner && d.storageKey === storageKey) ?? null
}

const STATE_FILE = path.join(config.dataDir, 'template-schedule-state.json')
const TICK_MS = 60_000

export interface ScheduledTemplateState {
  /** key: `${owner}::${templateRelPath}::${cronExpr}`
   *
   *  Keying on the cron expression keeps state stable when the
   *  author reorders their `schedules:` array — vs keying on array
   *  index, which would orphan state on every edit. The downside
   *  is two entries with the exact same cron expression in the
   *  same template share state, but that's a niche case (and
   *  collapsing them is arguably the right behavior anyway). */
  entries: Record<
    string,
    {
      lastFiredAt: number | null
      lastSuccessAt: number | null
      lastError: string | null
      lastTarget: string | null
      /** Wall-clock the scheduler first observed this entry. The
       *  tick uses this as the lower bound for the cron window so
       *  a brand-new entry doesn't backfill historical fires —
       *  but, crucially, ONLY for that first tick. The previous
       *  logic anchored `since` to `now` on every tick where
       *  `lastFiredAt` was null, so a never-yet-fired schedule
       *  could never fire at all (the window was always
       *  collapsed to a single instant). Persisting
       *  `firstSeenAt` instead lets the window grow normally
       *  from the first sighting onward. */
      firstSeenAt: number | null
    }
  >
  /** ISO timestamp of the last scheduler tick. Used as the lower
   *  bound when computing "did this cron fire since we last
   *  looked." Set on every tick regardless of whether anything
   *  fired so a long downtime is correctly absorbed. */
  lastTickAt: number | null
}

export interface ScheduledTemplateView {
  owner: string
  template: string
  /** Cron expression — uniquely identifies this entry within the
   *  template for the admin UI's Run-now button. */
  cron: string
  /** Optional author-supplied label for the entry; falls back to
   *  the cron expression on the UI side. */
  label?: string
  nextFireAt: number | null
  lastFiredAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  lastTarget: string | null
  vars: Record<string, string>
  /** Resolved (sample) path the next fire would write to. */
  pathPreview: string
}

let timer: NodeJS.Timeout | null = null
let running = false

function entryKey(owner: string, templateRel: string, cron: string): string {
  return `${owner}::${templateRel}::${cron}`
}

async function loadState(): Promise<ScheduledTemplateState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as ScheduledTemplateState
    if (parsed && typeof parsed === 'object' && parsed.entries) return parsed
  } catch {/* fall through to empty */}
  return { entries: {}, lastTickAt: null }
}

async function saveState(s: ScheduledTemplateState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
}

/** Resolve the IANA TZ a schedule should be interpreted in. Per-
 *  schedule `tz:` wins, then the file-level `tz:` default, then
 *  the `READER_DEFAULT_TZ` env var, then undefined (which makes
 *  cron-parser use the server process TZ — typically UTC in a
 *  container). Centralised so every cron evaluation goes through
 *  the same precedence. */
function resolveCronTz(
  scheduleTz: string | undefined,
  fileTz: string | undefined,
): string | undefined {
  return (
    scheduleTz?.trim() ||
    fileTz?.trim() ||
    process.env.READER_DEFAULT_TZ?.trim() ||
    undefined
  )
}

/** Compute the cron's next fire after `from`. Returns null when the
 *  expression is malformed — the scheduler treats null as "skip this
 *  template" and records the error in state. */
export function nextFireAfter(
  expr: string,
  from: Date,
  tz?: string,
): Date | null {
  try {
    const it = parser.parseExpression(expr, {
      currentDate: from,
      ...(tz ? { tz } : {}),
    })
    return it.next().toDate()
  } catch {
    return null
  }
}

/** Did `expr` fire at least once strictly between `prev` and `now`?
 *  Used to decide whether this tick should instantiate. */
export function firedBetween(
  expr: string,
  prev: Date,
  now: Date,
  tz?: string,
): boolean {
  const next = nextFireAfter(expr, prev, tz)
  if (!next) return false
  return next.getTime() > prev.getTime() && next.getTime() <= now.getTime()
}

/** Enumerate every fire of `expr` strictly within `[from, to]`. Hard
 *  cap at `limit` to keep a poorly-bounded `* * * * *` expression
 *  from blowing up. Returns the Date instances in chronological
 *  order. Used by the calendar to surface upcoming scheduled
 *  templates without redoing the cron math client-side. */
export function firesBetween(
  expr: string,
  from: Date,
  to: Date,
  tz?: string,
  limit = 5000,
): Date[] {
  try {
    // Don't pass cron-parser's `endDate` option — it has bitten us
    // before, exhausting after the first iteration window even when
    // many fires remain. Iterate manually and bail when the next
    // date crosses `to`.
    const it = parser.parseExpression(expr, {
      currentDate: from,
      ...(tz ? { tz } : {}),
    })
    const out: Date[] = []
    while (out.length < limit) {
      let d: Date
      try {
        d = it.next().toDate()
      } catch {
        break
      }
      if (d.getTime() > to.getTime()) break
      out.push(d)
    }
    return out
  } catch {
    return []
  }
}

/** Return the set of calendar days (YYYY-MM-DD in the schedule's
 *  tz) that `expr` fires on within `[from, to]`. Walks the cron in
 *  per-day hops: after finding a fire on day X, the cursor jumps to
 *  the start of day X+1 instead of iterating every minute. This
 *  keeps `* * * * *` from blowing up — it now does ~365 iterations
 *  per year instead of ~525k.
 *
 *  Returned days are unique and chronologically sorted. */
export function firingDays(
  expr: string,
  from: Date,
  to: Date,
  tz?: string,
  maxDays = 1500,
): string[] {
  try {
    const seen = new Set<string>()
    let cursor = new Date(from.getTime())
    while (seen.size < maxDays) {
      let next: Date
      try {
        const it = parser.parseExpression(expr, {
          currentDate: cursor,
          ...(tz ? { tz } : {}),
        })
        next = it.next().toDate()
      } catch {
        break
      }
      if (next.getTime() > to.getTime()) break
      const ymd = formatYmd(next, tz)
      seen.add(ymd)
      // Hop cursor to the start of the next civil day after `next`,
      // in the SCHEDULE'S timezone — otherwise a 23:00 IST fire
      // would advance to 18:30 UTC, still inside the same IST day,
      // and we'd refind it. Compute the next-day boundary by
      // formatting `next` in tz, parsing it back, and adding 24h.
      cursor = startOfNextDayInTz(next, tz)
    }
    return Array.from(seen).sort()
  } catch {
    return []
  }
}

function startOfNextDayInTz(d: Date, tz?: string): Date {
  // Build YYYY-MM-DD in the target tz, then add a day. Doing the
  // jump in civil-day terms (not raw ms) keeps us correct across
  // DST and offset boundaries.
  const ymd = formatYmd(d, tz)
  const [y, m, day] = ymd.split('-').map((n) => Number(n))
  // Construct a Date at local midnight then add a day; cron-parser
  // will normalize through the tz. Adding 24h via getTime() is fine
  // here because we only need cursor to be inside the NEXT day's
  // window — sub-second precision doesn't matter.
  const local = new Date(y, m - 1, day, 0, 0, 0, 0)
  return new Date(local.getTime() + 24 * 60 * 60 * 1000)
}

interface ScheduledTemplate {
  owner: string
  templateRel: string
  templateAbs: string
  metadata: TemplateMetadata
  body: string
}

export interface TemplateParseError {
  owner: string
  template: string
  error: string
}

async function discoverScheduledTemplates(): Promise<{
  templates: ScheduledTemplate[]
  errors: TemplateParseError[]
}> {
  const out: ScheduledTemplate[] = []
  const errors: TemplateParseError[] = []
  const users = await listUsers()
  // Lazy import so this module doesn't pull templateMetadata in
  // until first use — keeps cold start cheap.
  const { parseTemplateSourceStrict } = await import('./templateMetadata.js')
  for (const u of users) {
    const root = path.join(userVaultRoot(u.username), '_templates')
    // Recursive walk so templates nested under `_templates/<folder>/…`
    // get picked up by the scheduler too. Earlier non-recursive
    // readdir only saw top-level `_templates/*.md` and silently
    // skipped folder-grouped templates (the user organises by
    // course / project subfolder and was surprised those weren't
    // scheduling).
    type Found = { abs: string; rel: string }
    const found: Found[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          await walk(abs)
        } else if (
          e.isFile() &&
          /\.(md|markdown|mdx)$/i.test(e.name)
        ) {
          const rel = path.relative(root, abs).split(path.sep).join('/')
          found.push({ abs, rel })
        }
      }
    }
    await walk(root)
    for (const { abs: templateAbs, rel: relUnderTemplates } of found) {
      const templateRel = `_templates/${relUnderTemplates}`
      const src = await readFile(templateAbs, 'utf8').catch(() => '')
      if (!src) continue
      // Only flag a parse error when the file ACTUALLY has a
      // frontmatter opener. A loose markdown note that just
      // happens to start with `---` (the closer match fails) is
      // not a malformed template — it's a non-template, and the
      // strict parser would return cleanly too.
      const hasOpener = /^---\s*\r?\n/.test(src.startsWith('﻿') ? src.slice(1) : src)
      if (hasOpener) {
        try {
          parseTemplateSourceStrict(src)
        } catch (err) {
          errors.push({
            owner: u.username,
            template: templateRel,
            error: (err as Error).message,
          })
          continue
        }
      }
      const parsed = parseTemplateSource(src)
      // No schedule entries → not relevant to the scheduler.
      // (vars-only declarations still load fine through the
      // normal "New from template" flow.)
      if (parsed.metadata.schedules.length === 0) continue
      out.push({
        owner: u.username,
        templateRel,
        templateAbs,
        metadata: parsed.metadata,
        body: parsed.body,
      })
    }
  }
  return { templates: out, errors }
}

function defaultSchedulePath(templateName: string): string {
  // logs/{{date}}-<templatebase>.md — date-stamps to avoid
  // overwrites on the next fire. Author can override via
  // `schedule_path:` in the frontmatter.
  const base = templateName.replace(/^_templates\//, '').replace(
    /\.(md|markdown|mdx)$/i,
    '',
  )
  return `logs/{{date}}-${base}.md`
}

/** Actually instantiate the template for a single scheduled-fire
 *  entry. Mirrors the route layer's create-new path: stub meta →
 *  broadcastEdit → flushDocSync, so the resulting doc lands through
 *  the same materialiser the rest of Reader uses. */
async function fire(
  tpl: ScheduledTemplate,
  entry: ScheduledFire,
  log: FastifyBaseLogger,
): Promise<{ targetRel: string }> {
  const pathTpl = entry.path ?? defaultSchedulePath(tpl.templateRel)
  const titleTpl = entry.title ?? ''
  const callerVars = entry.vars ?? {}
  const builtins = computeBuiltins({
    now: new Date(),
    title: titleTpl || tpl.templateRel,
    user: tpl.owner,
    targetRel: pathTpl,
  })
  const withDefaults = applyVarDefaults(tpl.metadata, callerVars)
  const fullVars = { ...builtins, ...withDefaults }
  const missing = missingRequiredVars(tpl.metadata, fullVars)
  if (missing.length > 0) {
    throw new Error(
      `template scheduler: missing required var(s) ${missing.join(', ')}`,
    )
  }
  const targetRel = applyTemplate(pathTpl, fullVars).replace(/^\/+|\/+$/g, '')
  const renderedTitle = titleTpl ? applyTemplate(titleTpl, fullVars) : ''
  const rendered = await applyTemplateAsync(tpl.body, fullVars, {
    loadInclude: makeVaultIncludeResolver(tpl.owner),
    loadFetch: makeUrlFetchResolver(),
  })

  // Skip-and-log when the target path is already occupied. The
  // expectation for a scheduled template is "new doc each fire" —
  // overwriting an existing doc would surprise the user. Author
  // can defuse with a `{{date}}`-stamped `path:`.
  const existing = await findDocByPath(tpl.owner, targetRel)
  if (existing) {
    throw new Error(
      `target ${targetRel} already exists — use {{date}}, {{datetime}}, or {{timestamp}} in the path to avoid collisions`,
    )
  }

  const now = Date.now()
  const id = nanoid()
  const stub: DocumentMeta = {
    id,
    owner: tpl.owner,
    storageKey: targetRel,
    title: renderedTitle || path.basename(targetRel, path.extname(targetRel)),
    originalFilename: path.basename(targetRel),
    mime: 'text/markdown',
    bytes: 0,
    sha256: '',
    createdAt: now,
    updatedAt: now,
    acl: { readers: [], editors: [] },
    tags: [],
    ingest: { status: 'pending', embedded: false },
    templateSource: {
      template: tpl.templateRel,
      vars: callerVars,
      title: renderedTitle || undefined,
    },
  } as unknown as DocumentMeta
  await saveMeta(stub)
  broadcastEdit(
    id,
    { owner: tpl.owner, storageKey: targetRel },
    rendered,
    'template-scheduler',
  )
  await flushDocSync(id)
  await loadMeta(id).catch(() => null)
  await audit({
    actor: tpl.owner,
    action: 'template.scheduled_fire',
    target: targetRel,
    meta: { template: tpl.templateRel, schedule: entry.cron, label: entry.label },
  })
  log.info(
    {
      owner: tpl.owner,
      template: tpl.templateRel,
      cron: entry.cron,
      target: targetRel,
    },
    'template scheduler fired',
  )
  return { targetRel }
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return // last tick still in flight, skip
  running = true
  try {
    const state = await loadState()
    const now = new Date()
    // First tick after a fresh install: anchor to "now" so we
    // don't try to backfill every schedule's missed history.
    const prev = state.lastTickAt ? new Date(state.lastTickAt) : now
    const { templates } = await discoverScheduledTemplates()
    for (const tpl of templates) {
      for (const entry of tpl.metadata.schedules) {
        const key = entryKey(tpl.owner, tpl.templateRel, entry.cron)
        const e = state.entries[key] ?? {
          lastFiredAt: null,
          lastSuccessAt: null,
          lastError: null,
          lastTarget: null,
          firstSeenAt: null,
        }
        // First sighting: anchor `firstSeenAt`. For entries
        // upgraded from older state versions (no `firstSeenAt`
        // field but a recorded `lastFiredAt`), use the prior fire
        // as the anchor so the next eligible cron firing isn't
        // deferred unnecessarily. Truly brand-new entries are
        // skipped this tick so a cron whose recent past matched
        // won't trigger an immediate backfill.
        if (e.firstSeenAt == null) {
          if (e.lastFiredAt != null) {
            e.firstSeenAt = e.lastFiredAt
            state.entries[key] = e
            // fall through — let this tick evaluate the window
          } else {
            e.firstSeenAt = now.getTime()
            state.entries[key] = e
            continue
          }
        }
        // Use the most recent of {prev tick, last fire, first
        // sighting} as the lower bound. firstSeenAt keeps a
        // schedule that was added between ticks from re-firing
        // every minute because its cron matched ten minutes ago;
        // lastFiredAt keeps a schedule that did fire from
        // re-firing on the next tick before the cron repeats.
        const since = Math.max(
          prev.getTime(),
          e.lastFiredAt ?? 0,
          e.firstSeenAt,
        )
        const tz = resolveCronTz(entry.tz, tpl.metadata.tz)
        if (!firedBetween(entry.cron, new Date(since), now, tz)) continue
        e.lastFiredAt = now.getTime()
        try {
          const { targetRel } = await fire(tpl, entry, log)
          e.lastSuccessAt = now.getTime()
          e.lastError = null
          e.lastTarget = targetRel
        } catch (err) {
          e.lastError = (err as Error).message
          log.warn(
            {
              err,
              owner: tpl.owner,
              template: tpl.templateRel,
              cron: entry.cron,
            },
            'template scheduler fire failed',
          )
        }
        state.entries[key] = e
      }
    }
    state.lastTickAt = now.getTime()
    await saveState(state)
  } catch (err) {
    log.warn({ err }, 'template scheduler tick errored')
  } finally {
    running = false
  }
}

export function startTemplateScheduler(log: FastifyBaseLogger): void {
  if (timer) return
  // Run once shortly after boot to absorb anything that should
  // have fired before the timer's first tick.
  setTimeout(() => void tick(log), 5_000).unref?.()
  timer = setInterval(() => void tick(log), TICK_MS)
  timer.unref?.()
  log.info('template scheduler started')
}

export function stopTemplateScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Test hook: drive a single tick synchronously. Lets the integration
 *  suite assert "templates with a matching cron fire" without
 *  waiting on real wall-clock time. */
export async function _tickNowForTest(log: FastifyBaseLogger): Promise<void> {
  await tick(log)
}

/** Enumerate scheduled-fire entries. One row per (template × cron):
 *  a template with 3 schedules surfaces as 3 rows, each with its own
 *  next-fire / last-fire. Pass `ownerFilter` to scope to a single
 *  user (account-page view); admins call without to see every user.
 *
 *  Also returns `errors[]` — templates whose frontmatter failed to
 *  parse. The scheduler silently skips them (it has no schedule
 *  entries to fire), but the UI needs to know so the user can fix
 *  the YAML. Without this, a typo silently disables a schedule
 *  with no feedback. */
export async function listScheduledTemplates(
  ownerFilter?: string,
): Promise<{ items: ScheduledTemplateView[]; errors: TemplateParseError[] }> {
  const state = await loadState()
  const { templates, errors: rawErrors } = await discoverScheduledTemplates()
  const errors = ownerFilter
    ? rawErrors.filter((e) => e.owner === ownerFilter)
    : rawErrors
  const out: ScheduledTemplateView[] = []
  for (const tpl of templates) {
    if (ownerFilter && tpl.owner !== ownerFilter) continue
    for (const entry of tpl.metadata.schedules) {
      const key = entryKey(tpl.owner, tpl.templateRel, entry.cron)
      const e = state.entries[key] ?? {
        lastFiredAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastTarget: null,
        firstSeenAt: null,
      }
      const tz = resolveCronTz(entry.tz, tpl.metadata.tz)
      const next = nextFireAfter(entry.cron, new Date(), tz)
      const pathTpl = entry.path ?? defaultSchedulePath(tpl.templateRel)
      const builtins = computeBuiltins({
        now: new Date(),
        title: tpl.templateRel,
        user: tpl.owner,
        targetRel: pathTpl,
      })
      const fullVars = {
        ...builtins,
        ...applyVarDefaults(tpl.metadata, entry.vars ?? {}),
      }
      let pathPreview = pathTpl
      try {
        pathPreview = applyTemplate(pathTpl, fullVars).replace(/^\/+|\/+$/g, '')
      } catch {/* keep raw path */}
      out.push({
        owner: tpl.owner,
        template: tpl.templateRel,
        cron: entry.cron,
        label: entry.label,
        nextFireAt: next?.getTime() ?? null,
        lastFiredAt: e.lastFiredAt,
        lastSuccessAt: e.lastSuccessAt,
        lastError: e.lastError,
        lastTarget: e.lastTarget,
        vars: entry.vars ?? {},
        pathPreview,
      })
    }
  }
  out.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner.localeCompare(b.owner)
    if (a.template !== b.template) return a.template.localeCompare(b.template)
    return a.cron.localeCompare(b.cron)
  })
  return { items: out, errors }
}

/** Enumerate per-day upcoming fires for `owner`'s scheduled
 *  templates between `from` and `to`. Returns a map keyed by
 *  `YYYY-MM-DD` (TZ-aware: the template's own tz or scheduler
 *  default) -> fire count across all schedules.
 *
 *  Powers the timeline calendar's "upcoming scheduled" overlay
 *  so a user can see at a glance which dates already have a
 *  template instantiation pencilled in.
 */
/** Stable palette for color-coding distinct schedules on the
 *  calendar. Picked from a perceptually-spaced set that holds up
 *  in both dark and light themes; assigned by hashing the schedule
 *  key (template + cron) so the same schedule keeps the same color
 *  across reloads. */
const SCHEDULE_PALETTE = [
  '#7C3AED', // violet
  '#06B6D4', // cyan
  '#F97316', // orange
  '#10B981', // green
  '#EC4899', // pink
  '#EAB308', // yellow
  '#22D3EE', // sky
  '#A855F7', // purple
  '#EF4444', // red
  '#84CC16', // lime
] as const

function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function colorForScheduleKey(key: string): string {
  return SCHEDULE_PALETTE[hashStr(key) % SCHEDULE_PALETTE.length]
}

export type UpcomingFiresResponse = {
  /** One entry per (template, cron) — gives the client the legend
   *  + the color it should paint each fire-day in. */
  schedules: Array<{
    key: string
    template: string
    cron: string
    label?: string
    color: string
  }>
  /** Day → list of schedule keys firing on that day. We don't
   *  track per-day fire COUNT anymore — for a daily calendar a
   *  cron like `* * * * *` firing 1440 times has the same display
   *  semantics as one firing once. */
  days: Record<string, string[]>
  /** Sum of (schedule × day) pairs across the window. Equivalent
   *  to "how many cells of the future calendar are colored". */
  total: number
}

export async function upcomingScheduledFires(
  owner: string,
  from: Date,
  to: Date,
): Promise<UpcomingFiresResponse> {
  const { templates } = await discoverScheduledTemplates()
  const schedules: UpcomingFiresResponse['schedules'] = []
  const days: UpcomingFiresResponse['days'] = {}
  let total = 0
  for (const tpl of templates) {
    if (tpl.owner !== owner) continue
    for (const entry of tpl.metadata.schedules) {
      const tz = resolveCronTz(entry.tz, tpl.metadata.tz)
      const firingYmds = firingDays(entry.cron, from, to, tz)
      if (firingYmds.length === 0) continue
      const scheduleKey = `${tpl.templateRel}|${entry.cron}`
      schedules.push({
        key: scheduleKey,
        template: tpl.templateRel,
        cron: entry.cron,
        label: entry.label,
        color: colorForScheduleKey(scheduleKey),
      })
      for (const ymd of firingYmds) {
        const bucket = (days[ymd] ??= [])
        if (!bucket.includes(scheduleKey)) bucket.push(scheduleKey)
        total++
      }
    }
  }
  return { schedules, days, total }
}

function formatYmd(d: Date, tz?: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    // en-CA renders as YYYY-MM-DD already; just normalize separators.
    return fmt.format(d)
  } catch {
    // Bad tz string — fall back to server local.
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
}

/** Admin action: manually trigger a single scheduled-fire entry.
 *  Used by the admin UI's "Run now" button so the user can verify
 *  the template + vars + path render before committing to the cron.
 *
 *  `cron` disambiguates entries when a template has multiple
 *  `schedules:` — pass the cron expression of the entry to fire.
 *  Omit it (or pass empty) to default to the first entry, which
 *  matches the legacy single-schedule behaviour. */
export async function runScheduledTemplateNow(
  owner: string,
  templateRel: string,
  log: FastifyBaseLogger,
  cron?: string,
): Promise<{ targetRel: string }> {
  const { templates } = await discoverScheduledTemplates()
  const tpl = templates.find(
    (t) => t.owner === owner && t.templateRel === templateRel,
  )
  if (!tpl) throw new Error('scheduled template not found')
  const entry = cron
    ? tpl.metadata.schedules.find((s) => s.cron === cron)
    : tpl.metadata.schedules[0]
  if (!entry) {
    throw new Error(
      `no schedule entry${cron ? ` with cron "${cron}"` : ''} on this template`,
    )
  }
  const result = await fire(tpl, entry, log)
  const state = await loadState()
  const key = entryKey(owner, templateRel, entry.cron)
  const e = state.entries[key] ?? {
    lastFiredAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastTarget: null,
    firstSeenAt: null,
  }
  const now = Date.now()
  // Run-now counts as the first sighting too, so a later
  // auto-fire doesn't get treated as a brand-new entry and
  // silently skipped on the next tick.
  if (e.firstSeenAt == null) e.firstSeenAt = now
  e.lastFiredAt = now
  e.lastSuccessAt = now
  e.lastError = null
  e.lastTarget = result.targetRel
  state.entries[key] = e
  await saveState(state)
  return result
}
