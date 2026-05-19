/**
 * Streamable HTTP transport for the Model Context Protocol.
 * Single endpoint POST /mcp accepts JSON-RPC 2.0 requests; auth is by
 * Authorization: Bearer <api-token> (issued via /api/admin/tokens).
 *
 * Implements the minimum subset needed for Claude Code / Desktop / SDKs:
 *   - initialize
 *   - tools/list
 *   - tools/call
 * Notifications are no-ops; we don't yet hold long-lived streams.
 *
 * The token's `createdBy` user is the principal for write operations —
 * minting a token effectively delegates that user's vault access to
 * the agent. Read tools continue to use the role-based principal
 * (admin tokens see everything; lower-role tokens see only public).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import path from 'node:path'
import { findTokenBySecret } from '../stores/tokens.js'
import {
  listAllDocuments,
  loadMeta,
  readText,
  saveMeta,
  sha256Of,
  userCanRead,
  userCanEdit,
} from '../stores/documents.js'
import { searchKnowledge } from '../services/search.js'
import { ensureUserVault, resolveUserVault } from '../lib/userVault.js'
import { writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { ingestDocument } from '../services/ingest.js'
import { nanoid } from 'nanoid'
import { audit } from '../stores/audit.js'
import { addPin } from '../stores/pins.js'
import type { ApiToken, DocumentMeta } from '../types.js'

type RpcRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: any
}

type RpcResponse =
  | { jsonrpc: '2.0'; id: number | string | null; result: any }
  | { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string; data?: any } }

const SERVER_INFO = {
  protocolVersion: '2024-11-05',
  serverInfo: { name: 'reader-knowledge', version: '0.3.0' },
  capabilities: { tools: {}, resources: {}, prompts: {} },
}

const TOOLS = [
  {
    name: 'search_knowledge',
    description:
      "Search the user's document corpus with hybrid lexical + semantic search. Returns ranked snippets across documents the API token has access to.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query.' },
        limit: { type: 'number', default: 10, minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_documents',
    description:
      'List all documents accessible to the API token. Returns `documents` and `nextCursor`; pass `nextCursor` back as `cursor` to fetch the next page. `null` cursor means no more results.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 50, minimum: 1, maximum: 500 },
        cursor: {
          type: 'string',
          description:
            'Opaque pagination cursor from a previous response. Omit for the first page.',
        },
      },
    },
  },
  {
    name: 'get_document',
    description: "Fetch a document's full extracted plaintext by id, plus metadata.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (nanoid).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_folder',
    description:
      'List the immediate contents of a folder in the token-owner vault. Use `path: ""` for the root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative folder path. Empty string = root.' },
      },
    },
  },
  {
    name: 'upload_text',
    description:
      'Create or overwrite a text/markdown file in the token-owner vault. Path is vault-relative (e.g. "notes/agent-output.md"). The file is auto-ingested for search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative target path.' },
        content: { type: 'string', description: 'UTF-8 file contents.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'set_tags',
    description: "Replace a document's tags by document id.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'tags'],
    },
  },
  {
    name: 'pin',
    description: 'Pin a file or folder in the token user\'s sidebar.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        owner: { type: 'string', description: 'Optional — defaults to token user.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'whoami',
    description: 'Return the token user identity and role.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

function ok(id: number | string | null, result: any): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}
function err(id: number | string | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function authHeaderToken(req: FastifyRequest): Promise<ApiToken | null> {
  const h = req.headers.authorization
  if (!h || !h.toLowerCase().startsWith('bearer ')) return null
  const secret = h.slice(7).trim()
  if (!secret) return null
  return findTokenBySecret(secret)
}

/** Find an existing doc meta by vault path under the given owner. Used
 *  by `upload_text` for the create-vs-update branch. */
async function findDocByPath(owner: string, storageKey: string): Promise<DocumentMeta | null> {
  const all = await listAllDocuments()
  return (
    all.find((d) => d.owner === owner && d.storageKey === storageKey) ?? null
  )
}

