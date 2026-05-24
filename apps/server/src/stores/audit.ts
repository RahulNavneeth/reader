import path from 'node:path'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { config } from '../config.js'
import { appendLine } from '../lib/fs.js'
import type { AuditEvent } from '../types.js'

function dailyFile(d = new Date()): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return path.join(config.paths.audit, `${y}-${m}-${day}.jsonl`)
}

export async function audit(ev: Omit<AuditEvent, 'ts'>): Promise<void> {
  const event: AuditEvent = { ts: Date.now(), ...ev }
  await appendLine(dailyFile(), JSON.stringify(event))
}

/**
 * Drop daily audit shards older than `retentionDays`. The store
 * partitions by UTC day so retention is just "delete files whose
 * date prefix is too old" — no need to parse or rewrite anything.
 * Returns the number of shards deleted (for logging).
 *
 * 180 days is the default in index.ts — long enough for any
 * realistic forensic look-back, bounded so the file count stays
 * predictable on long-running deployments.
 */
export async function pruneAuditOlderThan(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  // Compare lexically against ISO-style YYYY-MM-DD prefixes. That
  // sort order matches chronological order for this format.
  const y = cutoff.getUTCFullYear()
  const m = String(cutoff.getUTCMonth() + 1).padStart(2, '0')
  const d = String(cutoff.getUTCDate()).padStart(2, '0')
  const cutoffKey = `${y}-${m}-${d}`
  let files: string[]
  try {
    files = await readdir(config.paths.audit)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 0
    throw e
  }
  let n = 0
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue
    // Filename is `<YYYY-MM-DD>.jsonl`. Anything strictly less than
    // the cutoff key is older than the retention window.
    const key = name.slice(0, 10)
    if (key < cutoffKey) {
      try {
        await unlink(path.join(config.paths.audit, name))
        n += 1
      } catch {
        /* swallow — next sweep will retry */
      }
    }
  }
  return n
}

/**
 * Read audit events, newest first. Walks daily JSONL shards in reverse so we
 * can stop as soon as the requested limit is hit instead of loading every day
 * into memory.
 */
export async function listAudit(opts: { target?: string; limit?: number } = {}): Promise<AuditEvent[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000))
  let files: string[]
  try {
    files = await readdir(config.paths.audit)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  files = files.filter((n) => n.endsWith('.jsonl')).sort().reverse()
  const out: AuditEvent[] = []
  for (const name of files) {
    if (out.length >= limit) break
    let raw: string
    try {
      raw = await readFile(path.join(config.paths.audit, name), 'utf8')
    } catch {
      continue
    }
    // Lines in append order — reverse so newest events surface first per file.
    const lines = raw.split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as AuditEvent
        if (opts.target && ev.target !== opts.target) continue
        out.push(ev)
        if (out.length >= limit) break
      } catch {
        /* skip corrupt */
      }
    }
  }
  return out
}
