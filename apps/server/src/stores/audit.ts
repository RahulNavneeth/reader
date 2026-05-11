import path from 'node:path'
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
