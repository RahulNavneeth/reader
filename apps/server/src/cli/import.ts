/**
 * `reader import` — bulk-import a host-side directory into a user's
 * vault. Skips the HTTP upload path entirely — writes files straight
 * into the vault layout and lets the chokidar watcher pick them up
 * for ingest.
 *
 * Useful for the "I have 10,000 files on a NAS, get them in" first-
 * run. Drag-and-drop in the UI works but caps at 100MB/file and
 * burns CPU on the React side.
 *
 * Usage:
 *   docker compose exec reader \
 *     node apps/server/dist/cli/import.js \
 *       --user alice \
 *       --from /import/photos \
 *       [--into photos]            # vault subfolder, default ""
 *       [--copy | --move]          # default copy
 *       [--dry-run]
 */
import { cp, mkdir, readdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { config } from '../config.js'

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  async function go(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) await go(full)
      else if (e.isFile()) out.push(full)
    }
  }
  await go(root)
  return out
}

async function main(): Promise<void> {
  if (flag('--help') || flag('-h')) {
    console.log(
      [
        'reader import — bulk-copy host-side files into a user vault.',
        '',
        'Required:',
        '  --user  <name>   Target user. Must exist (signup first).',
        '  --from  <path>   Source directory on the host / inside the container.',
        '',
        'Optional:',
        '  --into  <path>   Vault subfolder (default = vault root).',
        '  --copy           Copy files (default).',
        '  --move           Move files (deletes from source).',
        '  --dry-run        Show what would happen, write nothing.',
        '  -h, --help       This message.',
      ].join('\n'),
    )
    return
  }

  const user = arg('--user')
  const from = arg('--from')
  const into = (arg('--into', '') ?? '').replace(/^\/+|\/+$/g, '')
  const move = flag('--move')
  const dry = flag('--dry-run')

  if (!user || !USERNAME_RE.test(user)) {
    console.error('[import] --user is required and must be a valid username')
    process.exit(2)
  }
  if (!from) {
    console.error('[import] --from is required')
    process.exit(2)
  }
  const srcRoot = path.resolve(from)
  const st = await stat(srcRoot).catch(() => null)
  if (!st || !st.isDirectory()) {
    console.error(`[import] ${srcRoot} is not a directory`)
    process.exit(2)
  }
  if (into.includes('..')) {
    console.error('[import] --into may not contain ..')
    process.exit(2)
  }

  const destRoot = path.resolve(config.vault.root, user, into)
  console.log(`[import] source: ${srcRoot}`)
  console.log(`[import] dest:   ${destRoot}`)
  console.log(`[import] mode:   ${move ? 'move' : 'copy'}${dry ? ' (dry-run)' : ''}`)

  const files = await walk(srcRoot)
  console.log(`[import] found ${files.length} files`)
  if (files.length === 0) return

  if (!dry) await mkdir(destRoot, { recursive: true })

  let done = 0
  let skipped = 0
  let bytes = 0
  for (const src of files) {
    const rel = path.relative(srcRoot, src)
    const dest = path.join(destRoot, rel)
    if (dry) {
      console.log(`  ${rel}`)
      done++
      continue
    }
    try {
      await mkdir(path.dirname(dest), { recursive: true })
      // Skip if a same-sized file already exists at dest — naive but
      // catches re-runs. Full sha compare would be safer; not worth
      // the I/O for a manual import.
      const exists = await stat(dest).catch(() => null)
      if (exists?.isFile() && exists.size === (await stat(src)).size) {
        skipped++
        continue
      }
      if (move) {
        await rename(src, dest).catch(async (e: NodeJS.ErrnoException) => {
          // EXDEV — different mounts; fall back to copy + unlink.
          if (e.code === 'EXDEV') {
            await cp(src, dest)
            await (await import('node:fs/promises')).rm(src)
          } else {
            throw e
          }
        })
      } else {
        await cp(src, dest)
      }
      done++
      bytes += (await stat(dest)).size
      if (done % 50 === 0) console.log(`[import] ${done} / ${files.length}`)
    } catch (err: any) {
      console.error(`[import] FAIL ${rel}: ${err?.message ?? err}`)
    }
  }
  const mb = (bytes / (1024 * 1024)).toFixed(1)
  console.log(`[import] done — ${done} copied, ${skipped} skipped (exists), ${mb} MB`)
  console.log('[import] vault watcher will ingest the new files in the background.')
}

main().catch((err) => {
  console.error('[import] crashed:', err?.message ?? err)
  process.exit(1)
})
