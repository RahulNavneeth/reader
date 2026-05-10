import type { Plugin } from 'vite'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
const MD_EXTS = new Set(['.md', '.markdown', '.mdx'])

type TreeNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  ext?: string
  size?: number
  mtime?: number
  hasChildren?: boolean
}

function expandPath(p: string): string {
  if (!p) return HOME
  if (p === '~') return HOME
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2))
  return path.resolve(p)
}

function isSafe(target: string, root: string): boolean {
  const r = path.resolve(root)
  const t = path.resolve(target)
  return t === r || t.startsWith(r + path.sep)
}

function shouldSkip(name: string): boolean {
  if (name.startsWith('.')) return true
  if (name === 'node_modules' || name === 'dist' || name === 'build') return true
  if (name === '.git') return true
  return false
}

async function listDir(dir: string): Promise<TreeNode[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: TreeNode[] = []
  for (const e of entries) {
    if (shouldSkip(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push({ name: e.name, path: full, type: 'dir', hasChildren: true })
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (!MD_EXTS.has(ext)) continue
      try {
        const s = await stat(full)
        out.push({ name: e.name, path: full, type: 'file', ext, size: s.size, mtime: s.mtimeMs })
      } catch {
        out.push({ name: e.name, path: full, type: 'file', ext })
      }
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return out
}

async function searchAll(root: string, query: string, maxResults = 100): Promise<Array<{ path: string; name: string; matches: Array<{ line: number; text: string }> }>> {
  const q = query.toLowerCase()
  const results: Array<{ path: string; name: string; matches: Array<{ line: number; text: string }> }> = []
  async function walk(dir: string) {
    if (results.length >= maxResults) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (results.length >= maxResults) return
      if (shouldSkip(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!MD_EXTS.has(ext)) continue
        try {
          const text = await readFile(full, 'utf8')
          const lines = text.split(/\r?\n/)
          const matches: Array<{ line: number; text: string }> = []
          for (let i = 0; i < lines.length && matches.length < 5; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              matches.push({ line: i + 1, text: lines[i].slice(0, 240) })
            }
          }
          if (matches.length) {
            results.push({ path: full, name: e.name, matches })
          }
        } catch {
          // skip
        }
      }
    }
  }
  await walk(root)
  return results
}

function send(res: any, status: number, body: any) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function fsApiPlugin(): Plugin {
  return {
    name: 'md-reader-fs-api',
    configureServer(server) {
      server.middlewares.use('/api/home', (_req, res) => {
        send(res, 200, { home: HOME, separator: path.sep })
      })

      server.middlewares.use('/api/list', async (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const target = expandPath(url.searchParams.get('path') || '')
          const root = expandPath(url.searchParams.get('root') || target)
          if (!isSafe(target, root)) return send(res, 403, { error: 'path outside root' })
          const items = await listDir(target)
          send(res, 200, { path: target, items })
        } catch (e: any) {
          send(res, 500, { error: e.message })
        }
      })

      server.middlewares.use('/api/file', async (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const target = expandPath(url.searchParams.get('path') || '')
          const root = expandPath(url.searchParams.get('root') || target)
          if (!isSafe(target, root)) return send(res, 403, { error: 'path outside root' })
          const ext = path.extname(target).toLowerCase()
          if (!MD_EXTS.has(ext)) return send(res, 400, { error: 'unsupported file type' })
          const text = await readFile(target, 'utf8')
          const s = await stat(target)
          send(res, 200, { path: target, content: text, size: s.size, mtime: s.mtimeMs })
        } catch (e: any) {
          send(res, 500, { error: e.message })
        }
      })

      server.middlewares.use('/api/search', async (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const root = expandPath(url.searchParams.get('root') || '')
          const q = (url.searchParams.get('q') || '').trim()
          if (!q) return send(res, 200, { results: [] })
          if (!root) return send(res, 400, { error: 'missing root' })
          const results = await searchAll(root, q)
          send(res, 200, { results })
        } catch (e: any) {
          send(res, 500, { error: e.message })
        }
      })

      server.middlewares.use('/api/validate', async (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const target = expandPath(url.searchParams.get('path') || '')
          const s = await stat(target)
          send(res, 200, { path: target, exists: true, isDirectory: s.isDirectory() })
        } catch {
          send(res, 200, { exists: false })
        }
      })
    },
  }
}
