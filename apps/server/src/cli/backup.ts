/**
 * `reader backup` — make a tar.gz snapshot of the data + vault dirs.
 *
 * Output: <out>/reader-backup-<YYYY-MM-DD-HHmmss>.tar.gz
 * Defaults: --out=. --data=$DATA_DIR --vault=$VAULT_ROOT
 *
 * The heavy lifting lives in services/backup.ts so the scheduled-
 * backup service can reuse the exact same primitive.
 *
 * Usage:
 *   docker compose exec reader node apps/server/dist/cli/backup.js
 *   docker compose exec reader node apps/server/dist/cli/backup.js \
 *     --out /backups
 */
import process from 'node:process'
import { createBackup } from '../services/backup.js'

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
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

  const result = await createBackup({
    outDir: arg('--out', '.')!,
    dataDir: arg('--data', process.env.DATA_DIR ?? '/data')!,
    vaultRoot: arg('--vault', process.env.VAULT_ROOT ?? '/vault')!,
    onProgress: (line) => console.log(line),
  })
  if (result.snapshotted) {
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
