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

/** Compute the cron's next fire after `from`. Returns null when the
 *  expression is malformed — the scheduler treats null as "skip this
 *  template" and records the error in state. */
export function nextFireAfter(expr: string, from: Date): Date | null {
  try {
    const it = parser.parseExpression(expr, { currentDate: from })
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
): boolean {
  const next = nextFireAfter(expr, prev)
  if (!next) return false
  return next.getTime() > prev.getTime() && next.getTime() <= now.getTime()
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
    const dir = path.join(userVaultRoot(u.username), '_templates')
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // No _templates dir for this user — fine, they haven't
      // saved any yet.
      continue
    }
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!/\.(md|markdown|mdx)$/i.test(e.name)) continue
      const templateAbs = path.join(dir, e.name)
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
            template: `_templates/${e.name}`,
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
        templateRel: `_templates/${e.name}`,
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
        }
        // Use the more recent of `prev` and `lastFiredAt` as the
        // lower bound. Protects against a template added mid-window
        // re-firing on every tick because its cron is in the past.
        const since = Math.max(
          prev.getTime(),
          e.lastFiredAt ?? 0,
          // Brand-new entries: anchor at "now" so they wait for
          // the first real cron fire instead of triggering instantly
          // when an old cron expression matches the recent past.
          e.lastFiredAt == null ? now.getTime() : 0,
        )
        if (!firedBetween(entry.cron, new Date(since), now)) continue
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
      }
      const next = nextFireAfter(entry.cron, new Date())
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
  }
  const now = Date.now()
  e.lastFiredAt = now
  e.lastSuccessAt = now
  e.lastError = null
  e.lastTarget = result.targetRel
  state.entries[key] = e
  await saveState(state)
  return result
}
