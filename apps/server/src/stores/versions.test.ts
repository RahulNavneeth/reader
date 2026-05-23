import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import {
  listVersions,
  purgeVersions,
  readVersionText,
  snapshotVersion,
} from './versions.js'

const originalDocuments = config.paths.documents
const originalAudit = config.paths.audit

/**
 * Tests for the snapshot store. We swap both `config.paths.documents`
 * (where snapshots live) AND `config.paths.audit` (where the audit
 * emit lands) to a scratch dir per test. snapshotVersion / pruneOld
 * late-import audit, so the swap has to happen via the mutable
 * config object (which late-import re-reads).
 */
beforeEach(async () => {
  const docs = await mkdtemp(path.join(os.tmpdir(), 'reader-versions-docs-'))
  const audit = await mkdtemp(path.join(os.tmpdir(), 'reader-versions-audit-'))
  ;(config.paths as { documents: string }).documents = docs
  ;(config.paths as { audit: string }).audit = audit
})

afterEach(async () => {
  const docs = config.paths.documents
  const audit = config.paths.audit
  ;(config.paths as { documents: string }).documents = originalDocuments
  ;(config.paths as { audit: string }).audit = originalAudit
  await rm(docs, { recursive: true, force: true })
  await rm(audit, { recursive: true, force: true })
})

async function seedDoc(docId: string, sha: string, body = 'doc body'): Promise<string> {
  const root = path.join(config.paths.documents, docId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'meta.json'), JSON.stringify({ id: docId, sha256: sha, bytes: body.length }))
  await writeFile(path.join(root, 'text.txt'), body)
  await writeFile(path.join(root, 'chunks.jsonl'), '')
  return root
}

async function readAuditEvents(): Promise<Array<{ action: string; target?: string; actor: unknown; meta?: Record<string, unknown> }>> {
  const files = await readdir(config.paths.audit).catch(() => [])
  const out: Array<{ action: string; target?: string; actor: unknown; meta?: Record<string, unknown> }> = []
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue
    const raw = await readFile(path.join(config.paths.audit, name), 'utf8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
  }
  return out
}

describe('snapshotVersion', () => {
  it('no-ops when the doc has no meta on disk yet', async () => {
    // No seeded doc — function should return without throwing or
    // creating any version dirs. Also no audit event.
    await snapshotVersion('missing-doc')
    const events = await readAuditEvents()
    expect(events).toEqual([])
  })

  it('snapshots meta + text + chunks into a timestamped dir', async () => {
    await seedDoc('doc-1', 'sha-aaa')
    await snapshotVersion('doc-1')
    const versions = await listVersions('doc-1')
    expect(versions).toHaveLength(1)
    expect(versions[0].sha256).toBe('sha-aaa')
    expect(versions[0].hasText).toBe(true)
  })

  it('dedupes when the most recent snapshot has the same sha', async () => {
    // Two snapshots back-to-back with no file change should
    // produce ONE versioned row, not two. Guards against the
    // watcher's double-fire on macOS.
    await seedDoc('doc-2', 'sha-bbb')
    await snapshotVersion('doc-2')
    await new Promise((r) => setTimeout(r, 5)) // separate ts
    await snapshotVersion('doc-2')
    const versions = await listVersions('doc-2')
    expect(versions).toHaveLength(1)
  })

  it('creates a new snapshot when the sha changes', async () => {
    await seedDoc('doc-3', 'sha-v1')
    await snapshotVersion('doc-3')
    await new Promise((r) => setTimeout(r, 5))
    // Simulate the file being rewritten — meta.json now has a new
    // sha, so the next snapshot should NOT dedup.
    await seedDoc('doc-3', 'sha-v2', 'updated body')
    await snapshotVersion('doc-3')
    const versions = await listVersions('doc-3')
    expect(versions).toHaveLength(2)
    expect(versions[0].sha256).toBe('sha-v2')
    expect(versions[1].sha256).toBe('sha-v1')
  })

  it('emits version.snapshot audit with default watcher attribution', async () => {
    await seedDoc('doc-4', 'sha-ccc')
    await snapshotVersion('doc-4')
    const events = await readAuditEvents()
    const snap = events.find((e) => e.action === 'version.snapshot')
    expect(snap).toBeTruthy()
    expect(snap?.target).toBe('doc-4')
    expect(snap?.actor).toBeNull()
    expect((snap?.meta as { source?: string })?.source).toBe('watcher')
  })

  it('emits audit with caller-provided attribution', async () => {
    await seedDoc('doc-5', 'sha-ddd')
    await snapshotVersion('doc-5', {
      actor: 'alice',
      source: 'reader-ai',
      reason: 'apply-op',
    })
    const events = await readAuditEvents()
    const snap = events.find((e) => e.action === 'version.snapshot')
    expect(snap?.actor).toBe('alice')
    const m = snap?.meta as { source?: string; reason?: string }
    expect(m?.source).toBe('reader-ai')
    expect(m?.reason).toBe('apply-op')
  })

  it('skips the audit emit when the snapshot was deduped', async () => {
    // Important: the dedup short-circuits BEFORE writing files OR
    // auditing. Otherwise we'd have a phantom audit row pointing
    // at a non-existent version.
    await seedDoc('doc-6', 'sha-eee')
    await snapshotVersion('doc-6')
    // Clear any audit from the first call to isolate the second.
    await rm(config.paths.audit, { recursive: true, force: true })
    await mkdir(config.paths.audit, { recursive: true })
    await snapshotVersion('doc-6') // same sha — should dedup, no audit
    const events = await readAuditEvents()
    expect(events.filter((e) => e.action === 'version.snapshot')).toEqual([])
  })

  it('snapshot survives an audit-emit failure', async () => {
    // Wipe the audit dir AFTER seeding but the audit append should
    // still succeed (appendLine recreates parents). But we can
    // simulate a hard failure by making the audit path unwritable;
    // easier: assert the snapshot itself still landed even though
    // we can't easily force audit to throw without monkeypatching.
    // Realistic check: dedup case above already covers "snapshot
    // doesn't depend on audit". So instead verify the catch path
    // doesn't propagate: pre-create the audit path AS A FILE so
    // appendLine to a file-as-directory fails.
    await seedDoc('doc-7', 'sha-fff')
    // Make the audit dir a regular file → any write into it will
    // throw ENOTDIR. The try/catch in snapshotVersion should
    // swallow it.
    await rm(config.paths.audit, { recursive: true, force: true })
    await writeFile(config.paths.audit, 'block') // path is now a file
    await expect(snapshotVersion('doc-7')).resolves.toBeUndefined()
    // Audit broke but the snapshot directory exists.
    const versions = await listVersions('doc-7')
    expect(versions).toHaveLength(1)
    // Cleanup so the afterEach rm doesn't choke.
    await rm(config.paths.audit, { force: true })
  })
})

