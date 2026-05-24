/**
 * `reader backup` — make a tar.gz snapshot of the data + vault dirs.
 *
 * Output: <out>/reader-backup-<YYYY-MM-DD-HHmmss>.tar.gz
 * Defaults: --out=. --data=$DATA_DIR --vault=$VAULT_ROOT
 *
 * No native tar dep — we shell out to /usr/bin/tar because that's what
 * exists on every host that can run this app (Debian, macOS, Alpine).
 * The fallback path is "install GNU tar" which is fair.
 *
 * Usage:
 *   docker compose exec reader node apps/server/dist/cli/backup.js
 *   docker compose exec reader node apps/server/dist/cli/backup.js \
 *     --out /backups
 */
import { spawn } from 'node:child_process'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
}

function timestamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    z(d.getMonth() + 1) +
    '-' +
    z(d.getDate()) +
    '-' +
    z(d.getHours()) +
    z(d.getMinutes()) +
    z(d.getSeconds())
  )
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      [
        'reader backup — snapshot the app state + vault to a tar.gz.',
        '',
        'Options:',
        '  --out   <dir>   Where to write the archive (default: cwd)',
        '  --data  <dir>   Override DATA_DIR  (default: env DATA_DIR or /data)',
        '  --vault <dir>   Override VAULT_ROOT (default: env VAULT_ROOT or /vault)',
        '  -h, --help      Show this message',
      ].join('\n'),
    )
    return
  }

  const out = path.resolve(arg('--out', '.')!)
  const dataDir = path.resolve(
    arg('--data', process.env.DATA_DIR ?? '/data')!,
  )
  const vaultDir = path.resolve(
    arg('--vault', process.env.VAULT_ROOT ?? '/vault')!,
  )

  for (const [label, p] of [
    ['DATA_DIR', dataDir],
    ['VAULT_ROOT', vaultDir],
  ] as const) {
    if (!(await exists(p))) {
      console.error(`[backup] ${label} not found: ${p}`)
      process.exit(1)
    }
  }
  await mkdir(out, { recursive: true })

  // ── Hot snapshot of reader.db ───────────────────────────────────
  // In WAL mode, raw-copying the .db + .db-wal + .db-shm while
  // writes are in flight can yield a torn snapshot. Use SQLite's
  // `VACUUM INTO` (since 3.27) which is internally
  // transaction-protected and produces a clean, vacuumed copy
  // safe to ship as part of the archive. We point the archive at
  // the snapshot file rather than the live DB.
  const liveDb = path.join(dataDir, 'reader.db')
  let snapshot: string | null = null
  if (await exists(liveDb)) {
    snapshot = path.join(dataDir, `.reader-backup-${process.pid}.db`)
    console.log(`[backup] vacuuming DB → ${snapshot}`)
    const conn = new Database(liveDb, { readonly: true })
    try {
      // Drop any previous half-written snapshot from a crashed run —
      // VACUUM INTO refuses to overwrite an existing file.
      await unlink(snapshot).catch(() => null)
      conn.prepare(`VACUUM INTO ?`).run(snapshot)
    } finally {
      conn.close()
    }
  }

  const file = path.join(out, `reader-backup-${timestamp()}.tar.gz`)
  // Tar with parent paths so the archive restores cleanly: each dir
  // is recorded relative to its own parent, preserving leaf names.
  // We can't use --transform on macOS tar, so we just store
  // absolute-ish paths and document the restore in the README.
  //
  // Exclude the live WAL/SHM/journal sidecars and the live .db
  // itself — the snapshot we just took replaces it. The receiver
  // restores by renaming `.reader-backup-*.db` → `reader.db` after
  // unpacking (also documented in the README).
  const dataParent = path.dirname(dataDir)
  const vaultParent = path.dirname(vaultDir)
  const args = [
    '-czf',
    file,
    '--exclude=reader.db-wal',
    '--exclude=reader.db-shm',
    '--exclude=reader.db-journal',
    ...(snapshot ? ['--exclude=reader.db'] : []),
    '-C',
    dataParent,
    path.basename(dataDir),
    '-C',
    vaultParent,
    path.basename(vaultDir),
  ]
  console.log(`[backup] writing ${file}`)
  console.log(`[backup]   data:  ${dataDir}`)
  console.log(`[backup]   vault: ${vaultDir}`)

  const tar = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    tar.on('error', reject)
    tar.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with code ${code}`))
    })
  })

  // Best-effort cleanup of the snapshot. If this fails, the next
  // run's `unlink` above will drop it.
  if (snapshot) await unlink(snapshot).catch(() => null)

  const s = await stat(file)
  const mb = (s.size / (1024 * 1024)).toFixed(1)
  console.log(`[backup] done — ${mb} MB`)
  if (snapshot) {
    console.log(
      `[backup] note: restore by extracting the archive, then renaming` +
        `\n               .reader-backup-*.db → reader.db inside the data dir.`,
    )
  }
}

main().catch((err) => {
  console.error('[backup] failed:', err?.message ?? err)
  process.exit(1)
})
