/**
 * One-shot import of existing meta.json files into the SQLite
 * `documents` table.
 *
 * Runs after `runMigrations()` on every boot. If the table is empty
 * but `data/documents/<id>/meta.json` files exist on disk, we walk
 * the directory and upsert each into SQL. Idempotent and safe to
 * re-run: subsequent boots see a populated table and short-circuit.
 *
 * Why a one-shot rather than dual-write-from-day-one: the existing
 * deployment shipped without this DB, so a fresh container against
 * an existing `data/` volume needs to backfill on first boot. After
 * that the regular saveMeta path keeps SQL in sync.
 *
 * We don't delete the source meta.json files. They keep being
 * written by saveMeta as a per-doc backup the user can `cat` for
 * debugging — small enough not to matter for storage and useful when
 * something goes sideways with the DB.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { readJson } from '../lib/fs.js'
import type { Chunk, DocumentMeta } from '../types.js'
import { count, upsert } from './documentsRepo.js'
import * as chunksRepo from './chunksRepo.js'

export async function bootstrapDocumentsFromDisk(opts?: { silent?: boolean }): Promise<{
  imported: number
  skipped: number
}> {
  if (count() > 0) {
    return { imported: 0, skipped: 0 }
  }
  let ids: string[]
  try {
    ids = await readdir(config.paths.documents)
  } catch {
    return { imported: 0, skipped: 0 }
  }
  let imported = 0
  let skipped = 0
  for (const id of ids) {
    if (id.startsWith('.')) {
      skipped++
      continue
    }
    const meta = await readJson<DocumentMeta>(
      path.join(config.paths.documents, id, 'meta.json'),
    )
    if (!meta) {
      skipped++
      continue
    }
    try {
      upsert(meta)
      imported++
    } catch (e) {
      if (!opts?.silent) {
        console.warn(`[db] failed to import meta ${id}:`, (e as Error).message)
      }
      skipped++
    }
  }
  if (!opts?.silent && imported > 0) {
    console.log(`[db] imported ${imported} document(s) from disk into SQLite (${skipped} skipped)`)
  }
  return { imported, skipped }
}

/**
 * Mirror of bootstrapDocumentsFromDisk for the chunks table. Reads
 * each doc's chunks.jsonl (newline-delimited Chunk records, the
 * format chunks.ts always wrote) and replays into SQL. Idempotent:
 * if `chunks` already has rows the function short-circuits and
 * does nothing.
 */
export async function bootstrapChunksFromDisk(opts?: {
  silent?: boolean
}): Promise<{ imported: number; skipped: number }> {
  if (chunksRepo.count() > 0) {
    return { imported: 0, skipped: 0 }
  }
  let ids: string[]
  try {
    ids = await readdir(config.paths.documents)
  } catch {
    return { imported: 0, skipped: 0 }
  }
  let imported = 0
  let skipped = 0
  for (const id of ids) {
    if (id.startsWith('.')) {
      skipped++
      continue
    }
    const file = path.join(config.paths.documents, id, 'chunks.jsonl')
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      // chunks.jsonl missing — no embeddings to import (no-text doc
      // or pre-ingest), counted as skip not error.
      skipped++
      continue
    }
    const chunks: Chunk[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        chunks.push(JSON.parse(t) as Chunk)
      } catch {
        /* malformed line — drop */
      }
    }
    if (chunks.length === 0) {
      skipped++
      continue
    }
    try {
      chunksRepo.replaceChunks(id, chunks)
      imported++
    } catch (e) {
      if (!opts?.silent) {
        console.warn(`[db] failed to import chunks ${id}:`, (e as Error).message)
      }
      skipped++
    }
  }
  if (!opts?.silent && imported > 0) {
    console.log(`[db] imported chunks for ${imported} document(s) into SQLite (${skipped} skipped)`)
  }
  return { imported, skipped }
}
