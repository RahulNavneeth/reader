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
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { moveAcrossDevices } from '../lib/fs.js'

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

  const finalFile = path.join(outDir, `reader-backup-${ts()}.tar.gz`)
  // Write to a tmp file OUTSIDE the dataDir / vaultRoot trees so tar
  // doesn't read its own in-flight output as part of the archive.
  // Without this, scheduled backups landed in `$DATA_DIR/backups/`
  // (i.e. inside the tree being tarred) and tar would race itself,
  // exiting with `file changed as we read it`.
  const tmpFile = path.join(os.tmpdir(), `reader-backup-${process.pid}-${Date.now()}.tar.gz`)
  const dataParent = path.dirname(dataDir)
  const vaultParent = path.dirname(vaultRoot)
  const args = [
    '-czf',
    tmpFile,
    '--exclude=reader.db-wal',
    '--exclude=reader.db-shm',
    '--exclude=reader.db-journal',
    ...(snapshot ? ['--exclude=reader.db'] : []),
    '-C', dataParent, path.basename(dataDir),
    '-C', vaultParent, path.basename(vaultRoot),
  ]
  log(`[backup] writing ${finalFile}`)
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
    // Promote tmp → final location only after a clean tar exit. Try
    // a same-fs rename first; fall back to copy+unlink if tmpdir is
    // on a different volume (common in Docker bind-mount setups).
    try {
      await rename(tmpFile, finalFile)
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        await moveAcrossDevices(tmpFile, finalFile)
      } else {
        throw e
      }
    }
  } finally {
    if (snapshot) await unlink(snapshot).catch(() => null)
    // If we threw before the rename, clean up the tmp file so it
    // doesn't accumulate under /tmp on repeated failures.
    await unlink(tmpFile).catch(() => null)
  }

  const s = await stat(finalFile)
  log(`[backup] done — ${(s.size / (1024 * 1024)).toFixed(1)} MB`)
  return { file: finalFile, bytes: s.size, snapshotted: !!snapshot }
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
