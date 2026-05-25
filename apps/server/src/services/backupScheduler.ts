/**
 * Scheduled backup service. Reads `settings.backup` and fires
 * `createBackup` on a daily-or-weekly cadence at a configured local
 * time. Designed for the 1-3-person homelab use case the README
 * advertises — coarse scheduling, on-process, no node-cron dep.
 *
 * State model:
 *   - Settings live in `data/settings.json` under `backup.*` —
 *     toggled at runtime by the admin without restarting.
 *   - Per-run state (last fire timestamp, last error) lives in
 *     `data/backup-state.json`. Survives restarts so a process
 *     bounce between scheduled fires doesn't trigger a duplicate
 *     run a few seconds after boot.
 *
 * Why DIY instead of node-cron:
 *   - The cadence is coarse (daily / weekly). A setTimeout-driven
 *     next-fire calculation is correct and obvious.
 *   - One dep avoided. node-cron pulls a tz parser + cron grammar
 *     for capability we don't use.
 *   - Easier to test: the next-fire-time function is pure.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import { loadSettings } from '../stores/settings.js'
import { audit } from '../stores/audit.js'
import { createBackup, pruneOldBackups } from './backup.js'

export interface BackupSettings {
  enabled?: boolean
  /** Cadence. `daily` fires at `time` every day; `weekly` fires at
   *  `time` on `weekday`. Default daily. */
  schedule?: 'daily' | 'weekly'
  /** Local-clock fire time, "HH:MM" (24h). Defaults to 03:00 — quiet
   *  hours for most personal deployments. */
  time?: string
  /** Day-of-week 0..6 (Sunday..Saturday) for the weekly schedule. */
  weekday?: number
  /** Where archives land. Default `${DATA_DIR}/backups`. */
  outDir?: string
  /** Auto-prune archives older than this. 0 (default) = keep forever. */
  retainDays?: number
}

export interface BackupState {
  lastRunAt: number | null
  lastSuccessAt: number | null
  lastFile: string | null
  lastBytes: number | null
  lastError: string | null
  /** Pre-computed next-fire timestamp so the admin UI can show
   *  "next backup: in 4h 23m" without re-doing the math. Refreshed
   *  every time we re-schedule. */
  nextFireAt: number | null
}

const STATE_FILE = path.join(config.dataDir, 'backup-state.json')

let timer: NodeJS.Timeout | null = null
let running = false
let currentLog: FastifyBaseLogger | null = null

function resolveOutDir(s: BackupSettings | undefined): string {
  return s?.outDir
    ? path.resolve(s.outDir)
    : path.join(config.dataDir, 'backups')
}

/**
 * Next fire after `from`, given the settings. Pure — no I/O — so the
 * test suite can pin time and assert the computed timestamp.
 *
 * Returns null when the schedule is disabled or invalid (the caller
 * treats null as "don't schedule").
 */
export function nextFireAfter(
  from: Date,
  s: BackupSettings | undefined,
): Date | null {
  if (!s?.enabled) return null
  const time = (s.time ?? '03:00').match(/^(\d{1,2}):(\d{2})$/)
  if (!time) return null
  const hh = Number(time[1])
  const mm = Number(time[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null

  const target = new Date(from)
  target.setSeconds(0, 0)
  target.setHours(hh, mm)
  // If today's fire time has already passed, jump to tomorrow.
  if (target.getTime() <= from.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  if (s.schedule === 'weekly') {
    const weekday = Math.max(0, Math.min(6, s.weekday ?? 0))
    // Advance the target day to the matching weekday. The Sunday=0
    // convention matches JavaScript's `Date.getDay()`.
    while (target.getDay() !== weekday) {
      target.setDate(target.getDate() + 1)
    }
  }
  return target
}

async function loadState(): Promise<BackupState> {
  const empty: BackupState = {
    lastRunAt: null,
    lastSuccessAt: null,
    lastFile: null,
    lastBytes: null,
    lastError: null,
    nextFireAt: null,
  }
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    return { ...empty, ...(JSON.parse(raw) as Partial<BackupState>) }
  } catch {
    return empty
  }
}

async function saveState(s: BackupState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true }).catch(() => null)
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
}

/** Public read of the most recent backup-state for the admin UI.
 *  Always computes `nextFireAt` fresh from the current settings —
 *  the on-disk field is only used as the canonical write target by
 *  the scheduler; the read path stays accurate even when the
 *  background scheduler is skipped (e.g. test fixtures call
 *  `buildApp({skipBackground:true})`). */