describe('pruneOld (via snapshotVersion)', () => {
  it('caps stored versions at MAX_VERSIONS (20) and audits the prune', async () => {
    // Take 22 distinct snapshots; the oldest 2 should disappear.
    const docId = 'doc-prune'
    for (let i = 0; i < 22; i++) {
      await seedDoc(docId, `sha-${i}`, `body ${i}`)
      await snapshotVersion(docId)
      // Sleep just enough to guarantee distinct ts (snapshot uses
      // Date.now()). 2ms is plenty on every CI host we run on.
      await new Promise((r) => setTimeout(r, 2))
    }
    const versions = await listVersions(docId)
    expect(versions).toHaveLength(20)
    // Newest first — top entry should be the most recent sha.
    expect(versions[0].sha256).toBe('sha-21')
    // Oldest two (sha-0, sha-1) should be gone.
    expect(versions.find((v) => v.sha256 === 'sha-0')).toBeUndefined()
    expect(versions.find((v) => v.sha256 === 'sha-1')).toBeUndefined()

    const events = await readAuditEvents()
    const prunes = events.filter((e) => e.action === 'version.prune')
    expect(prunes.length).toBeGreaterThan(0)
    const lastPrune = prunes[0] // newest first not guaranteed across files; any is fine
    const m = lastPrune.meta as { prunedCount?: number; cap?: number; source?: string }
    expect(m?.cap).toBe(20)
    expect(m?.source).toBe('auto-cleanup')
    expect(typeof m?.prunedCount).toBe('number')
    expect((m?.prunedCount ?? 0)).toBeGreaterThan(0)
  })
})

describe('listVersions / readVersionText / purgeVersions', () => {
  it('returns [] for a doc with no versions dir', async () => {
    expect(await listVersions('nope')).toEqual([])
  })

  it('returns snapshots newest-first with hasText flag', async () => {
    await seedDoc('doc-list', 'sha-list-1')
    await snapshotVersion('doc-list')
    await new Promise((r) => setTimeout(r, 5))
    await seedDoc('doc-list', 'sha-list-2', 'newer')
    await snapshotVersion('doc-list')
    const versions = await listVersions('doc-list')
    expect(versions.map((v) => v.sha256)).toEqual(['sha-list-2', 'sha-list-1'])
    expect(versions.every((v) => v.hasText)).toBe(true)
  })

  it('readVersionText pulls back the snapshotted text', async () => {
    await seedDoc('doc-read', 'sha-x', 'original')
    await snapshotVersion('doc-read')
    const versions = await listVersions('doc-read')
    const text = await readVersionText('doc-read', versions[0].ts)
    expect(text).toBe('original')
  })

  it('readVersionText returns null for an unknown ts', async () => {
    expect(await readVersionText('doc-read', 0)).toBeNull()
  })

  it('purgeVersions removes the entire versions tree', async () => {
    await seedDoc('doc-purge', 'sha-p')
    await snapshotVersion('doc-purge')
    expect(await listVersions('doc-purge')).toHaveLength(1)
    await purgeVersions('doc-purge')
    expect(await listVersions('doc-purge')).toEqual([])
    // versionsDir should be gone, not just emptied.
    const exists = await stat(path.join(config.paths.documents, 'doc-purge', 'versions')).catch(() => null)
    expect(exists).toBeNull()
  })
})
