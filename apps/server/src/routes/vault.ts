/**
 * Vault routes — Obsidian-style. The vault is a normal directory on disk;
 * every path the API surfaces is vault-relative ("foo/bar.pdf"). Resolved
 * paths are validated to stay inside the vault before any I/O.
 *
 * Endpoints:
 *   GET    /api/home                    → vault root + separator (still useful for the UI)
 *   GET    /api/list?path=<rel>         → tree contents at <rel> (default = vault root)
 *   GET    /api/file/text?path=<rel>    → utf-8 text (md / txt / extracted text for binaries if indexed)
 *   GET    /api/file/raw?path=<rel>     → raw bytes with proper Content-Type
 *   POST   /api/file/upload             → multipart, optional `path` field = target dir, runs ingest
 *   POST   /api/file/index              → re-run ingest for an existing vault file
 *   DELETE /api/file?path=<rel>         → delete file from vault + drop its index
 *   POST   /api/folder?path=<rel>       → mkdir
 */
import path from 'node:path'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { nanoid } from 'nanoid'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { moveAcrossDevices } from '../lib/fs.js'
import { audit } from '../stores/audit.js'
import {
  deleteDocument,
  listAllDocuments,
  readText as readExtracted,
  readThumbnail,
  readPreview,
  saveMeta,
  sha256Of,
  userCanRead,
  userCanEdit,
} from '../stores/documents.js'
import { generateThumbnail } from '../services/thumbnail.js'
import { writeThumbnail, writePreview } from '../stores/documents.js'
import { moveToTrash } from '../stores/trash.js'
import { ingestDocument } from '../services/ingest.js'
import { couldHaveGps, extractGps } from '../services/gps.js'
import { validateUpload } from '../lib/uploadGuard.js'
import {
  couldBeLiveMotion,
  couldBeLiveStill,
  findMotionFor,
  findStillFor,
} from '../services/livePhoto.js'
import { invalidateSearchCache } from '../services/search.js'
import { publish } from '../services/events.js'
import { dispatch as dispatchWebhook } from '../services/webhooks.js'
import type { DocumentMeta } from '../types.js'
import { resolveUserVault, userVaultRel, ensureUserVault, userVaultRoot } from '../lib/userVault.js'
import { hashPassword as hashShareSecret, verifyPassword as verifySharePassword } from '../lib/sharePassword.js'
import { findShareForPath } from '../stores/userShares.js'
import {
  freshFolderMeta,
  getFolderMeta,
  listFolderMetas,
  saveFolderMeta,
} from '../stores/folderMetas.js'

// ─── path helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a vault-relative path inside `owner`'s namespace. Every authed
 * route passes `req.currentUser.username`; anonymous routes look up the
 * file's DocumentMeta first to learn the owner from `meta.owner`.
 */
function resolveVault(rel: string | undefined, owner: string): string {
  try {
    return resolveUserVault(owner, rel)
  } catch (e: any) {
    if (e?.statusCode) throw e
    throw httpErr(400, 'invalid path')
  }
}

function toVaultRel(abs: string, owner: string): string {
  return userVaultRel(owner, abs)
}

/**
 * Walk a vault path and return every supported file beneath it, paths
 * relative to the owner's vault root. If the input is a file, returns
 * just that file; if a directory, walks recursively. Skips hidden entries.
 */
