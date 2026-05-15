import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
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
