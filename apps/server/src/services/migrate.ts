/**
 * One-time boot migration to the per-user vault layout.
 *
 * Before: every user shared one root at `config.vault.root`. Files lived at
 * `<root>/investments/foo.md` etc.
 *
 * After: each user owns a subdir `<root>/<username>/...`. The legacy loose
 * entries get moved under the admin user's namespace so the data survives.
 *
 * The migration is idempotent: a marker file inside the admin's dir tells us
 * we've already done it. We never overwrite an existing user dir.
 */
import path from 'node:path'
import { readdir, rename, stat, writeFile } from 'node:fs/promises'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.js'
import { listUsers } from '../stores/users.js'
import { ensureUserVault, MIGRATION_MARKER, userVaultRoot } from '../lib/userVault.js'

// Anything beginning with a dot, plus directories Reader itself manages.
function shouldSkip(name: string): boolean {
  if (name.startsWith('.')) return true
  return false
}

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export async function migrateLegacyVault(log: FastifyBaseLogger): Promise<void> {
  const users = await listUsers().catch(() => [])
  const admin = users.find((u) => u.role === 'admin')
  if (!admin) {
    // No admin yet — first-boot signup will fall under the new layout
    // naturally; nothing to migrate.
    return
  }

  // Existing user usernames — we treat these top-level dirs as already owned.
  const userDirs = new Set(users.map((u) => u.username))

  await ensureUserVault(admin.username)
  const adminRoot = userVaultRoot(admin.username)
  const markerPath = path.join(adminRoot, MIGRATION_MARKER)

  // If the marker exists we've already migrated; bail out so subsequent boots
  // don't try to re-shuffle.
  if (await stat(markerPath).catch(() => null)) return

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(config.vault.root, { withFileTypes: true })
  } catch {
    return
  }

  let moved = 0
  for (const e of entries) {
    if (shouldSkip(e.name)) continue
    // Already a username-shaped dir matching a real user → leave it alone.
    if (e.isDirectory() && userDirs.has(e.name)) continue
    // Looks like an unrelated username-shaped dir (e.g., manual `mkdir`) that
    // doesn't map to a user — fold it in too for safety.
    const src = path.join(config.vault.root, e.name)
    const dst = path.join(adminRoot, e.name)
    const dstExists = await stat(dst).catch(() => null)
    if (dstExists) {
      log.warn(
        { src, dst },
        'migrate: destination already exists, skipping to avoid clobbering',
      )
      continue
    }
    try {
      await rename(src, dst)
      moved++
      log.info({ src, dst }, 'migrate: moved legacy entry into admin namespace')
    } catch (err) {
      log.warn({ err, src }, 'migrate: failed to move legacy entry')
    }
  }

  await writeFile(
    markerPath,
    JSON.stringify(
      { migratedAt: Date.now(), admin: admin.username, movedEntries: moved },
      null,
      2,
    ),
    'utf8',
  )
  if (moved > 0) {
    log.info({ admin: admin.username, moved }, 'migrate: legacy vault folded into admin workspace')
  }

  // Belt + braces: every existing user gets a vault dir, even ones that
  // haven't done anything yet (so refs to /api/list don't 404 on fresh users).
  for (const u of users) {
    if (!USERNAME_RE.test(u.username)) continue
    await ensureUserVault(u.username).catch((err) => log.warn({ err, user: u.username }, 'ensureUserVault'))
  }
}
