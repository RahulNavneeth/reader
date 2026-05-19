/**
 * Singleton SQLite connection for the document index.
 *
 * - WAL journal mode so readers don't block writers (and so the
 *   ingest pipeline can keep inserting chunks while the API is
 *   serving search results).
 * - foreign_keys=ON so the ON DELETE CASCADE on the tags + ACL
 *   tables actually fires (SQLite ships with FKs off by default).
 * - busy_timeout so concurrent saveMeta calls retry briefly instead
 *   of throwing SQLITE_BUSY. The existing per-doc save-lock in
 *   stores/documents.ts already serializes same-doc writes, so this
 *   is just belt-and-braces for cross-doc contention.
 *
 * The DB file lives under `config.dataDir/reader.db` (alongside the
 * other persistent state). Volume bind-mounts that already capture
 * `data/` will pick it up automatically — no compose change needed.
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { config } from '../config.js'

let cached: Database.Database | null = null

export function db(): Database.Database {
  if (cached) return cached
  mkdirSync(config.dataDir, { recursive: true })
  const file = path.join(config.dataDir, 'reader.db')
  const conn = new Database(file)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('busy_timeout = 5000')
  // Keep the page cache modest (~16 MB) — the OS page cache does
  // the heavy lifting and we don't want this to balloon RSS.
  conn.pragma('cache_size = -16000')
  cached = conn
  return conn
}

/** Test hook — closes + re-creates the connection. Used by the
 *  integration tests that need a fresh DB per file. */
export function _resetDbForTest(): void {
  if (cached) {
    try { cached.close() } catch { /* ignore */ }
  }
  cached = null
}