async function expandFilesUnder(owner: string, rel: string): Promise<string[]> {
  const abs = resolveVault(rel, owner)
  const s = await stat(abs).catch(() => null)
  if (!s) return []
  if (s.isFile()) return [rel]
  if (!s.isDirectory()) return []
  const out: string[] = []
  async function walk(curAbs: string, curRel: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(curAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (shouldSkipName(e.name)) continue
      const childAbs = path.join(curAbs, e.name)
      const childRel = curRel ? `${curRel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (e.isFile()) {
        // Listing intentionally shows every file. Ingest / search
        // pipelines filter for the formats they can actually process,
        // but the user should still see (and download/share/delete)
        // whatever they put on disk — audio, zips, source code, etc.
        out.push(childRel)
      }
    }
  }
  await walk(abs, rel.replace(/\/+$/, ''))
  return out
}

/**
 * Walk a folder and return every supported file AND subfolder beneath it,
 * paths relative to the owner's vault root. Used by folder-level visibility
 * so we can flip both the file metas and the per-folder metas in one pass.
 */
async function expandTreeUnder(
  owner: string,
  rel: string,
): Promise<{ files: string[]; folders: string[] }> {
  const abs = resolveVault(rel, owner)
  const s = await stat(abs).catch(() => null)
  if (!s || !s.isDirectory()) return { files: [], folders: [] }
  const files: string[] = []
  const folders: string[] = []
  async function walk(curAbs: string, curRel: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(curAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (shouldSkipName(e.name)) continue
      const childAbs = path.join(curAbs, e.name)
      const childRel = curRel ? `${curRel}/${e.name}` : e.name
      if (e.isDirectory()) {
        folders.push(childRel)
        await walk(childAbs, childRel)
      } else if (e.isFile()) {
        // No extension filter — folder cascade should act on every
        // file the user can see in the grid (which is everything).
        files.push(childRel)
      }
    }
  }
  await walk(abs, rel.replace(/\/+$/, ''))
  return { files, folders }
}

/** Strip the password hash before sending meta to a client. Always
 *  redacts; previously only fired when a hash existed, which leaked the
 *  hash field shape for passworded files. */
function redactPublicMeta(meta: DocumentMeta): DocumentMeta {
  const { publicPasswordHash, ...rest } = meta
  void publicPasswordHash
  return { ...rest, publicPasswordHash: null } as DocumentMeta
}

/** Stricter redaction for callers that aren't the owner — drops the ACL,
 *  internal id, sha256, and password hash so a public-link viewer can't
 *  enumerate who else has access or fingerprint the bytes. Used for
 *  anonymous read responses on /api/file/meta. */
function redactForPublicViewer(meta: DocumentMeta): Partial<DocumentMeta> {
  const {
    publicPasswordHash,
    acl,
    sha256,
    id,
    ...rest
  } = meta
  void publicPasswordHash
  void acl
  void sha256
  void id
  return { ...rest, publicPasswordHash: null }
}

/** Middle tier: authenticated cross-owner viewer with an explicit
 *  share grant. They already have ACL'd read access, so exposing the
 *  internal id is fine (and required for client-side features like
 *  AI chat that POST to /api/chat/:docId/stream). We still strip
 *  ACL + sha256 because those would let them enumerate other
 *  recipients / fingerprint the bytes. */
function redactForShareRecipient(meta: DocumentMeta): Partial<DocumentMeta> {
  const { publicPasswordHash, acl, sha256, ...rest } = meta
  void publicPasswordHash
  void acl
  void sha256
  return { ...rest, publicPasswordHash: null }
}

/**
 * Resolve the effective owner/meta for a read request. Handles three cases:
 *
 *   1. Request includes `?owner=` and that owner != the caller →
 *      cross-user share path. We look up the doc record in the owner's
 *      namespace and verify a UserShare grant exists. Returns null if not.
 *   2. Public file matches the path (anonymous or any user) → return its
 *      record so the public gate applies.
 *   3. Otherwise scope to the caller's own namespace.
 *
 * Returns `{ meta, owner, sharedGrant }` where `sharedGrant` carries the
 * canEdit flag when this is a cross-user shared access.
 */
/** True when `meta` is reachable via a user-share grant that the recipient
 *  holds — checks direct grants AND folder-ancestor grants. Used by the
 *  read endpoints that go through doc lists (tags, search, by-tag)
 *  rather than path-based resolveReadContext. */
async function isReadableViaShares(
  meta: DocumentMeta,
  recipient: string,
  shares: import('../stores/userShares.js').UserShare[],
): Promise<boolean> {
  if (meta.owner === recipient) return true
  const target = meta.storageKey.replace(/^\/+|\/+$/g, '')
  for (const s of shares) {
    if (s.owner !== meta.owner) continue
    const sk = s.storageKey.replace(/^\/+|\/+$/g, '')
    if (s.isFolder) {
      if (sk === '' || target === sk || target.startsWith(sk + '/')) return true
    } else if (target === sk) {
      return true
    }
  }
  return false
}

/** Edit-grant variant of `isReadableViaShares`. Returns true only when
 *  the recipient holds a share covering the path AND that share has
 *  `canEdit: true`. */
async function isEditableViaShare(
  meta: { owner: string; storageKey: string },
  user: { username: string; role: string },
): Promise<boolean> {
  if (user.role === 'admin') return true
  if (meta.owner === user.username) return true
  const { listSharesTo } = await import('../stores/userShares.js')
  const shares = await listSharesTo(user.username)
  const target = meta.storageKey.replace(/^\/+|\/+$/g, '')
  for (const s of shares) {
    if (s.owner !== meta.owner) continue
    if (!s.canEdit) continue
    const sk = s.storageKey.replace(/^\/+|\/+$/g, '')
    if (s.isFolder) {
      if (sk === '' || target === sk || target.startsWith(sk + '/')) return true
    } else if (target === sk) {
      return true
    }
  }
  return false
}

async function resolveReadContext(opts: {
  rel: string
  ownerHint?: string
  requester?: string
}): Promise<{
  meta: DocumentMeta | null
  owner: string | null
  sharedGrant: { canEdit: boolean } | null
}> {
  const { rel, ownerHint, requester } = opts
  const docs = await listAllDocuments()

  if (ownerHint && requester && ownerHint !== requester) {
    const grant = await findShareForPath(requester, ownerHint, rel)
    if (grant) {
      const meta = docs.find((d) => d.owner === ownerHint && d.storageKey === rel) ?? null
      return { meta, owner: ownerHint, sharedGrant: { canEdit: grant.canEdit } }
    }
    // No direct folder/file share — but the doc might be reachable
    // via a collection that's shared with the requester.
    const { grantsForUser } = await import('../db/collectionsRepo.js')
    const cg = grantsForUser(requester)
    if (cg.readableDocs.size > 0) {
      const hit = docs.find(
        (d) => d.owner === ownerHint && d.storageKey === rel && cg.readableDocs.has(d.id),
      )
      if (hit) {
        return {
          meta: hit,
          owner: ownerHint,
          sharedGrant: { canEdit: cg.editableDocs.has(hit.id) },
        }
      }
    }
    return { meta: null, owner: null, sharedGrant: null }
  }

  // Concurrent stub-creation (auto-ingest + visibility) can leave two doc
  // records pointing at the same (owner, storageKey). Prefer the public
  // one so a freshly-published file doesn't read back as private just
  // because the parallel ingest record happens to sort first.
  const owned = docs.filter((d) => d.storageKey === rel && d.owner === requester)
  const own = owned.find((d) => d.public) ?? owned[0]
  const pub = docs.find((d) => d.storageKey === rel && d.public)
  const meta = own ?? pub ?? null
  let owner = meta?.owner ?? requester ?? null
  let sharedGrant: { canEdit: boolean } | null = null

  // Share-grant fallthrough — if the requester hits a bare path (no
  // ownerHint), they shouldn't 404 on a path that's shared with them
  // by another user. Scan incoming shares and elevate to the share
  // owner if any covers the path.
  if (requester && !ownerHint && !meta) {
    const { listSharesTo } = await import('../stores/userShares.js')
    const sharesIn = await listSharesTo(requester)
    const target = rel.replace(/^\/+|\/+$/g, '')
    for (const s of sharesIn) {
      const sk = s.storageKey.replace(/^\/+|\/+$/g, '')
      const covers = s.isFolder
        ? sk === '' || target === sk || target.startsWith(sk + '/')
        : target === sk
      if (!covers) continue
      const sharedMeta =
        docs.find((d) => d.owner === s.owner && d.storageKey === rel) ?? null
      owner = s.owner
      sharedGrant = { canEdit: s.canEdit }
      return { meta: sharedMeta, owner, sharedGrant }
    }

    // Collection-cascade fallthrough: a doc reached through a shared
    // collection can be served at its real owner's path even though
    // the requester has no folder/path share for it. Cheaper than
    // listSharesTo (one indexed query per request), so it lives here
    // after the explicit-share path which short-circuits on hit.
    const { grantsForUser } = await import('../db/collectionsRepo.js')
    const cg = grantsForUser(requester)
    if (cg.readableDocs.size > 0) {
      const hit = docs.find(
        (d) => d.storageKey === rel && cg.readableDocs.has(d.id),
      )
      if (hit) {
        return {
          meta: hit,
          owner: hit.owner,
          sharedGrant: { canEdit: cg.editableDocs.has(hit.id) },
        }
      }
    }
  }
  return { meta, owner, sharedGrant }
}

/**
/**
 * Per-IP failed-gate throttle. `publicGate` calls scrypt-verify which
 * is intentionally CPU-heavy; an attacker hammering /api/file/raw?p=
 * with wrong passwords would stall the event loop. Lock the IP out
 * for 15 min after 20 failed `?p=` attempts in any 15-min window.
 */
const GATE_WINDOW_MS = 15 * 60 * 1000
const GATE_MAX_FAILURES = 20
type GateBucket = { failures: number; firstFailAt: number; lockedUntil: number }
const gateBuckets = new Map<string, GateBucket>()
function gateLockedSeconds(ip: string): number | null {
  const b = gateBuckets.get(ip)
  if (!b) return null
  const now = Date.now()
  if (b.lockedUntil > now) return Math.ceil((b.lockedUntil - now) / 1000)
  if (now - b.firstFailAt > GATE_WINDOW_MS) {
    gateBuckets.delete(ip)
    return null
  }
  return null
}
function recordGateFailure(ip: string): void {
  const now = Date.now()
  const b = gateBuckets.get(ip)
  if (!b || now - b.firstFailAt > GATE_WINDOW_MS) {
    gateBuckets.set(ip, { failures: 1, firstFailAt: now, lockedUntil: 0 })
    return
  }
  b.failures++
  if (b.failures >= GATE_MAX_FAILURES) b.lockedUntil = now + GATE_WINDOW_MS
}
function clearGateFailures(ip: string): void {
  gateBuckets.delete(ip)
}
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of gateBuckets) {
    if (b.lockedUntil < now && now - b.firstFailAt > GATE_WINDOW_MS) {
      gateBuckets.delete(k)
    }
  }
}, 5 * 60 * 1000).unref()

/**
 * Walk up the path looking for the closest ancestor folder that has a
 * public FolderMeta. Returns its public state so a new child can
 * inherit it. Returns null if no ancestor is public.
 */
async function closestPublicAncestor(
  owner: string,
  rel: string,
): Promise<{
  public: true
  publicExpiresAt: number | null
  publicPasswordHash: string | null
} | null> {
  const segs = rel.split('/').filter(Boolean)
  // Walk from root → leaf so we pick the OUTERMOST public ancestor's
  // settings (the share that established the link, not a deeper
  // re-cascade that might have been revoked at the parent level).
  for (let i = 0; i < segs.length; i++) {
    const ancestorRel = segs.slice(0, i).join('/')
    const fm = await getFolderMeta(owner, ancestorRel).catch(() => null)
    if (fm?.public) {
      return {
        public: true,
        publicExpiresAt: fm.publicExpiresAt ?? null,
        publicPasswordHash: fm.publicPasswordHash ?? null,
      }
    }
  }
  return null
}

/**
 * Per-user in-flight upload byte reservation. Without this two
 * concurrent uploads each see the same `used` snapshot and both pass
 * the quota check even when they collectively exceed the cap.
 * Reserved bytes get returned in the finally block of /api/file/upload.
 */
const reservedUploadBytes = new Map<string, number>()
function reserveUploadBytes(username: string, bytes: number): void {
  reservedUploadBytes.set(username, (reservedUploadBytes.get(username) ?? 0) + bytes)
}
function releaseUploadBytes(username: string, bytes: number): void {
  const next = (reservedUploadBytes.get(username) ?? 0) - bytes
  if (next <= 0) reservedUploadBytes.delete(username)
  else reservedUploadBytes.set(username, next)
}
function getReservedUploadBytes(username: string): number {
  return reservedUploadBytes.get(username) ?? 0
}

/**
 * Check whether a public file is currently reachable by an anonymous caller.
 * Returns:
 *   - 'ok'                — public, no password (or correct password supplied)
 *   - 'password-required' — public + password hash + caller didn't include `?p=`
 *   - 'password-wrong'    — `?p=` provided but doesn't match
 *   - 'not-public'        — file isn't marked public at all (or expiry has passed)
 *
 * Expiry collapses to `not-public` — there's no separate "expired"
 * state. A periodic sweep flips `public:false` on expired metas so the
 * data and the gate agree.
 */
function publicGate(
  meta: { public?: boolean; publicExpiresAt?: number | null; publicPasswordHash?: string | null } | null | undefined,
  providedPassword: string | undefined,
): 'ok' | 'password-required' | 'password-wrong' | 'not-public' {
  if (!meta?.public) return 'not-public'
  if (meta.publicExpiresAt != null && meta.publicExpiresAt < Date.now()) {
    return 'not-public'
  }
  if (meta.publicPasswordHash) {
    if (!providedPassword) return 'password-required'
    if (!verifySharePassword(meta.publicPasswordHash, providedPassword)) return 'password-wrong'
  }
  return 'ok'
}

function httpErr(status: number, message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number }
  e.statusCode = status
  return e
}

// ─── tree types ─────────────────────────────────────────────────────────────

function shouldSkipName(name: string): boolean {
  if (name.startsWith('.')) return true
  if (name === 'node_modules' || name === 'dist' || name === 'build') return true
  return false
}

type TreeNode = {
  name: string
  /** vault-relative path, "" for root */
  path: string
  type: 'dir' | 'file'
  ext?: string
  size?: number
  mtime?: number
  hasChildren?: boolean
  /** populated when an index exists for this file */
  docId?: string
  ingestStatus?: string
  embedded?: boolean
  public?: boolean
  publicExpiresAt?: number | null
  tags?: string[]
}

// ─── filename helpers ───────────────────────────────────────────────────────

/**
 * Live-Photo pair detection. After a still or motion file uploads,
 * scan its directory's other DocumentMeta records owned by the same
 * user for an opposite-kind sibling with the same stem; tag both
 * metas with `livePhotoPair = <other path>` so the timeline UI can
 * play the motion when the user hovers the still.
 */
async function detectAndLinkLivePhotoPair(meta: DocumentMeta): Promise<void> {
  const isStill = couldBeLiveStill(meta.originalFilename)
  const isMotion = couldBeLiveMotion(meta.originalFilename)
  if (!isStill && !isMotion) return
  const dir = meta.storageKey.includes('/')
    ? meta.storageKey.slice(0, meta.storageKey.lastIndexOf('/'))
    : ''
  const all = await listAllDocuments()
  const siblings = all.filter(
    (d) =>
      d.owner === meta.owner &&
      d.id !== meta.id &&
      (d.storageKey.includes('/')
        ? d.storageKey.slice(0, d.storageKey.lastIndexOf('/')) === dir
        : dir === ''),
  )
  const siblingNames = siblings.map((s) => s.originalFilename)
  const matchName = isStill
    ? findMotionFor(meta.originalFilename, siblingNames)
    : findStillFor(meta.originalFilename, siblingNames)
  if (!matchName) {
    // Cache the negative so a same-folder upload that doesn't pair
    // doesn't keep re-scanning siblings on every reload.
    if (meta.livePhotoPair === undefined) {
      await saveMeta({ ...meta, livePhotoPair: null })
    }
    return
  }
  const matchDoc = siblings.find((s) => s.originalFilename === matchName)
  if (!matchDoc) return
  await Promise.all([
    saveMeta({ ...meta, livePhotoPair: matchDoc.storageKey }),
    saveMeta({ ...matchDoc, livePhotoPair: meta.storageKey }),
  ])
}

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\- ()]+/g, '_').replace(/^[ ._]+/, '')
  if (!base || base === '.' || base === '..') return 'file'
  return base
}

async function uniquePath(targetDir: string, filename: string): Promise<string> {
  const ext = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length) || 'file'
  let attempt = 0
  while (true) {
    const candidate = attempt === 0 ? filename : `${stem} (${attempt})${ext}`
    const full = path.join(targetDir, candidate)
    try {
      await stat(full)
      attempt++
    } catch (e: any) {
      if (e?.code === 'ENOENT') return full
      throw e
    }
  }
}

function inferMime(filename: string, fallback?: string): string {
  const ext = path.extname(filename).toLowerCase()
  const m: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.mdx': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.toml': 'application/toml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.jxl': 'image/jxl',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.3gp': 'video/3gpp',
    '.3gpp': 'video/3gpp',
    '.mts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.ogv': 'video/ogg',
  }
  return m[ext] || fallback || 'application/octet-stream'
}

// ─── routes ─────────────────────────────────────────────────────────────────

export async function vaultRoutes(app: FastifyInstance) {
  // Tiny inline auth helper for routes we don't want behind the global preHandler
  // (raw / text / meta are publicly readable when meta.public === true).
  const requireAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!req.currentUser) {
      reply.code(401).send({ error: 'auth required' })
      return false
    }
    return true
  }

  // ---- meta -----------------------------------------------------------------

  app.get('/api/home', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    // Surface the requesting user's vault root (not the shared parent) so
    // the UI / breadcrumbs are accurate per-user.
    const user = req.currentUser!
    return { vault: userVaultRoot(user.username), separator: path.sep }
  })

  // Recursive list of every folder path in the user's vault.
  app.get('/api/folders', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    await ensureUserVault(user.username).catch(() => null)
    const out: string[] = []
    async function walk(absDir: string, rel: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (shouldSkipName(e.name)) continue
        if (!e.isDirectory()) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        out.push(childRel)
        await walk(path.join(absDir, e.name), childRel)
      }
    }
    await walk(userVaultRoot(user.username), '')
    out.sort()
    return { folders: out }
  })

  // Full vault tree (folders + files) for the requesting user.
  app.get('/api/vault-tree', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    await ensureUserVault(user.username).catch(() => null)
    const folders: string[] = []
    const files: string[] = []
    async function walk(absDir: string, rel: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (shouldSkipName(e.name)) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          folders.push(childRel)
          await walk(path.join(absDir, e.name), childRel)
        } else if (e.isFile()) {
          // Include every file in the tree dump — same reasoning as
          // the listing endpoints: storage isn't gated by what we can
          // index for search.
          files.push(childRel)
        }
      }
    }
    await walk(userVaultRoot(user.username), '')
    folders.sort()
    files.sort()
    return { folders, files }
  })

  // ---- list -----------------------------------------------------------------

  // ---- resolve ------------------------------------------------------------
  //
  // Single lookup that tells the client whether `<path>` is a file or a
  // folder, and whether it's accessible. The web router uses this to
  // dispatch bare paths (no /docs or /folder prefix) to the right viewer
  // without the user having to remember which one to use.
  app.get('/api/resolve', async (req, reply) => {
    const { path: rel = '', owner: ownerHint, p: providedPassword } =
      req.query as { path?: string; owner?: string; p?: string }
    const requester = req.currentUser?.username

    // Resolve owner: prefer authed user; for anonymous, try to find a
    // public file or folder with this path so the share URL "just works"
    // without the recipient knowing whose vault it lives in.
    const candidateOwners: string[] = []
    if (requester) candidateOwners.push(requester)
    if (ownerHint && !candidateOwners.includes(ownerHint)) candidateOwners.push(ownerHint)

    for (const owner of candidateOwners) {
      const abs = resolveVault(rel, owner)
      const s = await stat(abs).catch(() => null)
      if (!s) continue
      // Cross-owner access path: a user-share grant on this path (or any
      // ancestor folder) counts as access too. The client gets back
      // canEdit so it can hide owner-only controls (Tags/Activity/etc.)
      // for read-only shares.
      const grant =
        requester && owner !== requester
          ? await findShareForPath(requester, owner, rel)
          : null
      const access: {
        ownedByRequester: boolean
        sharedReadOnly: boolean
        sharedEdit: boolean
      } = {
        ownedByRequester: owner === requester,
        sharedReadOnly: !!grant && !grant.canEdit,
        sharedEdit: !!grant && grant.canEdit,
      }
      if (s.isFile()) {
        const docs = await listAllDocuments()
        const meta = docs.find((d) => d.storageKey === rel && d.owner === owner) ?? null
        if (owner === requester || grant || (meta && meta.public)) {
          return { kind: 'file', owner, public: !!meta?.public, access }
        }
      } else if (s.isDirectory()) {
        const fm = await getFolderMeta(owner, rel)
        if (owner === requester || grant || fm?.public) {
          return { kind: 'folder', owner, public: !!fm?.public, access }
        }
      }
    }

    // Share-grant fallthrough — for authed callers, scan incoming
    // share grants. A recipient who got a bare-path URL (no `owner=`)
    // for a file/folder shared with them by another user should
    // resolve to the share owner automatically, not 404.
    if (requester) {
      const { listSharesTo } = await import('../stores/userShares.js')
      const sharesIn = await listSharesTo(requester)
      const target = rel.replace(/^\/+|\/+$/g, '')
      for (const share of sharesIn) {
        const sk = share.storageKey.replace(/^\/+|\/+$/g, '')
        const covers = share.isFolder
          ? sk === '' || target === sk || target.startsWith(sk + '/')
          : target === sk
        if (!covers) continue
        const abs = resolveVault(rel, share.owner)
        const s = await stat(abs).catch(() => null)
        if (!s) continue
        const docs = await listAllDocuments()
        const meta =
          docs.find((d) => d.storageKey === rel && d.owner === share.owner) ?? null
        return {
          kind: s.isFile() ? 'file' : 'folder',
          owner: share.owner,
          public: !!meta?.public,
          access: {
            ownedByRequester: false,
            sharedReadOnly: !share.canEdit,
            sharedEdit: share.canEdit,
          },
        }
      }
    }

    // Public fallthrough — applies to both anonymous AND authed
    // callers when the path didn't resolve under the caller's vault
    // (or the supplied ownerHint). Lets a recipient who got a
    // public-link URL via clipboard open it without the owner=
    // query, even while signed in.
    //
    // Error responses include `kind` so the client can render the
    // right viewer (file vs folder) for the password-prompt UI
    // without guessing.
    {
      const docs = await listAllDocuments()
      const pubFile = docs.find((d) => d.storageKey === rel && d.public)
      if (pubFile) {
        const gate = publicGate(pubFile, providedPassword)
        if (gate === 'password-required' || gate === 'password-wrong') {
          return reply.code(401).send({
            error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
            passwordRequired: true,
            kind: 'file',
          })
        }
        if (gate === 'ok')
          return {
            kind: 'file',
            owner: pubFile.owner,
            public: true,
            access: { ownedByRequester: false, sharedReadOnly: false, sharedEdit: false },
          }
      }
      const allFolders = await listFolderMetas()
      const pubFolder = allFolders.find((m) => m.storageKey === rel && m.public)
      if (pubFolder) {
        const gate = publicGate(pubFolder, providedPassword)
        if (gate === 'password-required' || gate === 'password-wrong') {
          return reply.code(401).send({
            error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
            passwordRequired: true,
            kind: 'folder',
          })
        }
        if (gate === 'ok')
          return {
            kind: 'folder',
            owner: pubFolder.owner,
            public: true,
            access: { ownedByRequester: false, sharedReadOnly: false, sharedEdit: false },
          }
      }
    }
    return reply.code(404).send({ error: 'not found' })
  })

  app.get('/api/list', async (req, reply) => {
    const { path: rel = '', owner: ownerHint, p: providedPassword } =
      req.query as { path?: string; owner?: string; p?: string }
    const requester = req.currentUser?.username
    // Anonymous (or cross-owner) calls are allowed iff the folder is public
    // and the gate passes. We also accept the case where the requester is a
    // share-recipient with a grant on this folder (or any ancestor).
    let owner: string
    let anonymous = false
    // Partial-access mode: the recipient has no grant on `rel` itself
    // but holds grants on descendants. We return ONLY the immediate
    // children whose subtree the recipient has a grant for — so the
    // user lands on a "transit" folder with just their shared items
    // instead of a hard 403. Filled in below; consumed by the
    // visibility filter near the bottom of the handler.
    let partialAccess = false
    const accessibleSubpaths = new Set<string>()
    if (ownerHint && ownerHint !== requester) {
      const fm = await getFolderMeta(ownerHint, rel)
      const gate = publicGate(fm, providedPassword)
      if (gate === 'ok') {
        owner = ownerHint
        // Treat every cross-owner public-folder access as "anonymous"
        // for *filtering* purposes — the caller only holds the public
        // grant, so they must not see individually-private children
        // even if they happen to be logged in. (Was `!requester`,
        // which let an authed user bypass the per-item public
        // filter.)
        anonymous = true
      } else if (requester && (await findShareForPath(requester, ownerHint, rel))) {
        owner = ownerHint
      } else if (requester) {
        // No direct grant on this path — check descendants. If the
        // recipient has grants under `rel`, render a transit folder
        // listing just those children.
        const { listSharesTo } = await import('../stores/userShares.js')
        const allShares = await listSharesTo(requester)
        const prefix = rel ? rel.replace(/\/+$/, '') + '/' : ''
        for (const s of allShares) {
          if (s.owner !== ownerHint) continue
          if (rel === '' || s.storageKey.startsWith(prefix)) {
            // The visible item is the immediate child segment under `rel`.
            const tail = rel ? s.storageKey.slice(prefix.length) : s.storageKey
            const firstSeg = tail.split('/')[0]
            if (!firstSeg) continue
            accessibleSubpaths.add(rel ? `${prefix}${firstSeg}` : firstSeg)
          }
        }
        if (accessibleSubpaths.size > 0) {
          owner = ownerHint
          partialAccess = true
        } else {
          if (gate === 'password-required' || gate === 'password-wrong') {
            return reply
              .code(401)
              .send({
                error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
                passwordRequired: true,
              })
          }
          return reply.code(403).send({ error: 'forbidden' })
        }
      } else {
        if (gate === 'password-required' || gate === 'password-wrong') {
          return reply
            .code(401)
            .send({
              error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
              passwordRequired: true,
            })
        }
        return reply.code(403).send({ error: 'forbidden' })
      }
    } else if (!requester) {
      // Anonymous without an owner hint — same UX files get: scan for any
      // public folder with this path, gate-check, use that owner.
      const all = await listFolderMetas()
      const candidates = all.filter((m) => m.storageKey === rel && m.public)
      let pick: typeof candidates[number] | null = null
      let lastGate: ReturnType<typeof publicGate> = 'not-public'
      for (const c of candidates) {
        const g = publicGate(c, providedPassword)
        lastGate = g
        if (g === 'ok') {
          pick = c
          break
        }
      }
      if (!pick) {
        if (lastGate === 'password-required' || lastGate === 'password-wrong') {
          return reply
            .code(401)
            .send({
              error: lastGate === 'password-wrong' ? 'incorrect password' : 'password required',
              passwordRequired: true,
            })
        }
        return reply.code(401).send({ error: 'auth required' })
      }
      owner = pick.owner
      anonymous = true
    } else {
      if (!requireAuth(req, reply)) return
      owner = req.currentUser!.username
    }
    if (!anonymous) await ensureUserVault(owner).catch(() => null)
    const dir = resolveVault(rel, owner)

    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { path: rel, items: [] }
      throw e
    }

    // Build a map of vault-rel path → indexed-doc meta (scoped to files this
    // user owns) so we can decorate the tree with index status. When two
    // doc records happen to share the same (owner, storageKey) — which can
    // happen if a "Make public" click races with an auto-ingest that hadn't
    // saved its seed yet, leaving two `nanoid()`s for the same file — merge
    // them: keep `public`/expiry/password from whichever record set them,
    // and the readiest ingest record for everything else.
    const docs = await listAllDocuments()
    const indexedByPath = new Map<string, DocumentMeta>()
    for (const d of docs) {
      if (d.owner !== owner) continue
      if (!d.storageKey) continue
      const existing = indexedByPath.get(d.storageKey)
      if (!existing) {
        indexedByPath.set(d.storageKey, d)
        continue
      }
      const existingTags = existing.tags ?? []
      const dTags = d.tags ?? []
      const existingEmbedded = existing.ingest?.embedded ?? false
      const dEmbedded = d.ingest?.embedded ?? false
      const merged: DocumentMeta = {
        ...existing,
        public: existing.public || d.public,
        publicExpiresAt: existing.publicExpiresAt ?? d.publicExpiresAt,
        publicPasswordHash: existing.publicPasswordHash ?? d.publicPasswordHash,
        tags: existingTags.length ? existingTags : dTags,
      }
      // Prefer whichever record actually has the ingest done. Critical
      // for the sidebar sparkle on shared content — without this the
      // newest (often a stub) wins and the embedded flag silently
      // drops to false on the listing response.
      if (dEmbedded && !existingEmbedded) {
        merged.id = d.id
        merged.ingest = d.ingest
        merged.sha256 = d.sha256 || existing.sha256
      } else if (existingEmbedded) {
        merged.ingest = existing.ingest
      } else if (d.ingest && !existing.ingest) {
        merged.ingest = d.ingest
      }
      indexedByPath.set(d.storageKey, merged)
    }

    // Per-folder visibility comes from the FolderMeta store (folders aren't
    // documents, so they have their own little JSON-per-folder backend).
    const folderMetas = await listFolderMetas(owner)
    const folderByPath = new Map(folderMetas.map((m) => [m.storageKey, m]))

    const items: TreeNode[] = []
    for (const e of entries) {
      if (shouldSkipName(e.name)) continue
      const abs = path.join(dir, e.name)
      const childRel = toVaultRel(abs, owner)
      if (e.isDirectory()) {
        const fm = folderByPath.get(childRel)
        items.push({
          name: e.name,
          path: childRel,
          type: 'dir',
          hasChildren: true,
          public: fm?.public ?? false,
          publicExpiresAt: fm?.publicExpiresAt ?? null,
          tags: fm?.tags ?? [],
        })
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        // No extension filter — see expandTreeUnder for the rationale.
        // Ingest still skips formats it can't extract, but the file
        // remains visible in the grid.
        const indexed = indexedByPath.get(childRel)
        let size: number | undefined, mtime: number | undefined
        try {
          const s = await stat(abs)
          size = s.size
          mtime = s.mtimeMs
        } catch { /* skip */ }
        items.push({
          name: e.name,
          path: childRel,
          type: 'file',
          ext,
          size,
          mtime,
          docId: indexed?.id,
          ingestStatus: indexed?.ingest?.status,
          embedded: indexed?.ingest?.embedded ?? false,
          public: indexed?.public ?? false,
          publicExpiresAt: indexed?.publicExpiresAt ?? null,
          tags: indexed?.tags ?? [],
        })
      }
    }
    // Filter rules:
    //   - anonymous (public-folder browse): show only items with
    //     public=true (revoked-after-cascade children stay hidden).
    //   - partial-access (recipient transiting through a parent they
    //     have no grant on): show only the immediate children whose
    //     subtree they actually have a grant for.
    //   - otherwise: show everything.
    const visibleItems = anonymous
      ? items.filter((it) => it.public)
      : partialAccess
      ? items.filter((it) => accessibleSubpaths.has(it.path))
      : items
    visibleItems.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { path: rel, items: visibleItems, partialAccess: partialAccess || undefined }
  })

  // ---- read -----------------------------------------------------------------

  app.get('/api/file/text', async (req, reply) => {
    const { path: rel, p: publicPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })

    const requester = req.currentUser?.username
    const ctx = await resolveReadContext({ rel, ownerHint, requester })
    if (ownerHint && ownerHint !== requester && !ctx.sharedGrant) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const meta = ctx.meta
    const owner = ctx.owner
    if (!owner) return reply.code(401).send({ error: 'auth required' })

    const gate = publicGate(meta, publicPassword)
    if (gate === 'password-required' || gate === 'password-wrong') {
      return reply.code(401).send({ error: gate === 'password-wrong' ? 'incorrect password' : 'password required', passwordRequired: true })
    }
    if (gate !== 'ok') {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !ctx.sharedGrant && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }
    const abs = resolveVault(rel, owner)

    // If the on-disk file is gone (deleted out of band) but a doc record
    // lingers, drop the stale record so the next list call hides it. Returns
    // 404 either way.
    const onDisk = await stat(abs).catch(() => null)
    if (!onDisk || !onDisk.isFile()) {
      if (meta) {
        await deleteDocument(meta.id).catch(() => null)
        invalidateSearchCache()
      }
      return reply.code(404).send({ error: 'file not found' })
    }

    const ext = path.extname(abs).toLowerCase()
    // Native text types — read from disk directly so md/txt edits show without re-ingest.
    if (['.md', '.markdown', '.mdx', '.txt', '.csv', '.json', '.html', '.htm', '.yaml', '.yml', '.toml'].includes(ext)) {
      const buffer = await readFile(abs)
      const text = buffer.toString('utf8')
      const s = onDisk
      // First-read auto-ingest: if this vault file has never been embedded, kick
      // off a background ingest so it shows up in semantic search next time.
      if ((!meta || !meta.ingest.embedded) && req.currentUser) {
        const u = req.currentUser
        ;(async () => {
          try {
            const docsNow = await listAllDocuments()
            const existing = docsNow.find((d) => d.storageKey === rel)
            const id = existing?.id ?? nanoid()
            const filename = path.basename(abs)
            const seed: DocumentMeta = {
              id,
              title: existing?.title ?? filename.replace(/\.[^.]+$/, ''),
              originalFilename: filename,
              mime: inferMime(filename),
              bytes: buffer.length,
              sha256: sha256Of(buffer),
              storageKey: rel,
              owner: existing?.owner ?? u.username,
              acl: existing?.acl ?? { readers: [], editors: [] },
              public: existing?.public,
              publicExpiresAt: existing?.publicExpiresAt ?? null,
              publicPasswordHash: existing?.publicPasswordHash ?? null,
              tags: existing?.tags ?? [],
              createdAt: existing?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
              ingest: { status: 'pending', embedded: false },
            }
            await saveMeta(seed)
            await ingestDocument(seed, buffer)
          } catch (e) {
            req.log?.warn({ err: e }, `auto-ingest failed for ${rel}`)
          }
        })()
      }
      return { path: rel, content: text, size: s.size, mtime: s.mtimeMs }
    }
    // Binary types — return extracted text from the index, if any.
    if (!meta) return reply.code(404).send({ error: 'not indexed; use /api/file/raw' })
    const text = (await readExtracted(meta.id)) ?? ''
    return { path: rel, content: text, size: onDisk.size, mtime: onDisk.mtimeMs, docId: meta.id }
  })

  app.get('/api/file/raw', async (req, reply) => {
    const { path: rel, p: publicPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })

    // Throttle failed `?p=` attempts before scrypt-verify burns CPU.
    if (publicPassword) {
      const locked = gateLockedSeconds(req.ip)
      if (locked != null) {
        return reply
          .code(429)
          .header('Retry-After', String(locked))
          .send({ error: 'too many failed password attempts', retryAfter: locked })
      }
    }

    const requester = req.currentUser?.username
    const ctx = await resolveReadContext({ rel, ownerHint, requester })
    if (ownerHint && ownerHint !== requester && !ctx.sharedGrant) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const meta = ctx.meta
    const owner = ctx.owner
    if (!owner) return reply.code(401).send({ error: 'auth required' })

    const gate = publicGate(meta, publicPassword)
    if (gate === 'password-required' || gate === 'password-wrong') {
      if (gate === 'password-wrong') recordGateFailure(req.ip)
      return reply.code(401).send({ error: gate === 'password-wrong' ? 'incorrect password' : 'password required', passwordRequired: true })
    }
    if (gate !== 'ok') {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !ctx.sharedGrant && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    } else if (publicPassword) {
      // Successful gate with password — reset the bucket.
      clearGateFailures(req.ip)
    }
    const abs = resolveVault(rel, owner)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })

    const mime = inferMime(abs)
    const disposition = `inline; filename="${path.basename(abs).replace(/"/g, '')}"`

    // Range support — needed for HTML5 <video>, which sends `Range: bytes=...`
    // to seek. Without 206 responses Safari refuses to play altogether.
    const range = (req.headers.range || '') as string
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      const total = s.size
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${total}`)
          .send({ error: 'range not satisfiable' })
      }
      return reply
        .code(206)
        .header('Content-Type', mime)
        .header('Content-Length', String(end - start + 1))
        .header('Content-Range', `bytes ${start}-${end}/${total}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Disposition', disposition)
        .send(createReadStream(abs, { start, end }))
    }

    return reply
      .header('Content-Type', mime)
      .header('Content-Length', String(s.size))
      .header('Accept-Ranges', 'bytes')
      .header('Content-Disposition', disposition)
      .send(createReadStream(abs))
  })

  // Display-friendly version of a file. For HEIC this returns the JPEG we
  // generated at ingest so browsers can render it; for everything else it
  // streams the raw bytes. Use /api/file/raw when you want the original
  // (e.g., download links).
  app.get('/api/file/preview', async (req, reply) => {
    const { path: rel, p: publicPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const requester = req.currentUser?.username
    const ctx = await resolveReadContext({ rel, ownerHint, requester })
    if (ownerHint && ownerHint !== requester && !ctx.sharedGrant) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const meta = ctx.meta
    const owner = ctx.owner
    if (!owner) return reply.code(401).send({ error: 'auth required' })

    const gate = publicGate(meta, publicPassword)
    if (gate === 'password-required' || gate === 'password-wrong') {
      return reply.code(401).send({ error: gate === 'password-wrong' ? 'incorrect password' : 'password required', passwordRequired: true })
    }
    if (gate !== 'ok') {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !ctx.sharedGrant && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }
    const abs = resolveVault(rel, owner)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })

    const { isImageNeedingTranscode, isVideo, transcodeImageToJpeg, videoFrameAt } =
      await import('../services/media.js')
    const needsServerPreview = isImageNeedingTranscode(abs) || isVideo(abs)

    if (needsServerPreview) {
      if (meta) {
        const cached = await readPreview(meta.id)
        if (cached) {
          return reply
            .header('Content-Type', 'image/jpeg')
            .header('Cache-Control', 'private, max-age=86400')
            .send(cached)
        }
      }
      // On-demand for files ingested before preview generation was wired.
      try {
        const buffer = await readFile(abs)
        const jpeg = isVideo(abs)
          ? await videoFrameAt(buffer, abs)
          : await transcodeImageToJpeg(buffer, abs)
        if (!jpeg) return reply.code(415).send({ error: 'preview decode failed' })
        if (meta) await writePreview(meta.id, jpeg).catch(() => null)
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'private, max-age=86400')
          .send(jpeg)
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message ?? 'preview failed' })
      }
    }

    // Browser-renderable: just stream the original bytes inline.
    return reply
      .header('Content-Type', inferMime(abs))
      .header('Content-Length', String(s.size))
      .header('Content-Disposition', `inline; filename="${path.basename(abs).replace(/"/g, '')}"`)
      .send(createReadStream(abs))
  })

  /*
   * HLS streaming for videos.
   *
   *   GET /api/file/hls/playlist.m3u8?path=&owner=&p=  → m3u8 playlist
   *   GET /api/file/hls/:segment?path=&owner=&p=       → .ts segment
   *
   * Both endpoints share the same path/owner/password auth as
   * /api/file/raw. The playlist is rewritten on the fly to append the
   * original query string to each segment URI so authenticated and
   * password-gated playback work uniformly — relative URI resolution
   * in browsers drops the parent's query string otherwise.
   *
   * We don't keep an in-memory cache of the rewritten playlist (it's
   * tiny, kilobytes at most), and segments are streamed straight off
   * disk with Range support so a single 10s scrub doesn't re-download
   * the whole bundle.
   */
  app.get<{ Params: { segment: string } }>('/api/file/hls/:segment', async (req, reply) => {
    const { path: rel, p: publicPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const segName = req.params.segment
    // Whitelist: playlist.m3u8 or seg_NNN.ts. Reject anything else so
    // a crafted name (`..`, absolute paths) can't escape the hls dir.
    if (
      segName !== 'playlist.m3u8' &&
      !/^seg_\d{3,5}\.ts$/.test(segName)
    ) {
      return reply.code(400).send({ error: 'bad segment name' })
    }

    if (publicPassword) {
      const locked = gateLockedSeconds(req.ip)
      if (locked != null) {
        return reply
          .code(429)
          .header('Retry-After', String(locked))
          .send({ error: 'too many failed password attempts', retryAfter: locked })
      }
    }

    const requester = req.currentUser?.username
    const ctx = await resolveReadContext({ rel, ownerHint, requester })
    if (ownerHint && ownerHint !== requester && !ctx.sharedGrant) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const meta = ctx.meta
    if (!meta) return reply.code(404).send({ error: 'not indexed' })

    const gate = publicGate(meta, publicPassword)
    if (gate === 'password-required' || gate === 'password-wrong') {
      if (gate === 'password-wrong') recordGateFailure(req.ip)
      return reply.code(401).send({
        error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
        passwordRequired: true,
      })
    }
    if (gate !== 'ok') {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (!ctx.sharedGrant && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    } else if (publicPassword) {
      clearGateFailures(req.ip)
    }

    const { hlsDir } = await import('../services/videoTranscode.js')
    const segPath = path.join(hlsDir(meta.id), segName)
    const segStat = await stat(segPath).catch(() => null)
    if (!segStat || !segStat.isFile()) {
      return reply.code(404).send({ error: 'hls not ready' })
    }

    if (segName === 'playlist.m3u8') {
      const text = await readFile(segPath, 'utf8')
      // Rebuild the query string so segments inherit owner/path/p.
      const qs = new URLSearchParams()
      qs.set('path', rel)
      if (ownerHint) qs.set('owner', ownerHint)
      if (publicPassword) qs.set('p', publicPassword)
      const query = `?${qs.toString()}`
      const rewritten = text.replace(
        /^(seg_\d{3,5}\.ts)$/gm,
        (_m, name) => `${name}${query}`,
      )
      return reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'private, no-store')
        .send(rewritten)
    }

    // Segment — stream with Range support for hls.js seeking.
    const range = (req.headers.range || '') as string
    const rm2 = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (rm2) {
      const total = segStat.size
      const start = rm2[1] ? Number(rm2[1]) : 0
      const end = rm2[2] ? Math.min(Number(rm2[2]), total - 1) : total - 1
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${total}`)
          .send({ error: 'range not satisfiable' })
      }
      return reply
        .code(206)
        .header('Content-Type', 'video/mp2t')
        .header('Content-Length', String(end - start + 1))
        .header('Content-Range', `bytes ${start}-${end}/${total}`)
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, max-age=3600')
        .send(createReadStream(segPath, { start, end }))
    }
    return reply
      .header('Content-Type', 'video/mp2t')
      .header('Content-Length', String(segStat.size))
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(segPath))
  })

  // Tiny PNG preview for the folder grid. Cached on disk per doc. If the
  // thumbnail hasn't been generated yet, we render-on-demand and persist.
  app.get('/api/file/thumbnail', async (req, reply) => {
    const { path: rel, p: publicPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })

    const requester = req.currentUser?.username
    const ctx = await resolveReadContext({ rel, ownerHint, requester })
    if (ownerHint && ownerHint !== requester && !ctx.sharedGrant) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const meta = ctx.meta
    const owner = ctx.owner
    if (!owner) return reply.code(401).send({ error: 'auth required' })

    const gate = publicGate(meta, publicPassword)
    if (gate === 'password-required' || gate === 'password-wrong') {
      return reply.code(401).send({ error: gate === 'password-wrong' ? 'incorrect password' : 'password required', passwordRequired: true })
    }
    if (gate !== 'ok') {
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      if (meta && !ctx.sharedGrant && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }
    const abs = resolveVault(rel, owner)

    if (meta) {
      const cached = await readThumbnail(meta.id)
      if (cached) {
        return reply
          .header('Content-Type', 'image/png')
          .header('Cache-Control', 'private, max-age=86400')
          .send(cached)
      }
    }
    // Generate on demand (covers files indexed before thumbnails were added).
    try {
      const buffer = await readFile(abs)
      const png = await generateThumbnail(buffer, path.basename(abs))
      if (!png) return reply.code(404).send({ error: 'no thumbnail for this type' })
      if (meta) await writeThumbnail(meta.id, png).catch(() => null)
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'private, max-age=86400')
        .send(png)
    } catch (e: any) {
      return reply.code(404).send({ error: e?.message ?? 'thumbnail failed' })
    }
  })

  // ---- write ---------------------------------------------------------------

  app.post('/api/file/upload', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'viewers cannot upload' })

    const part = await req.file({
      limits: { fileSize: config.ingest.maxFileBytes, files: 1 },
    })
    if (!part) return reply.code(400).send({ error: 'no file uploaded' })

    let buffer: Buffer
    try {
      buffer = await part.toBuffer()
    } catch (e: any) {
      // multipart's fileSize limit fires here (mid-read) rather than
      // on req.file(). Translate to a clean 413 so the client sees
      // "too large" instead of a generic 500.
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.code === 'FST_FILES_LIMIT') {
        const mb = Math.round(config.ingest.maxFileBytes / (1024 * 1024))
        return reply.code(413).send({
          error: `file too large — max ${mb} MB`,
          maxBytes: config.ingest.maxFileBytes,
        })
      }
      throw e
    }
    if (buffer.length === 0) return reply.code(400).send({ error: 'empty file' })

    // Magic-byte validation. The browser's claimed MIME is spoofable
    // (a malicious upload can say `image/png` while shipping HTML/JS).
    // We sniff the actual bytes and reject when the sniffed type
    // disagrees with the file extension — keeps `.png` from harboring
    // a script payload.
    const claimedMime = part.mimetype || undefined
    const guard = await validateUpload(buffer, part.filename || 'upload.bin', claimedMime)
    if (!guard.ok) {
      return reply.code(415).send({ error: `unsupported file: ${guard.reason}` })
    }

    // Quota check. Sums bytes across docs the user owns; rejects if this
    // upload would push them over their configured cap. Admins are exempt
    // because they're the one setting the limits.
    // Quota enforcement with reservation — two concurrent uploads of
    // 60MB against a 100MB cap used to both pass since neither saw
    // the other's bytes on disk yet. Reserving and releasing around
    // the write closes that TOCTOU window.
    let reserved = 0
    if (user.role !== 'admin' && user.quotaBytes && user.quotaBytes > 0) {
      const docs = await listAllDocuments()
      const used = docs.reduce(
        (sum, d) => (d.owner === user.username ? sum + (d.bytes || 0) : sum),
        0,
      )
      const inflight = getReservedUploadBytes(user.username)
      if (used + inflight + buffer.length > user.quotaBytes) {
        return reply.code(413).send({
          error: 'quota exceeded',
          quota: user.quotaBytes,
          used,
          inflight,
          incoming: buffer.length,
        })
      }
      reserveUploadBytes(user.username, buffer.length)
      reserved = buffer.length
    }

    try {
      const fields = part.fields as Record<string, { value: string } | undefined>
      const targetRel = ((fields?.path as any)?.value as string | undefined) || ''
      const tagsCSV = ((fields?.tags as any)?.value as string | undefined) || ''
      const titleField = ((fields?.title as any)?.value as string | undefined) || ''

      await ensureUserVault(user.username).catch(() => null)
      const targetDir = resolveVault(targetRel, user.username)
      await mkdir(targetDir, { recursive: true })

      const filename = safeFilename(part.filename || 'upload.bin')
      const finalAbs = await uniquePath(targetDir, filename)
      const finalRel = toVaultRel(finalAbs, user.username)
      await import('node:fs/promises').then(({ writeFile }) => writeFile(finalAbs, buffer))

      const mime = inferMime(filename, part.mimetype || undefined)
      const sha256 = sha256Of(buffer)
      const now = Date.now()
      // Folder cascade for new children: if the closest published
      // ancestor folder is public, the new file inherits its
      // public-link state (expiry, password). Without this an owner
      // who dropped a file into "Public" gets surprised when the
      // recipient sees nothing.
      const inheritedPublic = await closestPublicAncestor(user.username, finalRel)
      const meta: DocumentMeta = {
        id: nanoid(),
        title: titleField.trim() || filename.replace(/\.[^.]+$/, ''),
        originalFilename: filename,
        mime,
        bytes: buffer.length,
        sha256,
        storageKey: finalRel,
        owner: user.username,
        acl: { readers: [], editors: [] },
        public: inheritedPublic?.public ?? undefined,
        publicExpiresAt: inheritedPublic?.publicExpiresAt ?? null,
        publicPasswordHash: inheritedPublic?.publicPasswordHash ?? null,
        tags: tagsCSV.split(',').map((s) => s.trim()).filter(Boolean),
        createdAt: now,
        updatedAt: now,
        ingest: { status: 'pending', embedded: false },
      }
      await saveMeta(meta)
      // Live Photo pair detection — when this upload's stem matches
      // a sibling in the same dir of the opposite kind (still vs
      // motion), tag both metas so the timeline can play the motion
      // half on hover. Best-effort; failures don't block the upload.
      await detectAndLinkLivePhotoPair(meta).catch((err) => {
        req.log.warn({ err }, 'live-photo pair check failed')
      })
      const { runJob } = await import('../services/jobs.js')
      runJob('ingest', finalRel, () => ingestDocument(meta, buffer)).catch((err) => {
        req.log.warn({ err, rel: finalRel }, 'ingest job failed')
      })

      await audit({
        actor: user.username,
        action: 'vault.upload',
        target: finalRel,
        meta: { bytes: buffer.length, mime },
      })
      dispatchWebhook({
        type: 'upload',
        path: finalRel,
        actor: user.username,
        bytes: buffer.length,
      }).catch(() => null)
      return reply.code(201).send({ document: meta, path: finalRel })
    } finally {
      if (reserved) releaseUploadBytes(user.username, reserved)
    }
  })

  app.post('/api/file/index', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { path: rel } = req.body as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel, user.username)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })

    const buffer = await readFile(abs)
    const sha256 = sha256Of(buffer)
    const now = Date.now()

    // Replace any existing index for this path scoped to this user's owned files.
    // Reuse the existing id so the doc directory is overwritten in
    // place rather than delete-then-create — that ordering left the
    // file permanently unindexed if the process died between the two
    // ops.
    const docs = await listAllDocuments()
    const existing = docs.find((d) => d.storageKey === rel && d.owner === user.username)
    const id = existing?.id ?? nanoid()

    const filename = path.basename(abs)
    const meta: DocumentMeta = {
      id,
      title: existing?.title ?? filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      mime: inferMime(filename),
      bytes: s.size,
      sha256,
      storageKey: rel,
      owner: existing?.owner ?? user.username,
      acl: existing?.acl ?? { readers: [], editors: [] },
      // Preserve user-set visibility state across re-index — otherwise
      // hitting "Index" on a public file silently flips it back to private.
      public: existing?.public,
      publicExpiresAt: existing?.publicExpiresAt ?? null,
      publicPasswordHash: existing?.publicPasswordHash ?? null,
      tags: existing?.tags ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ingest: { status: 'pending', embedded: false },
    }
    await saveMeta(meta)
    const finalMeta = await ingestDocument(meta, buffer)
    await audit({ actor: user.username, action: 'vault.index', target: rel })
    return { document: redactPublicMeta(finalMeta) }
  })

  app.delete('/api/file', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const abs = resolveVault(rel, user.username)

    // ACL: if an index exists, only owner / admin / listed editor can delete.
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel && d.owner === user.username)
    if (meta && !userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    void userCanRead

    // Soft-delete: move the vault file + index meta into trash. Sweeper purges
    // after 30 days; user can restore from Settings → Trash.
    const s = await stat(abs).catch(() => null)
    if (s?.isFile()) {
      await moveToTrash({
        storageKey: rel,
        vaultAbs: abs,
        docId: meta?.id,
        owner: user.username,
        bytes: s.size,
        trashedBy: user.username,
      }).catch((err) => {
        req.log.warn({ err, rel }, 'trash move failed; hard-deleting')
        return rm(abs, { force: true }).catch(() => null)
      })
    }
    invalidateSearchCache()
    publish({ type: 'trash', path: rel })
    dispatchWebhook({ type: 'delete', path: rel, actor: user.username }).catch(() => null)
    await audit({ actor: user.username, action: 'vault.trash', target: rel })
    return { ok: true }
  })

  // ─── trash ─────────────────────────────────────────────────────────────

  app.get('/api/trash', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { listTrash } = await import('../stores/trash.js')
    const all = await listTrash()
    // Non-admins only see their own trash. Older entries (pre-owner-field)
    // were owned by whoever trashed them — surface those to that user.
    const entries =
      user.role === 'admin'
        ? all
        : all.filter((e) => e.owner === user.username || (!e.owner && e.trashedBy === user.username))
    return { entries }
  })

  app.post('/api/trash/:id/restore', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { id } = req.params as { id: string }
    const { listTrash, purgeTrash } = await import('../stores/trash.js')
    const all = await listTrash()
    const entry = all.find((e) => e.id === id)
    if (!entry) return reply.code(404).send({ error: 'not found in trash' })
    // Restore vault file under the original owner's namespace.
    if (entry.owner !== user.username && user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    // POSIX rename clobbers — if a new file was created at the
    // original path after deletion, restoring would silently destroy
    // it (and the clobbered file has no trash entry, so it's gone
    // forever). Refuse if the target already exists; require the
    // caller to clear it first or restore via a renamed path.
    const targetAbs = resolveVault(entry.storageKey, entry.owner)
    const existing = await stat(targetAbs).catch(() => null)
    if (existing) {
      return reply.code(409).send({
        error: 'destination path is in use; remove or rename it before restoring',
      })
    }
    await mkdir(path.dirname(targetAbs), { recursive: true })
    const blobName = entry.filename.replace(/\.\./g, '_').replace(/[\/\\]/g, '_')
    const src = path.join(config.paths.trash, entry.id, blobName)
    try {
      // Cross-device safe: /data/trash and /vault are typically two
      // separate bind mounts in compose deployments, so plain rename
      // would throw EXDEV here.
      await moveAcrossDevices(src, targetAbs)
    } catch (e: any) {
      return reply.code(500).send({ error: `restore failed: ${e?.message ?? e}` })
    }
    // Restore doc meta dir if present. Same collision guard so a
    // concurrent re-index that allocated the same id doesn't get
    // overwritten and the meta dir doesn't vanish silently.
    if (entry.docId) {
      const docSrc = path.join(config.paths.trash, entry.id, '_doc')
      const docDest = path.join(config.paths.documents, entry.docId)
      const sSrc = await stat(docSrc).catch(() => null)
      const sDest = await stat(docDest).catch(() => null)
      if (sSrc?.isDirectory() && !sDest) {
        await moveAcrossDevices(docSrc, docDest).catch(() => null)
      }
    }
    await purgeTrash(entry.id)
    invalidateSearchCache()
    publish({ type: 'restore', path: entry.storageKey })
    await audit({ actor: user.username, action: 'trash.restore', target: entry.storageKey })
    return { ok: true }
  })

  app.delete('/api/trash/:id', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { id } = req.params as { id: string }
    const { purgeTrash } = await import('../stores/trash.js')
    await purgeTrash(id)
    await audit({ actor: user.username, action: 'trash.purge', target: id })
    return { ok: true }
  })

  // Bulk operations: visibility + delete. Per-file ACL still applies inside.
  app.post('/api/file/bulk-visibility', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as {
      paths?: string[]
      public?: boolean
      expiresInSeconds?: number | null
      password?: string | null
    }
    if (!Array.isArray(body?.paths) || typeof body.public !== 'boolean') {
      return reply.code(400).send({ error: 'paths[] and public required' })
    }
    // Pre-compute the share-config once per request so all selected files
    // land with identical expiry + password (single hash) — much faster than
    // hashing per-file and matches what the single-file endpoint does.
    const expiresAt =
      !body.public || body.expiresInSeconds === null || body.expiresInSeconds === undefined
        ? null
        : Date.now() + Math.max(60, Math.floor(body.expiresInSeconds)) * 1000
    const passwordHash =
      !body.public || !body.password ? null : hashShareSecret(body.password)
    // Expand each input path. Files map to themselves; folders fan out
    // into every supported file beneath them AND every sub-folder so we
    // can update the per-folder meta too (otherwise the folder tile
    // never picks up the public state). The same expiry/password gets
    // applied across the whole subtree.
    const docs = await listAllDocuments()
    const seenFiles = new Set<string>()
    const seenFolders = new Set<string>()
    const fileRels: string[] = []
    const folderRels: string[] = []
    for (const inputRel of body.paths) {
      try {
        const abs = resolveVault(inputRel, user.username)
        const s = await stat(abs).catch(() => null)
        if (s?.isFile()) {
          if (!seenFiles.has(inputRel)) {
            seenFiles.add(inputRel)
            fileRels.push(inputRel)
          }
          continue
        }
        if (!s?.isDirectory()) continue
        if (!seenFolders.has(inputRel)) {
          seenFolders.add(inputRel)
          folderRels.push(inputRel)
        }
        const tree = await expandTreeUnder(user.username, inputRel)
        for (const r of tree.files) {
          if (!seenFiles.has(r)) {
            seenFiles.add(r)
            fileRels.push(r)
          }
        }
        for (const r of tree.folders) {
          if (!seenFolders.has(r)) {
            seenFolders.add(r)
            folderRels.push(r)
          }
        }
      } catch {
        /* skip unresolved input */
      }
    }
    let ok = 0
    let failed = 0
    for (const rel of fileRels) {
      try {
        const abs = resolveVault(rel, user.username)
        const s = await stat(abs).catch(() => null)
        if (!s?.isFile()) {
          failed++
          continue
        }
        let meta = docs.find((d) => d.storageKey === rel && d.owner === user.username)
        if (!meta) {
          // Create stub meta so the public flag has somewhere to live.
          const filename = path.basename(abs)
          meta = {
            id: nanoid(),
            title: filename.replace(/\.[^.]+$/, ''),
            originalFilename: filename,
            mime: inferMime(filename),
            bytes: s.size,
            sha256: '',
            storageKey: rel,
            owner: user.username,
            acl: { readers: [], editors: [] },
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ingest: { status: 'pending', embedded: false },
          }
        } else if (!userCanEdit(meta, user.username, user.role)) {
          failed++
          continue
        }
        const next: DocumentMeta = {
          ...meta,
          public: body.public,
          publicExpiresAt: body.public ? expiresAt : null,
          publicPasswordHash: body.public ? passwordHash : null,
          updatedAt: Date.now(),
        }
        await saveMeta(next)
        ok++
      } catch {
        failed++
      }
    }
    // Folder metas — both the selected folders and every sub-folder
    // discovered while walking. Without this the folder tile keeps
    // reading as private even though its contents are public.
    const now = Date.now()
    for (const folderRel of folderRels) {
      try {
        const existing = await getFolderMeta(user.username, folderRel)
        await saveFolderMeta({
          ...(existing ?? freshFolderMeta(user.username, folderRel)),
          owner: user.username,
          storageKey: folderRel,
          public: body.public,
          publicExpiresAt: body.public ? expiresAt : null,
          publicPasswordHash: body.public ? passwordHash : null,
          updatedAt: now,
        })
      } catch {
        /* skip; file cascade already succeeded */
      }
    }
    invalidateSearchCache()
    await audit({
      actor: user.username,
      action: 'vault.bulk-visibility',
      meta: {
        inputs: body.paths.length,
        files: fileRels.length,
        folders: folderRels.length,
        public: body.public,
        hasPassword: !!passwordHash,
        expiresAt,
        ok,
        failed,
      },
    })
    return { ok, failed, folders: folderRels.length }
  })

  app.post('/api/file/bulk-delete', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as { paths?: string[] }
    if (!Array.isArray(body?.paths)) {
      return reply.code(400).send({ error: 'paths[] required' })
    }
    // Per-path failure reasons. Returned to the client AND logged
    // server-side so a `{ok:0,failed:N}` response isn't a black box.
    // `path` is the input as the client sent it (so the UI can match
    // it back to a row); `reason` is a short human-readable cause.
    const errors: Array<{ path: string; reason: string }> = []
    const recordError = (p: string, reason: string, err?: unknown) => {
      errors.push({ path: p, reason })
      req.log.warn({ err, path: p, reason }, 'bulk-delete: per-file failure')
    }

    // Expand folder paths into their files. Each file is sent to trash one
    // at a time; the empty directory shell is removed afterwards.
    const docs = await listAllDocuments()
    const seen = new Set<string>()
    const fileRels: string[] = []
    // Map every expanded file back to the original input path the
    // caller asked about, so per-file failures get reported against
    // something the client recognizes (and not, e.g., a deeply nested
    // file inside a folder the user dropped on the page).
    const fileOrigin = new Map<string, string>()
    const folderRels: string[] = []
    for (const inputRel of body.paths) {
      let abs: string
      try {
        abs = resolveVault(inputRel, user.username)
      } catch (e) {
        recordError(inputRel, 'invalid path', e)
        continue
      }
      const st = await stat(abs).catch(() => null)
      if (!st) {
        recordError(inputRel, 'not found')
        continue
      }
      if (st.isDirectory()) folderRels.push(inputRel)
      try {
        const expanded = await expandFilesUnder(user.username, inputRel)
        for (const r of expanded) {
          if (!seen.has(r)) {
            seen.add(r)
            fileRels.push(r)
            fileOrigin.set(r, inputRel)
          }
        }
      } catch (e) {
        recordError(inputRel, 'failed to list folder contents', e)
      }
    }
    let ok = 0
    let failed = 0
    for (const rel of fileRels) {
      const reportAs = fileOrigin.get(rel) ?? rel
      let abs: string
      try {
        abs = resolveVault(rel, user.username)
      } catch (e) {
        failed++
        recordError(reportAs, 'invalid path', e)
        continue
      }
      const meta = docs.find((d) => d.storageKey === rel && d.owner === user.username)
      if (meta && !userCanEdit(meta, user.username, user.role)) {
        failed++
        recordError(reportAs, 'permission denied')
        continue
      }
      const s = await stat(abs).catch(() => null)
      if (!s) {
        failed++
        recordError(reportAs, 'not found')
        continue
      }
      if (!s.isFile()) {
        // Reached here only via the folder-expansion path; treat as
        // a non-fatal skip rather than a failure (the folder itself
        // is handled in the sweep below).
        continue
      }
      try {
        await moveToTrash({
          storageKey: rel,
          vaultAbs: abs,
          docId: meta?.id,
          owner: user.username,
          bytes: s.size,
          trashedBy: user.username,
        })
        ok++
      } catch (e) {
        failed++
        recordError(reportAs, `trash failed: ${(e as Error).message ?? 'unknown'}`, e)
      }
    }
    // Now sweep the now-empty folder shells. Sort by depth descending so
    // children get removed before parents.
    folderRels.sort((a, b) => b.split('/').length - a.split('/').length)
    for (const rel of folderRels) {
      try {
        await rm(resolveVault(rel, user.username), { recursive: true, force: true })
      } catch (e) {
        // Folder failures don't bump `failed` (the per-file counter)
        // but they DO show up in `errors[]` so the user sees why a
        // folder they expected to vanish is still there.
        recordError(rel, `folder removal failed: ${(e as Error).message ?? 'unknown'}`, e)
      }
    }
    invalidateSearchCache()
    await audit({
      actor: user.username,
      action: 'vault.bulk-trash',
      meta: {
        inputs: body.paths.length,
        files: fileRels.length,
        folders: folderRels.length,
        ok,
        failed,
        errorCount: errors.length,
      },
    })
    return { ok, failed, errors }
  })

  /**
   * Bulk add (and/or remove) tags on a set of vault paths. Works on
   * files AND folders uniformly — folders are tagged via folder
   * metas, files via document metas. Set-union add / set-diff
   * remove, so callers don't need to fetch the existing tags first.
   *
   * Body: { paths: string[], add?: string[], remove?: string[] }
   * Returns: { ok: count, errors: Array<{ path, reason }> }
   */
  app.post('/api/file/bulk-tags', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as {
      paths?: string[]
      add?: string[]
      remove?: string[]
    }
    if (!Array.isArray(body?.paths) || body.paths.length === 0) {
      return reply.code(400).send({ error: 'paths[] required' })
    }
    const sanitize = (xs: unknown): string[] =>
      Array.isArray(xs)
        ? Array.from(
            new Set(
              xs
                .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
                .filter((t) => t.length > 0 && t.length <= 40),
            ),
          )
        : []
    const addList = sanitize(body.add)
    const removeList = sanitize(body.remove)
    if (addList.length === 0 && removeList.length === 0) {
      return reply.code(400).send({ error: 'add[] or remove[] required' })
    }

    const docs = await listAllDocuments()
    let ok = 0
    const errors: Array<{ path: string; reason: string }> = []

    for (const rel of body.paths) {
      let abs: string
      try {
        abs = resolveVault(rel, user.username)
      } catch (e) {
        errors.push({ path: rel, reason: 'invalid path' })
        req.log.warn({ err: e, path: rel }, 'bulk-tags: invalid path')
        continue
      }
      const st = await stat(abs).catch(() => null)
      if (!st) {
        errors.push({ path: rel, reason: 'not found' })
        continue
      }
      try {
        if (st.isDirectory()) {
          const existing = await getFolderMeta(user.username, rel)
          const cur = new Set(existing?.tags ?? [])
          for (const t of addList) cur.add(t)
          for (const t of removeList) cur.delete(t)
          const next = {
            ...(existing ?? freshFolderMeta(user.username, rel)),
            tags: Array.from(cur).sort(),
            updatedAt: Date.now(),
          }
          await saveFolderMeta(next)
        } else if (st.isFile()) {
          let meta = docs.find(
            (d) => d.storageKey === rel && d.owner === user.username,
          )
          if (!meta) {
            // No doc index yet (raw file on disk). Synthesize a
            // minimal meta the same way the single-file /api/file/tags
            // endpoint does — but keep it simple here: just store
            // the tags via a fresh meta so the next ingest sees them.
            const filename = path.basename(abs)
            meta = {
              id: nanoid(),
              title: filename.replace(/\.[^.]+$/, ''),
              originalFilename: filename,
              mime: inferMime(abs),
              bytes: st.size,
              sha256: '',
              storageKey: rel,
              owner: user.username,
              acl: { readers: [], editors: [] },
              tags: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              ingest: { status: 'pending', embedded: false },
            }
          }
          const cur = new Set(meta.tags)
          for (const t of addList) cur.add(t)
          for (const t of removeList) cur.delete(t)
          await saveMeta({
            ...meta,
            tags: Array.from(cur).sort(),
            updatedAt: Date.now(),
          })
        } else {
          errors.push({ path: rel, reason: 'not a file or folder' })
          continue
        }
        ok++
      } catch (e) {
        errors.push({ path: rel, reason: (e as Error).message ?? 'failed' })
        req.log.warn({ err: e, path: rel }, 'bulk-tags: per-path failure')
      }
    }

    invalidateSearchCache()
    // Publish one tags event per affected path so the sidebar's
    // tag-count badges + the /tags/<t> live view refresh. Without
    // this, the sidebar shows stale counts after a bulk-tag until
    // the next page refresh.
    // Tags event signals "this path's tags changed"; receivers
    // re-fetch instead of relying on the diff payload. Empty array
    // is fine — bulk add/remove doesn't yield a clean per-path
    // final-tags set without an extra read.
    for (const rel of body.paths) {
      publish({ type: 'tags', path: rel, tags: [] })
    }
    await audit({
      actor: user.username,
      action: 'vault.bulk-tags',
      meta: { paths: body.paths.length, add: addList, remove: removeList, ok, errorCount: errors.length },
    })
    return { ok, errors }
  })

  app.post('/api/folder', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { path: rel } = req.body as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    await ensureUserVault(user.username).catch(() => null)
    const abs = resolveVault(rel, user.username)
    await mkdir(abs, { recursive: true })
    // Inherit public state from the closest published ancestor so a
    // sub-folder created inside a publicly-shared folder is itself
    // public (cascade re-apply for late-created children).
    const inherited = await closestPublicAncestor(user.username, rel)
    if (inherited) {
      const now = Date.now()
      await saveFolderMeta({
        ...freshFolderMeta(user.username, rel),
        public: true,
        publicExpiresAt: inherited.publicExpiresAt,
        publicPasswordHash: inherited.publicPasswordHash,
        updatedAt: now,
      })
    }
    await audit({ actor: user.username, action: 'vault.mkdir', target: rel })
    return { ok: true, path: rel }
  })

  app.post('/api/file/move', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const { from, to } = req.body as { from?: string; to?: string }
    if (!from || !to) return reply.code(400).send({ error: 'missing from/to' })
    if (from === to) return reply.code(400).send({ error: 'from and to are identical' })
    const absFrom = resolveVault(from, user.username)
    const absTo = resolveVault(to, user.username)
    const srcStat = await stat(absFrom).catch(() => null)
    if (!srcStat) return reply.code(404).send({ error: 'source not found' })
    // POSIX rename silently clobbers the destination. Guard explicitly
    // so a move never destroys an existing file/folder at `to`.
    const dstStat = await stat(absTo).catch(() => null)
    if (dstStat) return reply.code(409).send({ error: 'destination already exists' })
    await mkdir(path.dirname(absTo), { recursive: true })
    await rename(absFrom, absTo)

    const docs = await listAllDocuments()
    if (srcStat.isFile()) {
      const meta = docs.find(
        (d) => d.storageKey === from && d.owner === user.username,
      )
      if (meta) await saveMeta({ ...meta, storageKey: to, updatedAt: Date.now() })
    } else if (srcStat.isDirectory()) {
      // Folder move: rewrite the storageKey on every descendant doc
      // and folder-meta so public/tag state survives the move and the
      // index doesn't point at the old path.
      const fromPrefix = from.replace(/\/+$/, '') + '/'
      const toPrefix = to.replace(/\/+$/, '') + '/'
      for (const d of docs) {
        if (d.owner !== user.username) continue
        if (d.storageKey !== from && !d.storageKey.startsWith(fromPrefix)) continue
        const next =
          d.storageKey === from ? to : toPrefix + d.storageKey.slice(fromPrefix.length)
        await saveMeta({ ...d, storageKey: next, updatedAt: Date.now() })
      }
      const { deleteFolderMeta } = await import('../stores/folderMetas.js')
      const folderMetas = await listFolderMetas(user.username)
      for (const fm of folderMetas) {
        if (fm.storageKey !== from && !fm.storageKey.startsWith(fromPrefix)) continue
        const nextKey =
          fm.storageKey === from ? to : toPrefix + fm.storageKey.slice(fromPrefix.length)
        await saveFolderMeta({ ...fm, storageKey: nextKey, updatedAt: Date.now() })
        if (nextKey !== fm.storageKey) {
          await deleteFolderMeta(user.username, fm.storageKey).catch(() => null)
        }
      }
    }
    invalidateSearchCache()
    await audit({ actor: user.username, action: 'vault.move', target: from, meta: { to } })
    return { ok: true }
  })


  // Resolve a raw path → docId. Public-aware: anonymous callers can fetch
  // metadata for a file that has `public: true`. For vault files without an
  // index record (e.g. markdown read straight from disk) we return a stub so
  // the client can render the visibility toggle on the first open.
  app.get('/api/file/meta', async (req, reply) => {
    const { path: rel, p: publicPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const requester = req.currentUser?.username
    const ctx = await resolveReadContext({ rel, ownerHint, requester })
    if (ownerHint && ownerHint !== requester && !ctx.sharedGrant) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    let meta = ctx.meta
    // Lazy GPS backfill: a legacy image uploaded before EXIF wiring
    // (or one whose ingest predated `gps`) gets parsed on first
    // owner-side meta view. Caps work to a single image so this stays
    // sub-100ms; absence is cached as `null` so we never retry.
    if (
      meta &&
      meta.gps === undefined &&
      couldHaveGps(meta.originalFilename) &&
      !!requester &&
      meta.owner === requester
    ) {
      try {
        const abs = resolveVault(meta.storageKey, meta.owner)
        const buf = await readFile(abs)
        const gps = await extractGps(buf, meta.originalFilename)
        if (gps !== undefined) {
          meta = { ...meta, gps }
          await saveMeta(meta)
        }
      } catch {
        /* swallow — best-effort */
      }
    }
    if (meta) {
      // Owner sees the full meta (their own data); cross-owner /
      // anonymous viewers get the stricter redaction so we don't leak
      // ACL members, the sha256, or internal id alongside the public
      // share. (Password hash is always stripped.)
      // Three viewer tiers:
      //   owner          → full meta (only password hash stripped)
      //   share recipient → keep id (needed for chat / mcp /
      //                     anything that POSTs against /api/.../:docId),
      //                     strip ACL + sha256
      //   public link    → strict — strip id, ACL, sha256
      const isOwner = !!requester && meta.owner === requester
      const isShareRecipient = !!ctx.sharedGrant
      const safe = isOwner
        ? redactPublicMeta(meta)
        : isShareRecipient
          ? (redactForShareRecipient(meta) as DocumentMeta)
          : (redactForPublicViewer(meta) as DocumentMeta)
      if (meta.public) {
        const gate = publicGate(meta, publicPassword)
        if (gate === 'password-required' || gate === 'password-wrong') {
          // Expose just enough so the UI can render a password prompt
          // without giving away anything sensitive.
          return reply
            .code(401)
            .send({
              error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
              passwordRequired: true,
              filename: meta.originalFilename,
              ext: path.extname(meta.storageKey).toLowerCase(),
            })
        }
        return { meta: safe }
      }
      if (!requireAuth(req, reply)) return
      const u = req.currentUser!
      // A share grant from resolveReadContext above already proves read
      // access — userCanRead only knows about owner + ACL, not shares,
      // so it would 403 otherwise.
      if (!ctx.sharedGrant && !userCanRead(meta, u.username, u.role)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      return { meta: safe }
    }
    // No persisted meta — synthesize a stub if the file exists. Look it
    // up under the resolved owner (which might be a share owner, not
    // the caller) so shared files without a doc record still surface.
    if (!requireAuth(req, reply)) return
    const u = req.currentUser!
    const lookupOwner = ctx.owner ?? u.username
    const abs = resolveVault(rel, lookupOwner)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return { meta: null }
    const filename = path.basename(abs)
    const stub: DocumentMeta = {
      id: '',
      title: filename.replace(/\.[^.]+$/, ''),
      originalFilename: filename,
      mime: inferMime(filename),
      bytes: s.size,
      sha256: '',
      storageKey: rel,
      owner: u.username,
      acl: { readers: [], editors: [] },
      public: false,
      tags: [],
      createdAt: s.birthtimeMs || Date.now(),
      updatedAt: s.mtimeMs || Date.now(),
      ingest: { status: 'pending', embedded: false },
    }
    return { meta: stub }
  })

  // Flip a file's public flag. Only owner / admin / listed editor may change
  // it. Creates an index record on the fly for vault files that haven't been
  // ingested yet (markdown, txt, etc.) so visibility works for every file.
  app.post('/api/file/visibility', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const body = req.body as {
      path?: string
      public?: boolean
      expiresInSeconds?: number | null
      password?: string | null
    }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })
    if (typeof body.public !== 'boolean') return reply.code(400).send({ error: 'missing public flag' })
    const abs = resolveVault(body.path, user.username)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })
    const docs = await listAllDocuments()
    let meta = docs.find((d) => d.storageKey === body.path && d.owner === user.username)
    if (!meta) {
      // Create a minimal record — no ingest, just enough to track visibility.
      const filename = path.basename(abs)
      meta = {
        id: nanoid(),
        title: filename.replace(/\.[^.]+$/, ''),
        originalFilename: filename,
        mime: inferMime(filename),
        bytes: s.size,
        sha256: '',
        storageKey: body.path,
        owner: user.username,
        acl: { readers: [], editors: [] },
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ingest: { status: 'pending', embedded: false },
      }
    } else if (!userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    // Resolve expiry: null/undefined → no expiry (or carry over existing if
    // unchanged); a number → seconds from now. Password: empty/null → clear.
    let publicExpiresAt: number | null = null
    if (body.expiresInSeconds === null || body.expiresInSeconds === undefined) {
      // Inherit existing expiry if we're flipping the same flag with no
      // explicit override, otherwise default to no-expiry.
      publicExpiresAt = body.public ? meta.publicExpiresAt ?? null : null
    } else if (typeof body.expiresInSeconds === 'number') {
      publicExpiresAt = Date.now() + Math.max(60, Math.floor(body.expiresInSeconds)) * 1000
    }
    let publicPasswordHash: string | null
    if (body.password === undefined) {
      publicPasswordHash = body.public ? meta.publicPasswordHash ?? null : null
    } else if (body.password === null || body.password === '') {
      publicPasswordHash = null
    } else {
      publicPasswordHash = hashShareSecret(body.password)
    }

    const next: DocumentMeta = {
      ...meta,
      public: body.public,
      publicExpiresAt: body.public ? publicExpiresAt : null,
      publicPasswordHash: body.public ? publicPasswordHash : null,
      updatedAt: Date.now(),
    }
    await saveMeta(next)
    publish({ type: 'visibility', path: body.path, public: body.public })
    dispatchWebhook({
      type: 'visibility',
      path: body.path,
      actor: user.username,
      public: body.public,
    }).catch(() => null)
    await audit({
      actor: user.username,
      action: 'vault.visibility',
      target: body.path,
      meta: {
        public: body.public,
        hasPassword: !!publicPasswordHash,
        expiresAt: publicExpiresAt,
      },
    })
    return { document: redactPublicMeta(next) }
  })

  // ---- tags ---------------------------------------------------------------

  // Replace a file's tag list. Tags are free-form strings; we lowercase + trim
  // and de-dupe so "Receipts" and "receipts " collapse. Creates a stub doc
  // record if the file isn't indexed yet, matching the visibility endpoint.
  app.post('/api/file/tags', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const body = req.body as { path?: string; tags?: unknown; owner?: string }
    if (!body?.path) return reply.code(400).send({ error: 'missing path' })
    if (!Array.isArray(body.tags)) return reply.code(400).send({ error: 'tags must be an array' })
    const tags = Array.from(
      new Set(
        body.tags
          .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
          .filter((t) => t.length > 0 && t.length <= 40),
      ),
    ).sort()
    // Cross-owner edit: a share-recipient with `canEdit: true` can
    // mutate tags on the owner's file. Resolve the path under the
    // effective owner (the share owner when cross-owner) and gate on
    // the edit grant.
    const effectiveOwner = body.owner && body.owner !== user.username ? body.owner : user.username
    const abs = resolveVault(body.path, effectiveOwner)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) return reply.code(404).send({ error: 'not found' })
    const docs = await listAllDocuments()
    let meta = docs.find((d) => d.storageKey === body.path && d.owner === effectiveOwner)
    if (effectiveOwner !== user.username) {
      const ok = await isEditableViaShare(
        meta ?? { owner: effectiveOwner, storageKey: body.path },
        user,
      )
      if (!ok) return reply.code(403).send({ error: 'forbidden' })
    }
    if (!meta) {
      const filename = path.basename(abs)
      meta = {
        id: nanoid(),
        title: filename.replace(/\.[^.]+$/, ''),
        originalFilename: filename,
        mime: inferMime(filename),
        bytes: s.size,
        sha256: '',
        storageKey: body.path,
        owner: effectiveOwner,
        acl: { readers: [], editors: [] },
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ingest: { status: 'pending', embedded: false },
      }
    } else if (effectiveOwner === user.username && !userCanEdit(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const next: DocumentMeta = { ...meta, tags, updatedAt: Date.now() }
    await saveMeta(next)
    invalidateSearchCache()
    publish({ type: 'tags', path: body.path, tags })
    dispatchWebhook({
      type: 'tags',
      path: body.path,
      actor: user.username,
      tags,
    }).catch(() => null)
    await audit({
      actor: user.username,
      action: 'vault.tags',
      target: body.path,
      meta: { tags },
    })
    return { document: redactPublicMeta(next) }
  })

  // ---- folders ------------------------------------------------------------
  //
  // Folders aren't documents — they're just directories on disk — but the UI
  // wants the same affordances files have: tags, public link, activity. We
  // store per-folder metadata in `folderMetas` (one JSON per folder) and
  // cascade visibility changes down the subtree so a single "Make public"
  // click on a folder publishes every file and sub-folder inside it with
  // one shared expiry/password.

  app.get('/api/folder/meta', async (req, reply) => {
    const { path: rel, p: providedPassword, owner: ownerHint } =
      req.query as { path?: string; p?: string; owner?: string }
    if (typeof rel !== 'string') return reply.code(400).send({ error: 'missing path' })
    const requester = req.currentUser?.username
    let owner = ownerHint || requester
    let fm = owner ? await getFolderMeta(owner, rel) : null
    // Anonymous + no hint: scan for any public folder with this path. Matches
    // how the file-side resolves a public URL without needing ?owner=.
    if (!owner && !requester) {
      const all = await listFolderMetas()
      const candidates = all.filter((m) => m.storageKey === rel && m.public)
      let lastGate: ReturnType<typeof publicGate> = 'not-public'
      for (const c of candidates) {
        const g = publicGate(c, providedPassword)
        lastGate = g
        if (g === 'ok') {
          owner = c.owner
          fm = c
          break
        }
      }
      if (!owner) {
        if (lastGate === 'password-required' || lastGate === 'password-wrong') {
          return reply
            .code(401)
            .send({
              error: lastGate === 'password-wrong' ? 'incorrect password' : 'password required',
              passwordRequired: true,
            })
        }
        return reply.code(401).send({ error: 'auth required' })
      }
    }
    if (!owner) return reply.code(401).send({ error: 'auth required' })
    if (owner !== requester) {
      const gate = publicGate(fm, providedPassword)
      if (gate === 'password-required' || gate === 'password-wrong') {
        return reply
          .code(401)
          .send({
            error: gate === 'password-wrong' ? 'incorrect password' : 'password required',
            passwordRequired: true,
          })
      }
      if (gate !== 'ok') return reply.code(403).send({ error: 'forbidden' })
    }
    const abs = resolveVault(rel, owner)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isDirectory()) return reply.code(404).send({ error: 'folder not found' })
    const meta = fm ?? freshFolderMeta(owner, rel)
    const { publicPasswordHash, ...safe } = meta
    return { folder: { ...safe, owner, hasPassword: !!publicPasswordHash } }
  })

  app.post('/api/folder/visibility', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as {
      path?: string
      public?: boolean
      expiresInSeconds?: number | null
      password?: string | null
    }
    if (typeof body?.path !== 'string') return reply.code(400).send({ error: 'missing path' })
    if (typeof body.public !== 'boolean') return reply.code(400).send({ error: 'missing public flag' })
    const abs = resolveVault(body.path, user.username)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isDirectory()) return reply.code(404).send({ error: 'folder not found' })

    const now = Date.now()
    const expiresAt =
      !body.public || body.expiresInSeconds === null || body.expiresInSeconds === undefined
        ? null
        : now + Math.max(60, Math.floor(body.expiresInSeconds)) * 1000
    const passwordHash =
      !body.public || !body.password ? null : hashShareSecret(body.password)

    // Own folder meta first — even if the cascade fails halfway, the folder
    // itself reflects the user's intent.
    const existing = await getFolderMeta(user.username, body.path)
    const folderMeta = {
      ...(existing ?? freshFolderMeta(user.username, body.path)),
      owner: user.username,
      storageKey: body.path,
      public: body.public,
      publicExpiresAt: body.public ? expiresAt : null,
      publicPasswordHash: body.public ? passwordHash : null,
      updatedAt: now,
    }
    await saveFolderMeta(folderMeta)

    // Cascade.
    const { files, folders } = await expandTreeUnder(user.username, body.path)
    const docs = await listAllDocuments()
    let okFiles = 0
    let failedFiles = 0
    for (const fileRel of files) {
      try {
        let meta = docs.find((d) => d.storageKey === fileRel && d.owner === user.username)
        if (!meta) {
          const fAbs = resolveVault(fileRel, user.username)
          const fStat = await stat(fAbs).catch(() => null)
          if (!fStat?.isFile()) {
            failedFiles++
            continue
          }
          const filename = path.basename(fAbs)
          meta = {
            id: nanoid(),
            title: filename.replace(/\.[^.]+$/, ''),
            originalFilename: filename,
            mime: inferMime(filename),
            bytes: fStat.size,
            sha256: '',
            storageKey: fileRel,
            owner: user.username,
            acl: { readers: [], editors: [] },
            tags: [],
            createdAt: now,
            updatedAt: now,
            ingest: { status: 'pending', embedded: false },
          }
        } else if (!userCanEdit(meta, user.username, user.role)) {
          failedFiles++
          continue
        }
        const next: DocumentMeta = {
          ...meta,
          public: body.public,
          publicExpiresAt: body.public ? expiresAt : null,
          publicPasswordHash: body.public ? passwordHash : null,
          updatedAt: now,
        }
        await saveMeta(next)
        // Per-item audit so the file's own activity log reflects the
        // cascade — without this, opening a file's activity would never
        // explain why it suddenly went public/private.
        await audit({
          actor: user.username,
          action: 'vault.visibility',
          target: fileRel,
          meta: {
            public: body.public,
            hasPassword: !!passwordHash,
            expiresAt,
            cascadedFrom: body.path,
          },
        })
        okFiles++
      } catch {
        failedFiles++
      }
    }
    let failedFolders = 0
    for (const subRel of folders) {
      try {
        const sub = await getFolderMeta(user.username, subRel)
        await saveFolderMeta({
          ...(sub ?? freshFolderMeta(user.username, subRel)),
          owner: user.username,
          storageKey: subRel,
          public: body.public,
          publicExpiresAt: body.public ? expiresAt : null,
          publicPasswordHash: body.public ? passwordHash : null,
          updatedAt: now,
        })
        await audit({
          actor: user.username,
          action: 'vault.folder-visibility',
          target: subRel,
          meta: {
            public: body.public,
            hasPassword: !!passwordHash,
            expiresAt,
            cascadedFrom: body.path,
          },
        })
      } catch {
        // Don't abort the whole cascade on one sub-folder failure;
        // record + continue so the rest still flip.
        failedFolders++
      }
    }
    invalidateSearchCache()
    publish({ type: 'visibility', path: body.path, public: body.public })
    await audit({
      actor: user.username,
      action: 'vault.folder-visibility',
      target: body.path,
      meta: {
        public: body.public,
        files: okFiles,
        failedFiles,
        folders: folders.length,
        hasPassword: !!passwordHash,
        expiresAt,
      },
    })
    const { publicPasswordHash: _drop, ...safe } = folderMeta
    return {
      folder: { ...safe, hasPassword: !!passwordHash },
      cascade: { files: okFiles, folders: folders.length, failedFiles },
    }
  })

  app.post('/api/folder/tags', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    if (user.role === 'viewer') return reply.code(403).send({ error: 'forbidden' })
    const body = req.body as { path?: string; tags?: unknown }
    if (typeof body?.path !== 'string') return reply.code(400).send({ error: 'missing path' })
    if (!Array.isArray(body.tags)) return reply.code(400).send({ error: 'tags must be array' })
    const tags = Array.from(
      new Set(
        body.tags
          .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
          .filter((t) => t.length > 0 && t.length <= 40),
      ),
    ).sort()
    const abs = resolveVault(body.path, user.username)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isDirectory()) return reply.code(404).send({ error: 'folder not found' })
    const existing = await getFolderMeta(user.username, body.path)
    const next = {
      ...(existing ?? freshFolderMeta(user.username, body.path)),
      tags,
      updatedAt: Date.now(),
    }
    await saveFolderMeta(next)
    await audit({
      actor: user.username,
      action: 'vault.folder-tags',
      target: body.path,
      meta: { tags },
    })
    const { publicPasswordHash, ...safe } = next
    return { folder: { ...safe, hasPassword: !!publicPasswordHash } }
  })

  app.get('/api/folder/activity', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const { path: rel, limit } = req.query as { path?: string; limit?: string }
    if (typeof rel !== 'string') return reply.code(400).send({ error: 'missing path' })
    const { listAudit } = await import('../stores/audit.js')
    // listAudit can only filter by exact target. For folders we want every
    // event under the prefix, so pull a wider window and filter here.
    const all = await listAudit({ limit: Math.min(Number(limit) || 200, 1000) })
    const prefix = rel ? `${rel}/` : ''
    const entries = all.filter(
      (e) => e.target === rel || (typeof e.target === 'string' && e.target.startsWith(prefix)),
    )
    return { entries: entries.slice(0, Math.min(Number(limit) || 50, 200)) }
  })

  // Version history: list snapshots taken by the watcher whenever the file's
  // content changed on disk.
  app.get('/api/file/versions', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { path: rel } = req.query as { path?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (!meta) return reply.code(404).send({ error: 'not indexed' })
    if (!userCanRead(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const { listVersions } = await import('../stores/versions.js')
    const versions = await listVersions(meta.id)
    return { versions }
  })

  // Fetch one historical version's extracted text. We don't reconstruct the
  // original blob (we'd need to keep raw bytes, which doubles storage); just
  // the extracted-text plus meta is enough to answer "what did this file say
  // back then?"
  app.get('/api/file/version', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { path: rel, ts } = req.query as { path?: string; ts?: string }
    if (!rel || !ts) return reply.code(400).send({ error: 'missing path or ts' })
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (!meta) return reply.code(404).send({ error: 'not indexed' })
    if (!userCanRead(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const { readVersionText } = await import('../stores/versions.js')
    const text = await readVersionText(meta.id, Number(ts))
    if (text == null) return reply.code(404).send({ error: 'version not found' })
    return { ts: Number(ts), text }
  })

  // Audit trail scoped to one file. Same access check as raw/text — the user
  // must be able to read the file to see its activity. Doc viewer renders this
  // in an "Activity" panel.
  app.get('/api/file/activity', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { path: rel, limit } = req.query as { path?: string; limit?: string }
    if (!rel) return reply.code(400).send({ error: 'missing path' })
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel)
    if (meta && !userCanRead(meta, user.username, user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const { listAudit } = await import('../stores/audit.js')
    const entries = await listAudit({ target: rel, limit: Math.min(Number(limit) || 50, 200) })
    return { entries }
  })

  // The full set of tags in use across the vault, with the doc count for each
  // — populates the sidebar / picker.
  app.get('/api/tags', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const docs = await listAllDocuments()
    // Pull share-grants too — a tag on alice's shared file or folder
    // should show up in bob's sidebar so he can filter by it.
    const sharesIn = await import('../stores/userShares.js').then((m) =>
      m.listSharesTo(user.username),
    )
    const counts = new Map<string, number>()
    // File tags from DocumentMeta.
    for (const d of docs) {
      const canRead =
        userCanRead(d, user.username, user.role) ||
        (await isReadableViaShares(d, user.username, sharesIn))
      if (!canRead) continue
      for (const t of d.tags || []) {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    // Folder tags from FolderMeta — without this, tags applied to a
    // folder (via the folder toolbar) silently disappear from the
    // sidebar tag list.
    const folderMetas = await listFolderMetas()
    for (const fm of folderMetas) {
      const canRead =
        fm.owner === user.username ||
        user.role === 'admin' ||
        // Treat folder access via share grant: any folder share whose
        // path is the folder itself or an ancestor counts.
        sharesIn.some(
          (s) =>
            s.owner === fm.owner &&
            s.isFolder &&
            (s.storageKey === '' ||
              s.storageKey === fm.storageKey ||
              fm.storageKey.startsWith(s.storageKey.replace(/\/+$/, '') + '/')),
        )
      if (!canRead) continue
      for (const t of fm.tags || []) {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    const out = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    return { tags: out }
  })

  // Cross-folder filename + tag search, ranked. Used by the sidebar filter
  // input so typing matches by tag as well as by name without needing to
  // expand every folder. Pure metadata — no chunk/embedding work, so it's
  // cheap enough to call on every keystroke.
  app.get('/api/files/search', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { q = '', limit } = req.query as { q?: string; limit?: string }
    const needle = q.trim().toLowerCase()
    const lim = Math.min(Number(limit) || 50, 200)
    if (!needle) return { q: '', items: [], folders: [] }
    const docs = await listAllDocuments()
    const sharesIn = await import('../stores/userShares.js').then((m) =>
      m.listSharesTo(user.username),
    )
    type Hit = {
      path: string
      name: string
      ext: string
      docId: string
      tags: string[]
      public: boolean
      owner: string
      score: number
      matchedTags: string[]
    }
    const hits: Hit[] = []
    for (const d of docs) {
      const canRead =
        userCanRead(d, user.username, user.role) ||
        (await isReadableViaShares(d, user.username, sharesIn))
      if (!canRead) continue
      const name = path.basename(d.storageKey).toLowerCase()
      const title = (d.title || '').toLowerCase()
      const tags = d.tags ?? []
      const matchedTags: string[] = []
      let score = 0
      if (name === needle) score += 6
      else if (name.startsWith(needle)) score += 4
      else if (name.includes(needle)) score += 2
      if (title.includes(needle)) score += 1
      for (const t of tags) {
        if (t === needle) {
          score += 5
          matchedTags.push(t)
        } else if (t.startsWith(needle)) {
          score += 3
          matchedTags.push(t)
        } else if (needle.length >= 3 && t.includes(needle)) {
          score += 1.5
          matchedTags.push(t)
        }
      }
      if (score === 0) continue
      hits.push({
        path: d.storageKey,
        name: path.basename(d.storageKey),
        ext: path.extname(d.storageKey).toLowerCase(),
        docId: d.id,
        tags,
        public: !!d.public,
        owner: d.owner,
        score,
        matchedTags,
      })
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

    // Folder matches — walk the caller's own vault AND every shared
    // folder root the caller has been granted, so a shared subtree is
    // searchable too. Folder tag matches (FolderMeta) also count here.
    type FolderHit = { path: string; name: string; owner: string; score: number }
    const folderHits: FolderHit[] = []
    const allFolderMetas = await listFolderMetas()
    async function walkFolders(absDir: string, rel: string, owner: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (shouldSkipName(e.name)) continue
        if (!e.isDirectory()) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        const name = e.name.toLowerCase()
        let score = 0
        if (name === needle) score += 6
        else if (name.startsWith(needle)) score += 4
        else if (name.includes(needle)) score += 2
        // Folder-tag match — same scoring shape as file-tag match.
        const fm = allFolderMetas.find(
          (m) => m.owner === owner && m.storageKey === childRel,
        )
        for (const t of fm?.tags ?? []) {
          if (t === needle) score += 5
          else if (t.startsWith(needle)) score += 3
          else if (needle.length >= 3 && t.includes(needle)) score += 1.5
        }
        if (score > 0)
          folderHits.push({ path: childRel, name: e.name, owner, score })
        await walkFolders(path.join(absDir, e.name), childRel, owner)
      }
    }
    await walkFolders(userVaultRoot(user.username), '', user.username)
    // Walk each shared folder subtree under the share owner.
    for (const s of sharesIn) {
      if (!s.isFolder) continue
      const ownerRoot = userVaultRoot(s.owner)
      const sharedAbs = s.storageKey
        ? path.join(ownerRoot, s.storageKey)
        : ownerRoot
      await walkFolders(sharedAbs, s.storageKey, s.owner)
    }
    folderHits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

    return {
      q: needle,
      items: hits.slice(0, lim),
      folders: folderHits.slice(0, Math.min(20, lim)),
    }
  })

  // List every (visible) file carrying a given tag — fuels the "tag click in
  // sidebar filters the grid" UX.
  app.get('/api/files/by-tag', async (req, reply) => {
    if (!requireAuth(req, reply)) return
    const user = req.currentUser!
    const { tag } = req.query as { tag?: string }
    if (!tag) return reply.code(400).send({ error: 'missing tag' })
    const t = tag.trim().toLowerCase()
    const docs = await listAllDocuments()
    const sharesIn = await import('../stores/userShares.js').then((m) =>
      m.listSharesTo(user.username),
    )
    const items: Array<{
      path: string
      name: string
      ext: string
      docId: string
      tags: string[]
      public: boolean
      owner: string
      type: 'file' | 'dir'
    }> = []
    for (const d of docs) {
      if (!d.tags?.includes(t)) continue
      const canRead =
        userCanRead(d, user.username, user.role) ||
        (await isReadableViaShares(d, user.username, sharesIn))
      if (!canRead) continue
      items.push({
        path: d.storageKey,
        name: path.basename(d.storageKey),
        ext: path.extname(d.storageKey).toLowerCase(),
        docId: d.id,
        tags: d.tags,
        public: !!d.public,
        owner: d.owner,
        type: 'file',
      })
    }
    // Folder-tag matches — surfaced as items too so clicking a tag in
    // the sidebar reveals tagged folders alongside tagged files.
    const folderMetas = await listFolderMetas()
    for (const fm of folderMetas) {
      if (!fm.tags?.includes(t)) continue
      const canRead =
        fm.owner === user.username ||
        user.role === 'admin' ||
        sharesIn.some(
          (s) =>
            s.owner === fm.owner &&
            s.isFolder &&
            (s.storageKey === '' ||
              s.storageKey === fm.storageKey ||
              fm.storageKey.startsWith(s.storageKey.replace(/\/+$/, '') + '/')),
        )
      if (!canRead) continue
      items.push({
        path: fm.storageKey,
        name: path.basename(fm.storageKey) || fm.storageKey,
        ext: '',
        docId: '',
        tags: fm.tags,
        public: !!fm.public,
        owner: fm.owner,
        type: 'dir',
      })
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { tag: t, items }
  })
}