export async function readBackupState(): Promise<BackupState> {
  const state = await loadState()
  const s = (await loadSettings()).backup as BackupSettings | undefined
  const next = nextFireAfter(new Date(), s)
  return { ...state, nextFireAt: next ? next.getTime() : null }
}

/**
 * Run a backup *now*. Used by both the scheduled timer and the
 * "Backup now" admin button. Serialises against concurrent runs so a
 * frantic operator clicking twice doesn't double-tar the vault.
 */
export async function runBackupNow(
  reason: 'scheduled' | 'manual',
  actor: string,
  log?: FastifyBaseLogger,
): Promise<BackupState> {
  if (running) {
    throw new Error('backup already in progress')
  }
  running = true
  const settings = await loadSettings()
  const b = settings.backup as BackupSettings | undefined
  const outDir = resolveOutDir(b)
  const dataDir = config.dataDir
  const vaultRoot = config.vault.root
  const startedAt = Date.now()
  const state = await loadState()
  state.lastRunAt = startedAt
  const writeLine = (line: string) =>
    log?.info({ scope: 'backup' }, line) ?? undefined
  try {
    const result = await createBackup({
      dataDir,
      vaultRoot,
      outDir,
      onProgress: writeLine,
    })
    state.lastSuccessAt = Date.now()
    state.lastFile = result.file
    state.lastBytes = result.bytes
    state.lastError = null
    await audit({
      actor,
      action: 'backup.run',
      meta: {
        reason,
        bytes: result.bytes,
        file: path.basename(result.file),
        snapshotted: result.snapshotted,
      },
    })
    if (b?.retainDays && b.retainDays > 0) {
      const swept = await pruneOldBackups(outDir, b.retainDays, writeLine)
      if (swept.removed > 0) {
        await audit({
          actor,
          action: 'backup.prune',
          meta: { removed: swept.removed, freed: swept.freed },
        })
      }
    }
  } catch (e) {
    state.lastError = (e as Error).message
    await audit({
      actor,
      action: 'backup.failed',
      meta: { reason, error: state.lastError },
    })
    throw e
  } finally {
    running = false
    // Re-compute next fire so the UI updates without the next tick.
    const next = nextFireAfter(new Date(), b)
    state.nextFireAt = next ? next.getTime() : null
    await saveState(state)
  }
  return state
}

async function schedule(
  log: FastifyBaseLogger,
  settings: BackupSettings | undefined,
): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const next = nextFireAfter(new Date(), settings)
  // Persist the computed next-fire timestamp into state so the admin
  // UI's `nextFireAt` field reflects the live schedule immediately
  // after a settings PATCH — without waiting for the first scheduled
  // run to write it through.
  const prior = await loadState()
  await saveState({ ...prior, nextFireAt: next ? next.getTime() : null })
  if (!next) {
    log.info({ scope: 'backup' }, 'backup scheduler idle (disabled or misconfigured)')
    return
  }
  const ms = next.getTime() - Date.now()
  log.info(
    { scope: 'backup', nextFireAt: next.toISOString() },
    `next backup in ${(ms / 1000 / 60).toFixed(1)} min`,
  )
  // setTimeout clamps to ~24.85 days on a signed 32-bit int — well
  // above any cadence we'd actually use, but defensive against future
  // settings changes.
  const safeMs = Math.min(ms, 2 ** 31 - 1)
  timer = setTimeout(() => {
    runBackupNow('scheduled', 'system', log)
      .catch((err) =>
        log.warn({ err, scope: 'backup' }, 'scheduled backup failed'),
      )
      .finally(() => {
        // Reschedule the next one — whether this run succeeded or
        // failed, we still want a daily cadence.
        loadSettings()
          .then((s) => schedule(log, s.backup as BackupSettings | undefined))
          .catch(() => null)
      })
  }, safeMs)
}

/**
 * Start the scheduler. Idempotent — calling again replaces the
 * current timer (settings change → admin saved → restart the timer
 * with the new cadence).
 */
export async function startBackupScheduler(log: FastifyBaseLogger): Promise<void> {
  currentLog = log
  const settings = await loadSettings()
  await schedule(log, settings.backup as BackupSettings | undefined)
}

/** Stop the scheduler — used in tests + on graceful shutdown. */
export function stopBackupScheduler(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/**
 * Hook for the admin PATCH handler — call after settings save so the
 * next-fire time picks up the new cadence without a process restart.
 */
export async function reapplyBackupSchedule(): Promise<void> {
  if (!currentLog) return
  const settings = await loadSettings()
  await schedule(currentLog, settings.backup as BackupSettings | undefined)
}
