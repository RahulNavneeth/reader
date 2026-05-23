import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { audit, listAudit } from './audit.js'

const originalAudit = config.paths.audit

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-audit-'))
  ;(config.paths as { audit: string }).audit = dir
})

afterEach(async () => {
  const dir = config.paths.audit
  ;(config.paths as { audit: string }).audit = originalAudit
  await rm(dir, { recursive: true, force: true })
})

describe('audit store', () => {
  it('writes a JSONL line with a server-generated ts', async () => {
    await audit({ actor: 'alice', action: 'vault.upload', target: 'doc-1' })
    const files = await readdir(config.paths.audit)
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
    const raw = await readFile(path.join(config.paths.audit, files[0]), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const ev = JSON.parse(lines[0])
    expect(ev.actor).toBe('alice')
    expect(ev.action).toBe('vault.upload')
    expect(ev.target).toBe('doc-1')
    expect(typeof ev.ts).toBe('number')
  })

  it('appends — does not overwrite — on multiple emits same day', async () => {
    await audit({ actor: 'a', action: 'one' })
    await audit({ actor: 'b', action: 'two' })
    await audit({ actor: 'c', action: 'three' })
    const files = await readdir(config.paths.audit)
    expect(files).toHaveLength(1)
    const raw = await readFile(path.join(config.paths.audit, files[0]), 'utf8')
    expect(raw.split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('listAudit returns events newest-first', async () => {
    await audit({ actor: 'a', action: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    await audit({ actor: 'b', action: 'second' })
    await new Promise((r) => setTimeout(r, 5))
    await audit({ actor: 'c', action: 'third' })
    const events = await listAudit()
    expect(events.map((e) => e.action)).toEqual(['third', 'second', 'first'])
  })

  it('listAudit respects the limit', async () => {
    for (let i = 0; i < 7; i++) {
      await audit({ actor: 'a', action: `ev-${i}` })
      await new Promise((r) => setTimeout(r, 2))
    }
    const events = await listAudit({ limit: 3 })
    expect(events).toHaveLength(3)
    expect(events[0].action).toBe('ev-6')
    expect(events[2].action).toBe('ev-4')
  })

  it('listAudit filters by exact target', async () => {
    await audit({ actor: 'a', action: 'vault.edit', target: 'docX' })
    await audit({ actor: 'a', action: 'vault.edit', target: 'docY' })
    await audit({ actor: 'a', action: 'vault.edit', target: 'docX' })
    const xs = await listAudit({ target: 'docX' })
    expect(xs).toHaveLength(2)
    expect(xs.every((e) => e.target === 'docX')).toBe(true)
  })

  it('listAudit returns [] when the audit dir does not exist', async () => {
    // Wipe the dir before listing — listAudit should gracefully
    // return empty rather than throw.
    await rm(config.paths.audit, { recursive: true, force: true })
    const events = await listAudit()
    expect(events).toEqual([])
  })

  it('listAudit skips corrupt JSON lines silently', async () => {
    // Inject a bad line into the daily file alongside good ones.
    await audit({ actor: 'a', action: 'good-1' })
    const files = await readdir(config.paths.audit)
    const filePath = path.join(config.paths.audit, files[0])
    const { appendFile } = await import('node:fs/promises')
    await appendFile(filePath, 'not-json-at-all\n')
    await audit({ actor: 'a', action: 'good-2' })
    const events = await listAudit()
    expect(events.map((e) => e.action)).toEqual(['good-2', 'good-1'])
  })

  it('listAudit clamps limit into [1, 1000]', async () => {
    await audit({ actor: 'a', action: 'one' })
    // Negative / zero limit gets bumped to 1.
    const lo = await listAudit({ limit: -50 })
    expect(lo).toHaveLength(1)
    // Insanely large limit gets capped at 1000 (we don't have 1000
    // events but the call shouldn't reject).
    const hi = await listAudit({ limit: 1_000_000 })
    expect(hi).toHaveLength(1)
  })

  it('preserves meta payloads through round-trip', async () => {
    await audit({
      actor: 'alice',
      action: 'chat.apply_edit_op',
      target: 'doc-meta',
      meta: { messageId: 'm-1', op: 'replace_section', opIndex: 0, count: 3 },
    })
    const events = await listAudit({ target: 'doc-meta' })
    expect(events[0].meta).toEqual({
      messageId: 'm-1',
      op: 'replace_section',
      opIndex: 0,
      count: 3,
    })
  })
})
