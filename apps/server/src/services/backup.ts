/**
 * Backup primitive — shared by the `reader backup` CLI and the
 * scheduled-backup service. Produces a single tar.gz of the data dir
 * + vault dir with a hot SQLite snapshot inside, suitable for restore
 * via plain rsync of the unpacked contents (see README → Leaving
 * Reader / Upgrade).
 *
 * Design choices:
 *   - Shell out to /usr/bin/tar — every host that runs the app has it,
 *     and we avoid pulling a native deflate dep just for backups.
 *   - VACUUM INTO for the live DB — WAL mode + concurrent writers can
 *     yield a torn snapshot on a raw cp/tar. SQLite's own copy is
 *     transaction-protected and vacuumed in one pass.
 *   - The snapshot file gets a per-PID suffix so two simultaneous
 *     backups (manual + scheduled racing) don't clobber each other's
 *     intermediate state — though we serialise scheduled runs anyway.
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'

export interface BackupOptions {
  /** Reader's app-state directory (sqlite, audit, sessions, …). */
  dataDir: string
  /** User-files root. */
  vaultRoot: string
  /** Where to drop the tar.gz. Created if missing. */
  outDir: string
  /** Optional callback for human-readable progress lines. The CLI
   *  pipes these to stdout; the scheduler routes them through the
   *  fastify logger. */
  onProgress?: (line: string) => void
}

export interface BackupResult {
  /** Absolute path to the produced archive. */
  file: string
  /** Compressed size in bytes — useful for "took 1.2 GB" telemetry. */
  bytes: number
  /** Whether a vacuumed DB snapshot was included (false when no
   *  reader.db on disk yet — fresh install / data dir was wiped). */
  snapshotted: boolean
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

function ts(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' + z(d.getMonth() + 1) +
    '-' + z(d.getDate()) +
    '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds())
  )
}

export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.onProgress ?? (() => undefined)
  const dataDir = path.resolve(opts.dataDir)
  const vaultRoot = path.resolve(opts.vaultRoot)
  const outDir = path.resolve(opts.outDir)

  for (const [label, p] of [
    ['DATA_DIR', dataDir],
    ['VAULT_ROOT', vaultRoot],
  ] as const) {
    if (!(await exists(p))) {
      throw new Error(`${label} not found: ${p}`)
    }
  }
  await mkdir(outDir, { recursive: true })

  // Hot snapshot of reader.db via VACUUM INTO (see file-header note).
  const liveDb = path.join(dataDir, 'reader.db')
  let snapshot: string | null = null
  if (await exists(liveDb)) {
    snapshot = path.join(dataDir, `.reader-backup-${process.pid}.db`)
    log(`[backup] vacuuming DB → ${snapshot}`)
    const conn = new Database(liveDb, { readonly: true })
    try {
      await unlink(snapshot).catch(() => null)
      conn.prepare(`VACUUM INTO ?`).run(snapshot)
    } finally {
      conn.close()
    }
  }

  const file = path.join(outDir, `reader-backup-${ts()}.tar.gz`)
  const dataParent = path.dirname(dataDir)
  const vaultParent = path.dirname(vaultRoot)
  const args = [
    '-czf',
    file,
    '--exclude=reader.db-wal',
    '--exclude=reader.db-shm',
    '--exclude=reader.db-journal',
    ...(snapshot ? ['--exclude=reader.db'] : []),
    '-C', dataParent, path.basename(dataDir),
    '-C', vaultParent, path.basename(vaultRoot),
  ]
  log(`[backup] writing ${file}`)
  log(`[backup]   data:  ${dataDir}`)
  log(`[backup]   vault: ${vaultRoot}`)

  try {
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      tar.stderr?.on('data', (c) => { stderr += c.toString() })
      tar.on('error', reject)
      tar.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
      })
    })
  } finally {
    if (snapshot) await unlink(snapshot).catch(() => null)
  }

  const s = await stat(file)
  log(`[backup] done — ${(s.size / (1024 * 1024)).toFixed(1)} MB`)
  return { file, bytes: s.size, snapshotted: !!snapshot }
}

/**
 * Sweep stale archives from `outDir`. Files matching
 * `reader-backup-*.tar.gz` older than `retainDays` get unlinked. Other
 * files in the directory are left alone — the scheduler shares its
 * out-dir with whatever else the operator stores there.
 *
 * `retainDays <= 0` means "keep forever" and skips the sweep.
 */
export async function pruneOldBackups(
  outDir: string,
  retainDays: number,
  onProgress?: (line: string) => void,
): Promise<{ removed: number; freed: number }> {
  if (retainDays <= 0) return { removed: 0, freed: 0 }
  const log = onProgress ?? (() => undefined)
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = await readdir(outDir)
  } catch {
    return { removed: 0, freed: 0 }
  }
  let removed = 0
  let freed = 0
  for (const name of entries) {
    if (!/^reader-backup-.*\.tar\.gz$/.test(name)) continue
    const full = path.join(outDir, name)
    const s = await stat(full).catch(() => null)
    if (!s || !s.isFile()) continue
    if (s.mtimeMs > cutoff) continue
    try {
      await unlink(full)
      removed += 1
      freed += s.size
      log(`[backup] pruned ${name} (${(s.size / (1024 * 1024)).toFixed(1)} MB)`)
    } catch (e) {
      log(`[backup] prune failed for ${name}: ${(e as Error).message}`)
    }
  }
  return { removed, freed }
}
