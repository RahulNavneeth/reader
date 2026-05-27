/**
 * Document version history. Whenever an indexed file's content changes on
 * disk (sha256 differs), we snapshot the previous meta + extracted text +
 * chunks into `data/documents/<id>/versions/<ts>/`. That gives a "what did
 * this file look like at time X" record without paying double the storage
 * cost of keeping the binary blob.
 *
 * Versions are capped per doc (default 20) to keep disk usage bounded.
 */
import path from 'node:path'
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { config } from '../config.js'

const MAX_VERSIONS = 20

function versionsDir(docId: string): string {
  const safe = docId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(config.paths.documents, safe, 'versions')
}

function versionDir(docId: string, ts: number): string {
  return path.join(versionsDir(docId), String(ts))
}

export type VersionRecord = {
  ts: number
  sha256: string
  bytes: number
  title?: string
  /** Whether this version has its text.txt extracted. */
  hasText: boolean
}

/**
 * Snapshot the doc's current meta.json + text.txt + chunks.jsonl into a
 * timestamped subdir. Called right BEFORE overwriting them with the new
 * ingest output. The ts is the source-of-truth ordering key.
 */
export async function snapshotVersion(
  docId: string,
  attribution?: {
    /** Caller context — drives the audit entry's actor/source so
     *  the Activity panel can attribute the snapshot to who/what
     *  triggered it. Watcher-driven snapshots set source:'watcher'
     *  and leave actor null; in-process callers (apply-edit, MCP
     *  write, etc.) pass their own actor + a source tag. */
    actor?: string | null
    source?: 'watcher' | 'reader-ai' | 'mcp' | 'manual' | 'crdt'
    /** Optional cause label folded into audit meta (e.g. the
     *  parent action that prompted the snapshot). */
    reason?: string
  },
): Promise<void> {
  const docRoot = path.join(config.paths.documents, docId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const metaPath = path.join(docRoot, 'meta.json')
  const textPath = path.join(docRoot, 'text.txt')
  const chunksPath = path.join(docRoot, 'chunks.jsonl')
  const metaSt = await stat(metaPath).catch(() => null)
  if (!metaSt) return // no current meta to snapshot

  // Dedupe by sha256: if the most recent existing snapshot already
  // has the exact same content (same sha256 as the doc's current
  // meta), skip — adds a new ts row that would be visually
  // confusing (same content "version" reappearing) and wastes
  // disk. The watcher can fire multiple change events for a
  // single write on some platforms; this is the catch-all.
  let curSha = ''
  let curBytes: number | null = null
  try {
    const rawMeta = await readFile(metaPath, 'utf8')
    const parsed = JSON.parse(rawMeta)
    curSha = parsed?.sha256 ?? ''
    curBytes = typeof parsed?.bytes === 'number' ? parsed.bytes : null
    if (curSha) {
      const names = await readdir(versionsDir(docId)).catch(() => [])
      const tsList = names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a)
      const latestTs = tsList[0]
      if (latestTs !== undefined) {
        const prevRaw = await readFile(path.join(versionDir(docId, latestTs), 'meta.json'), 'utf8').catch(() => null)
        if (prevRaw) {
          const prevSha = JSON.parse(prevRaw)?.sha256 ?? ''
          if (prevSha === curSha) return
        }
      }
    }
  } catch { /* fall through and snapshot anyway */ }

  const ts = Date.now()
  const dir = versionDir(docId, ts)
  await mkdir(dir, { recursive: true })
  await copyFile(metaPath, path.join(dir, 'meta.json')).catch(() => null)
  await copyFile(textPath, path.join(dir, 'text.txt')).catch(() => null)
  await copyFile(chunksPath, path.join(dir, 'chunks.jsonl')).catch(() => null)
  await pruneOld(docId)

  // Audit AFTER the snapshot actually landed (and only when the
  // sha-dedup didn't short-circuit above). Late-import the audit
  // store so we don't create a load-time cycle between versions.ts
  // and stores/audit.ts.
  try {
    const { audit } = await import('./audit.js')
    await audit({
      actor: attribution?.actor ?? null,
      action: 'version.snapshot',
      target: docId,
      meta: {
        ts,
        sha256: curSha || undefined,
        bytes: curBytes ?? undefined,
        source: attribution?.source ?? 'watcher',
        reason: attribution?.reason,
      },
    })
  } catch { /* swallow — audit must not break the snapshot path */ }
}

async function pruneOld(docId: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(versionsDir(docId))
  } catch {
    return
  }
  const numeric = names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a)
  const expired = numeric.slice(MAX_VERSIONS)
  if (expired.length === 0) return
  for (const ts of expired) {
    await rm(versionDir(docId, ts), { recursive: true, force: true }).catch(() => null)
  }
  // Audit the prune so a user puzzled by a missing old snapshot in
  // the Versions rail can trace it to the MAX_VERSIONS cap rather
  // than wondering if they lost it. Coalesced into a single event
  // per prune call instead of one per ts to keep the log scannable.
  try {
    const { audit } = await import('./audit.js')
    await audit({
      actor: 'system',
      action: 'version.prune',
      target: docId,
      meta: {
        prunedCount: expired.length,
        prunedTs: expired,
        keptCount: Math.min(numeric.length, MAX_VERSIONS),
        cap: MAX_VERSIONS,
        source: 'auto-cleanup',
      },
    })
  } catch { /* never break the snapshot path on an audit error */ }
}

export async function listVersions(docId: string): Promise<VersionRecord[]> {
  let names: string[]
  try {
    names = await readdir(versionsDir(docId))
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    return []
  }
  const out: VersionRecord[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const ts = Number(name)
    const metaPath = path.join(versionDir(docId, ts), 'meta.json')
    const raw = await readFile(metaPath, 'utf8').catch(() => null)
    if (!raw) continue
    let meta: any
    try {
      meta = JSON.parse(raw)
    } catch {
      continue
    }
    const hasText = !!(await stat(path.join(versionDir(docId, ts), 'text.txt')).catch(() => null))
    out.push({
      ts,
      sha256: meta.sha256 ?? '',
      bytes: meta.bytes ?? 0,
      title: meta.title,
      hasText,
    })
  }
  out.sort((a, b) => b.ts - a.ts)
  return out
}

export async function readVersionText(docId: string, ts: number): Promise<string | null> {
  try {
    return await readFile(path.join(versionDir(docId, ts), 'text.txt'), 'utf8')
  } catch {
    return null
  }
}

export async function purgeVersions(docId: string): Promise<void> {
  await rm(versionsDir(docId), { recursive: true, force: true }).catch(() => null)
}

// keep imports happy if writeFile gets unused after edits — re-export for tooling.
export { writeFile as _writeFile }