async function handleCall(token: ApiToken, name: string, args: any) {
  // For read tools that go through ACL: use a synthetic principal that
  // matches the legacy behavior (role drives visibility). For write
  // tools we use the `createdBy` user as the acting principal.
  const principal = { username: `token:${token.id}`, role: token.role }
  const actingUser = token.createdBy

  if (name === 'whoami') {
    return {
      content: [
        { type: 'text', text: `token=${token.id}, user=${actingUser}, role=${token.role}` },
      ],
      structuredContent: { token: token.id, user: actingUser, role: token.role },
    }
  }

  if (name === 'search_knowledge') {
    const q = String(args?.query ?? '').trim()
    const limit = Number.isFinite(args?.limit) ? Math.min(50, Math.max(1, Number(args.limit))) : 10
    const hits = await searchKnowledge({ q, user: principal, limit })
    return {
      content: [
        {
          type: 'text',
          text: hits.length === 0
            ? `No results for "${q}".`
            : hits
                .map((h, i) => {
                  // Surface the per-source RRF contributions inline.
                  // Was previously only in structuredContent.hits[].scores
                  // and easy for a reader of the text output to miss.
                  const breakdown = h.scores
                    ? Object.entries(h.scores)
                        .filter(([, v]) => v > 0)
                        .map(([k, v]) => `${k}=${(v as number).toFixed(4)}`)
                        .join(' ')
                    : ''
                  const header = `${i + 1}. [${h.title}] (${h.source}, score=${h.score.toFixed(4)}${
                    breakdown ? `; ${breakdown}` : ''
                  })`
                  return `${header}\n${h.snippet}\n  doc:${h.docId}${
                    h.chunkIdx != null ? ` chunk:${h.chunkIdx}` : ''
                  }`
                })
                .join('\n\n'),
        },
      ],
      structuredContent: { hits },
    }
  }

  if (name === 'list_documents') {
    const limit = Number.isFinite(args?.limit) ? Math.min(500, Math.max(1, Number(args.limit))) : 50
    // Cursor is base64(JSON({ skip })). Opaque to the client; we
    // bump `skip` by `limit` each page. Stable while the underlying
    // listAllDocuments order is stable (it's sorted by createdAt
    // desc) — if a new doc lands mid-pagination it'll appear at
    // the top of the next request, which is acceptable for a list-
    // documents tool.
    const cursor = typeof args?.cursor === 'string' ? args.cursor : null
    let skip = 0
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
        if (typeof parsed?.skip === 'number' && parsed.skip >= 0) skip = parsed.skip
      } catch {
        throw new Error('invalid cursor')
      }
    }
    const filtered = (await listAllDocuments()).filter((d) =>
      userCanRead(d, principal.username, principal.role),
    )
    const page = filtered.slice(skip, skip + limit).map((d) => ({
      id: d.id,
      title: d.title,
      path: d.storageKey,
      mime: d.mime,
      bytes: d.bytes,
      tags: d.tags,
      owner: d.owner,
      createdAt: d.createdAt,
      ingestStatus: d.ingest.status,
      chunkCount: d.ingest.chunkCount ?? 0,
    }))
    const nextSkip = skip + page.length
    const nextCursor =
      nextSkip < filtered.length
        ? Buffer.from(JSON.stringify({ skip: nextSkip }), 'utf8').toString('base64')
        : null
    return {
      content: [
        {
          type: 'text',
          text:
            `${page.length} document(s).` +
            (nextCursor ? ` ${filtered.length - nextSkip} more — pass cursor to continue.` : ''),
        },
      ],
      structuredContent: { documents: page, nextCursor, total: filtered.length },
    }
  }

  if (name === 'get_document') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanRead(meta, principal.username, principal.role)) throw new Error('forbidden')
    const text = await readText(id)
    return {
      content: [
        { type: 'text', text: `# ${meta.title}\n\n${text || '(no extracted text)'}` },
      ],
      structuredContent: { document: meta, text: text ?? '' },
    }
  }

  if (name === 'list_folder') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    await ensureUserVault(actingUser)
    const abs = resolveUserVault(actingUser, rel)
    const names = await readdir(abs)
    const items: Array<{ name: string; path: string; type: 'dir' | 'file'; bytes?: number }> = []
    for (const n of names) {
      if (n.startsWith('.')) continue
      const st = await stat(path.join(abs, n)).catch(() => null)
      if (!st) continue
      items.push({
        name: n,
        path: rel ? `${rel}/${n}` : n,
        type: st.isDirectory() ? 'dir' : 'file',
        bytes: st.isFile() ? st.size : undefined,
      })
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return {
      content: [{ type: 'text', text: `${items.length} entries in /${rel}` }],
      structuredContent: { path: rel, items },
    }
  }

  if (name === 'upload_text') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    if (!rel) throw new Error('path required')
    const content = String(args?.content ?? '')
    const tags = Array.isArray(args?.tags)
      ? args.tags.filter((t: any) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean)
      : []
    await ensureUserVault(actingUser)
    const abs = resolveUserVault(actingUser, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    const buffer = Buffer.from(content, 'utf8')
    await writeFile(abs, buffer)
    const filename = path.basename(rel)
    const mime = filename.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8'
    const now = Date.now()
    const existing = await findDocByPath(actingUser, rel)
    let meta: DocumentMeta
    if (existing) {
      meta = {
        ...existing,
        bytes: buffer.length,
        sha256: sha256Of(buffer),
        tags: tags.length ? tags : existing.tags,
        updatedAt: now,
        ingest: { status: 'pending', embedded: false },
      }
      await saveMeta(meta)
    } else {
      meta = {
        id: nanoid(),
        title: filename.replace(/\.[^.]+$/, ''),
        originalFilename: filename,
        mime,
        bytes: buffer.length,
        sha256: sha256Of(buffer),
        storageKey: rel,
        owner: actingUser,
        acl: { readers: [], editors: [] },
        publicExpiresAt: null,
        publicPasswordHash: null,
        tags,
        createdAt: now,
        updatedAt: now,
        ingest: { status: 'pending', embedded: false },
      }
      await saveMeta(meta)
    }
    // Re-ingest (text extract, chunk, embed) in the foreground so the
    // RPC reply reflects the final ingest status the agent can act on.
    meta = await ingestDocument(meta, buffer)
    await audit({
      actor: actingUser,
      action: 'mcp.upload_text',
      target: meta.id,
      meta: { path: rel, bytes: buffer.length },
    })
    return {
      content: [{ type: 'text', text: `Wrote ${rel} (${content.length} chars).` }],
      structuredContent: { document: meta },
    }
  }

  if (name === 'set_tags') {
    const id = String(args?.id ?? '')
    const tags: string[] = Array.isArray(args?.tags)
      ? args.tags.filter((t: any) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean)
      : []
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanEdit(meta, actingUser, token.role)) throw new Error('forbidden')
    const next: DocumentMeta = { ...meta, tags: Array.from(new Set(tags)), updatedAt: Date.now() }
    await saveMeta(next)
    await audit({
      actor: actingUser,
      action: 'mcp.set_tags',
      target: id,
      meta: { tags: next.tags },
    })
    return {
      content: [{ type: 'text', text: `Tags set: ${next.tags.join(', ') || '(none)'}` }],
      structuredContent: { document: next },
    }
  }

  if (name === 'pin') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    const owner = String(args?.owner ?? actingUser)
    let isFolder = false
    try {
      const abs = resolveUserVault(owner, rel)
      const st = await stat(abs)
      isFolder = st.isDirectory()
    } catch {
      throw new Error('target not found')
    }
    const pins = await addPin(actingUser, { owner, storageKey: rel, isFolder })
    return {
      content: [{ type: 'text', text: `Pinned ${rel}. ${pins.length} pin(s) total.` }],
      structuredContent: { pins },
    }
  }

  throw new Error(`unknown tool: ${name}`)
}

