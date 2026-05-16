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
