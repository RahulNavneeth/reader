import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { readdir, createReadStream } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { loadSettings, saveSettings, type ExternalMount } from '../stores/settings.js'
import { audit } from '../stores/audit.js'

const mountCreateSchema = z.object({
  name: z.string().min(1).max(80),
  absPath: z.string().min(1),
})

/** Resolve `rel` inside `mount.absPath` and refuse traversal. Mirrors the
 *  hardening in `resolveUserVault` so a `?path=../../../etc/passwd` can't
 *  escape the mount root. */
function resolveInMount(mount: ExternalMount, rel: string): string {
  const r = (rel ?? '').replace(/^\/+/, '')
  if (r.includes('..')) {
    const err = new Error('invalid path') as Error & { statusCode: number }
    err.statusCode = 400
    throw err
  }
  const abs = path.resolve(mount.absPath, r)
  if (abs !== mount.absPath && !abs.startsWith(mount.absPath + path.sep)) {
    const err = new Error('path outside mount') as Error & { statusCode: number }
    err.statusCode = 403
    throw err
  }
  return abs
}

export async function externalMountsRoutes(app: FastifyInstance) {
  // Admin: list/create/delete mounts.
  app.get('/api/admin/external-mounts', { preHandler: app.requireAdmin }, async () => {
    const s = await loadSettings()
    return { mounts: s.externalMounts ?? [] }
  })

  app.post('/api/admin/external-mounts', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = mountCreateSchema.parse(req.body)
    const abs = path.resolve(body.absPath)
    try {
      const st = await fsStat(abs)
      if (!st.isDirectory()) return reply.code(400).send({ error: 'not a directory' })
    } catch {
      return reply.code(400).send({ error: 'path does not exist' })
    }
    const s = await loadSettings()
    const mounts = s.externalMounts ?? []
    if (mounts.some((m) => m.absPath === abs)) {
      return reply.code(409).send({ error: 'mount already exists' })
    }
    const mount: ExternalMount = {
      id: nanoid(),
      name: body.name.trim(),
      absPath: abs,
      createdAt: Date.now(),
    }
    await saveSettings({ ...s, externalMounts: [...mounts, mount] })
    await audit({
      actor: req.currentUser!.username,
      action: 'admin.mount.add',
      target: mount.id,
      meta: { name: mount.name, absPath: abs },
      ip: req.ip,
    })
    return { mount }
  })

  app.delete(
    '/api/admin/external-mounts/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const s = await loadSettings()
      const mounts = s.externalMounts ?? []
      const next = mounts.filter((m) => m.id !== id)
      if (next.length === mounts.length) return reply.code(404).send({ error: 'not found' })
      await saveSettings({ ...s, externalMounts: next })
      await audit({
        actor: req.currentUser!.username,
        action: 'admin.mount.remove',
        target: id,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  // Any signed-in user: list mounts (no absPath leak) + browse + read.
  app.get('/api/external-mounts', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const s = await loadSettings()
    return {
      mounts: (s.externalMounts ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        // Last segment of the abs path so the user knows roughly what
        // they're browsing without leaking the full server-side path.
        hint: path.basename(m.absPath),
      })),
    }
  })

  app.get('/api/external-mounts/:id/list', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id } = req.params as { id: string }
    const rel = ((req.query as any)?.path as string | undefined) ?? ''
    const s = await loadSettings()
    const mount = (s.externalMounts ?? []).find((m) => m.id === id)
    if (!mount) return reply.code(404).send({ error: 'mount not found' })
    let abs: string
    try {
      abs = resolveInMount(mount, rel)
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid path' })
    }
    let names: string[]
    try {
      names = await new Promise<string[]>((res, rej) =>
        readdir(abs, (err, files) => (err ? rej(err) : res(files))),
      )
    } catch (e: any) {
      if (e?.code === 'ENOENT') return reply.code(404).send({ error: 'not found' })
      if (e?.code === 'ENOTDIR') return reply.code(400).send({ error: 'not a directory' })
      throw e
    }
    type Entry = {
      name: string
      path: string
      type: 'dir' | 'file'
      ext?: string
      size?: number
      mtime?: number
      hasChildren?: boolean
    }
    const items: Entry[] = []
    for (const n of names) {
      if (n.startsWith('.')) continue
      const childAbs = path.join(abs, n)
      try {
        const st = await fsStat(childAbs)
        const childRel = path.posix.join(rel, n).replace(/^\/+/, '')
        if (st.isDirectory()) {
          // Cheap "has children" probe.
          let hasChildren = false
          try {
            const inner = await new Promise<string[]>((res, rej) =>
              readdir(childAbs, (err, files) => (err ? rej(err) : res(files))),
            )
            hasChildren = inner.some((x) => !x.startsWith('.'))
          } catch {
            /* unreadable */
          }
          items.push({ name: n, path: childRel, type: 'dir', hasChildren })
        } else if (st.isFile()) {
          const ext = (n.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
          items.push({
            name: n,
            path: childRel,
            type: 'file',
            ext,
            size: st.size,
            mtime: st.mtimeMs,
          })
        }
      } catch {
        /* skip unreadable */
      }
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { mountId: id, mountName: mount.name, path: rel, items }
  })

  app.get('/api/external-mounts/:id/file', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const { id } = req.params as { id: string }
    const rel = ((req.query as any)?.path as string | undefined) ?? ''
    const s = await loadSettings()
    const mount = (s.externalMounts ?? []).find((m) => m.id === id)
    if (!mount) return reply.code(404).send({ error: 'mount not found' })
    let abs: string
    try {
      abs = resolveInMount(mount, rel)
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ error: e?.message ?? 'invalid path' })
    }
    let st: { size: number }
    try {
      st = await fsStat(abs)
    } catch {
      return reply.code(404).send({ error: 'not found' })
    }
    const name = path.basename(abs)
    const ext = (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
    const mime = guessMime(ext)
    reply.raw.setHeader('Content-Type', mime)
    reply.raw.setHeader('Content-Length', String(st.size))
    reply.raw.setHeader('Cache-Control', 'private, max-age=60')
    reply.hijack()
    const stream = createReadStream(abs)
    stream.pipe(reply.raw)
    stream.on('error', () => {
      if (!reply.raw.headersSent) reply.raw.writeHead(500)
      reply.raw.end()
    })
  })

  // Import file(s) / folder(s) from a mount into the requester's
  // own vault. Read-only mounts are still imported FROM safely
  // (we copy bytes; the mount itself is never written to).
  //
  // Body: { paths: string[]; dest: string }
  //   paths – mount-relative file or folder paths
  //   dest  – vault-relative destination directory ("" = root).
  //           Files keep their basename; folder imports preserve
  //           the subtree under `<dest>/<folderName>/…`.
  app.post('/api/external-mounts/:id/import', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const user = req.currentUser
    if (user.role === 'viewer') {
      return reply.code(403).send({ error: 'viewers cannot import' })
    }
    const { id } = req.params as { id: string }
    const body = req.body as { paths?: string[]; dest?: string }
    const paths = Array.isArray(body?.paths)
      ? body.paths.filter((p): p is string => typeof p === 'string')
      : []
    const dest = String(body?.dest ?? '').replace(/^\/+|\/+$/g, '')
    if (paths.length === 0) {
      return reply.code(400).send({ error: 'no paths to import' })
    }
    const s = await loadSettings()
    const mount = (s.externalMounts ?? []).find((m) => m.id === id)
    if (!mount) return reply.code(404).send({ error: 'mount not found' })
    const { resolveUserVault, ensureUserVault } = await import('../lib/userVault.js')
    const { saveMeta, sha256Of } = await import('../stores/documents.js')
    type Doc = import('../types.js').DocumentMeta
    const { ingestDocument } = await import('../services/ingest.js')
    const { invalidateSearchCache } = await import('../services/search.js')
    const { publish } = await import('../services/events.js')
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    await ensureUserVault(user.username)

    // Recursively walk a mount path, yielding files-only with
    // their relative path under that path's root.
    const walk = async (
      mountAbs: string,
      mountRelRoot: string,
    ): Promise<{ abs: string; rel: string }[]> => {
      const out: { abs: string; rel: string }[] = []
      const st = await fsStat(mountAbs).catch(() => null)
      if (!st) return out
      if (st.isFile()) {
        out.push({ abs: mountAbs, rel: '' })
        return out
      }
      if (!st.isDirectory()) return out
      const stack: { abs: string; rel: string }[] = [{ abs: mountAbs, rel: '' }]
      while (stack.length > 0) {
        const { abs, rel } = stack.pop()!
        let names: string[]
        try {
          names = await new Promise<string[]>((res, rej) =>
            readdir(abs, (err, files) => (err ? rej(err) : res(files))),
          )
        } catch {
          continue
        }
        for (const n of names) {
          if (n.startsWith('.')) continue
          const childAbs = path.join(abs, n)
          const childRel = rel ? `${rel}/${n}` : n
          const childSt = await fsStat(childAbs).catch(() => null)
          if (!childSt) continue
          if (childSt.isDirectory()) {
            stack.push({ abs: childAbs, rel: childRel })
          } else if (childSt.isFile()) {
            out.push({ abs: childAbs, rel: childRel })
          }
        }
      }
      // We don't need the mountRelRoot for the walker itself, but
      // callers use it to know where to place the imported file
      // in the user's vault (see below). Returning the relative
      // path keeps the import-side logic simple.
      void mountRelRoot
      return out
    }

    const imported: string[] = []
    const failed: { path: string; error: string }[] = []
    for (const p of paths) {
      let mountAbs: string
      try {
        mountAbs = resolveInMount(mount, p)
      } catch (e: any) {
        failed.push({ path: p, error: e?.message ?? 'invalid path' })
        continue
      }
      const sourceSt = await fsStat(mountAbs).catch(() => null)
      if (!sourceSt) {
        failed.push({ path: p, error: 'not found' })
        continue
      }
      const sourceBase = path.basename(p) || path.basename(mount.absPath)
      // Files become `<dest>/<basename>`. Folders become a
      // subtree rooted at `<dest>/<folderName>/…`.
      const targetRoot = sourceSt.isDirectory()
        ? (dest ? `${dest}/${sourceBase}` : sourceBase)
        : dest
      const files = await walk(mountAbs, p)
      for (const { abs, rel } of files) {
        const filename = rel || sourceBase
        const vaultRel = targetRoot
          ? `${targetRoot}/${filename}`
          : filename
        try {
          const vaultAbs = resolveUserVault(user.username, vaultRel)
          await mkdir(path.dirname(vaultAbs), { recursive: true })
          // Don't clobber existing vault files — append " (1)",
          // " (2)" etc until we find a free slot. Cheap collision
          // handling is enough; the user can rename later.
          let finalAbs = vaultAbs
          let finalRel = vaultRel
          let n = 1
          while (await fsStat(finalAbs).then(() => true).catch(() => false)) {
            const ext = path.extname(vaultRel)
            const base = vaultRel.slice(0, vaultRel.length - ext.length)
            finalRel = `${base} (${n})${ext}`
            finalAbs = resolveUserVault(user.username, finalRel)
            n++
            if (n > 999) throw new Error('too many collisions')
          }
          const buf = await readFile(abs)
          await writeFile(finalAbs, buf)
          const id = nanoid()
          const meta: Doc = {
            id,
            title: path.basename(finalRel, path.extname(finalRel)),
            originalFilename: path.basename(finalRel),
            mime: guessMime(path.extname(finalRel).toLowerCase()),
            bytes: buf.length,
            sha256: sha256Of(buf),
            storageKey: finalRel,
            owner: user.username,
            acl: { readers: [], editors: [] },
            public: false,
            publicExpiresAt: null,
            publicPasswordHash: null,
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ingest: { status: 'pending', embedded: false },
          }
          await saveMeta(meta)
          await ingestDocument(meta, buf)
          imported.push(finalRel)
          publish({ type: 'edit', path: finalRel })
        } catch (e: any) {
          failed.push({ path: rel ? `${p}/${rel}` : p, error: e?.message ?? 'import failed' })
        }
      }
    }
    invalidateSearchCache()
    void audit({
      actor: user.username,
      action: 'library.import',
      target: dest || '(vault root)',
      meta: { mountId: id, count: imported.length, failed: failed.length },
    }).catch(() => null)
    return reply.code(imported.length > 0 ? 200 : 207).send({
      ok: imported.length > 0,
      imported,
      failed,
    })
  })
}

function guessMime(ext: string): string {
  switch (ext) {
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8'
    case '.pdf':
      return 'application/pdf'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
