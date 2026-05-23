/**
 * Per-folder metadata. Folders aren't documents (no ingest, no chunks), but
 * users want to attach the same affordances files have: tags, public link,
 * etc. We persist one JSON per `(owner, storageKey)` pair so the file store
 * stays untouched.
 *
 * File layout: data/folder-metas/<owner>__<sanitized-path>.json
 */
import path from 'node:path'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { config } from '../config.js'
import { ensureDir } from '../lib/fs.js'

export type FolderMeta = {
  owner: string
  /** Vault-relative folder path inside owner's namespace. "" = root. */
  storageKey: string
  tags: string[]
  public?: boolean
  publicExpiresAt?: number | null
  publicPasswordHash?: string | null
  createdAt: number
  updatedAt: number
}

function safeKey(owner: string, storageKey: string): string {
  const ownerSafe = owner.replace(/[^a-zA-Z0-9_-]/g, '_')
  const pathSafe = storageKey.replace(/[^a-zA-Z0-9_./-]/g, '_').replace(/\//g, '__')
  return `${ownerSafe}__${pathSafe || '_root'}.json`
}

function metaFile(owner: string, storageKey: string): string {
  return path.join(config.paths.folderMetas, safeKey(owner, storageKey))
}

export async function getFolderMeta(owner: string, storageKey: string): Promise<FolderMeta | null> {
  try {
    const raw = await readFile(metaFile(owner, storageKey), 'utf8')
    return JSON.parse(raw) as FolderMeta
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    return null
  }
}

export async function saveFolderMeta(meta: FolderMeta): Promise<void> {
  await ensureDir(config.paths.folderMetas)
  await writeFile(metaFile(meta.owner, meta.storageKey), JSON.stringify(meta, null, 2), 'utf8')
}

export async function deleteFolderMeta(owner: string, storageKey: string): Promise<void> {
  await rm(metaFile(owner, storageKey), { force: true })
}

export async function listFolderMetas(owner?: string): Promise<FolderMeta[]> {
  let names: string[]
  try {
    names = await readdir(config.paths.folderMetas)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out: FolderMeta[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const raw = await readFile(path.join(config.paths.folderMetas, n), 'utf8').catch(() => null)
    if (!raw) continue
    try {
      const m = JSON.parse(raw) as FolderMeta
      if (owner && m.owner !== owner) continue
      out.push(m)
    } catch {
      /* skip corrupt */
    }
  }
  return out
}

/** Sweep folder metas whose public expiry has passed; flip them to
 *  private so the listing UI + access gates behave consistently.
 *  Audits each flip with actor:'system' so the folder owner can
 *  trace "why did my shared folder go private?" back to its TTL
 *  in the Activity panel. */
export async function sweepExpiredPublicFolders(): Promise<number> {
  const metas = await listFolderMetas()
  const now = Date.now()
  let flipped = 0
  // Late-imported to dodge load-time cycles between stores.
  const { audit } = await import('./audit.js')
  for (const m of metas) {
    if (!m.public) continue
    if (m.publicExpiresAt == null) continue
    if (m.publicExpiresAt > now) continue
    await saveFolderMeta({
      ...m,
      public: false,
      publicExpiresAt: null,
      publicPasswordHash: null,
      updatedAt: now,
    })
    flipped++
    await audit({
      actor: 'system',
      action: 'vault.folder-visibility',
      target: m.storageKey,
      meta: {
        public: false,
        owner: m.owner,
        reason: 'public-link-expired',
        expiredAt: m.publicExpiresAt,
        source: 'auto-expire',
      },
    }).catch(() => { /* never break the sweep on an audit failure */ })
  }
  return flipped
}

/** Default scaffold used when no meta exists yet. */
export function freshFolderMeta(owner: string, storageKey: string): FolderMeta {
  const now = Date.now()
  return {
    owner,
    storageKey,
    tags: [],
    public: false,
    publicExpiresAt: null,
    publicPasswordHash: null,
    createdAt: now,
    updatedAt: now,
  }
}
