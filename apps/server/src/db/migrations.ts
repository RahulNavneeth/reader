/**
 * SQL migrations runner.
 *
 * Migrations live next to this file as `migrations/NNN_name.sql`.
 * On boot we read the directory, see which versions are already in
 * the `schema_migrations` table, and apply the missing ones in
 * numerical order inside a transaction each.
 *
 * Single-tenant single-process assumption: no locking around
 * "another instance is migrating right now" — the server is meant
 * to run as one container. Adding multi-instance support would
 * mean swapping for an advisory-lock pattern (e.g. via a separate
 * `migration_lock` table) before we put a second Reader behind a
 * shared SQLite file.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { db } from './sqlite.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function ensureSchemaTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
}

function appliedVersions(d: Database.Database): Set<number> {
  const rows = d
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: number }>
  return new Set(rows.map((r) => r.version))
}

function listMigrations(): Array<{ version: number; name: string; sql: string }> {
  const dir = path.join(HERE, 'migrations')
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.sql'))
  } catch {
    return []
  }
  return names
    .map((name) => {
      const m = /^(\d+)_/.exec(name)
      if (!m) return null
      const version = Number(m[1])
      const sql = readFileSync(path.join(dir, name), 'utf8')
      return { version, name, sql }
    })
    .filter((m): m is { version: number; name: string; sql: string } => m != null)
    .sort((a, b) => a.version - b.version)
}

export function runMigrations(): { applied: number[]; skipped: number[] } {
  const d = db()
  ensureSchemaTable(d)
  const have = appliedVersions(d)
  const applied: number[] = []
  const skipped: number[] = []
  for (const m of listMigrations()) {
    if (have.has(m.version)) {
      skipped.push(m.version)
      continue
    }
    // One transaction per migration: either the whole .sql file
    // commits or none of it does.
    const tx = d.transaction(() => {
      d.exec(m.sql)
      d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      )
    })
    tx()
    applied.push(m.version)
  }
  return { applied, skipped }
}