async function dispatch(token: ApiToken, msg: RpcRequest): Promise<RpcResponse | null> {
  const id = msg.id ?? null

  const isNotification = msg.id === undefined || msg.id === null
  switch (msg.method) {
    case 'initialize':
      return ok(id, SERVER_INFO)
    case 'initialized':
    case 'notifications/initialized':
      return isNotification ? null : ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    // First-class MCP server: even when we have no resources or
    // prompts to expose, return empty arrays so clients (Claude
    // Desktop, the MCP inspector) light up the panels and don't
    // log "method not supported" errors.
    case 'resources/list':
      return ok(id, { resources: [] })
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] })
    case 'prompts/list':
      return ok(id, { prompts: [] })
    case 'tools/call': {
      const name = msg.params?.name as string
      const args = msg.params?.arguments ?? {}
      try {
        const result = await handleCall(token, name, args)
        return ok(id, result)
      } catch (e: any) {
        return ok(id, {
          isError: true,
          content: [{ type: 'text', text: e?.message ?? String(e) }],
        })
      }
    }
    case 'ping':
      return ok(id, {})
    default:
      if (isNotification) return null
      return err(id, -32601, `method not found: ${msg.method}`)
  }
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = await authHeaderToken(req)
    if (!token) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        id: (req.body as any)?.id ?? null,
        error: { code: -32001, message: 'authentication required' },
      })
    }

    const body = req.body
    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((m) => dispatch(token, m as RpcRequest)))
      return reply.send(responses.filter((r): r is RpcResponse => r != null))
    }
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    const res = await dispatch(token, body as RpcRequest)
    if (res == null) return reply.code(204).send()
    return reply.send(res)
  })

  app.get('/mcp', async (_req, reply) => {
    return reply.code(405).send({ error: 'streaming not implemented; use POST /mcp' })
  })
}
