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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { findTokenBySecret } from '../stores/tokens.js'
import { listAllDocuments, loadMeta, readText, userCanRead } from '../stores/documents.js'
import { searchKnowledge } from '../services/search.js'
import type { ApiToken } from '../types.js'

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
  serverInfo: { name: 'reader-knowledge', version: '0.2.0' },
  capabilities: { tools: {} },
}

const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search the user\'s document corpus with hybrid lexical + semantic search. Returns ranked snippets across documents the API token has access to.',
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
    description: 'List all documents accessible to the API token, with metadata (title, tags, mime, size, status).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 50, minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: 'get_document',
    description: 'Fetch a document\'s full extracted plaintext by id, plus metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (nanoid).' },
      },
      required: ['id'],
    },
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

async function handleCall(token: ApiToken, name: string, args: any) {
  // The token's role acts as the principal for ACL checks.
  const principal = { username: `token:${token.id}`, role: token.role }

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
                .map((h, i) => `${i + 1}. [${h.title}] (${h.source}, score=${h.score.toFixed(4)})\n${h.snippet}\n  doc:${h.docId}${h.chunkIdx != null ? ` chunk:${h.chunkIdx}` : ''}`)
                .join('\n\n'),
        },
      ],
      structuredContent: { hits },
    }
  }

  if (name === 'list_documents') {
    const limit = Number.isFinite(args?.limit) ? Math.min(500, Math.max(1, Number(args.limit))) : 50
    const docs = (await listAllDocuments())
      .filter((d) => userCanRead(d, principal.username, principal.role))
      .slice(0, limit)
      .map((d) => ({
        id: d.id,
        title: d.title,
        mime: d.mime,
        bytes: d.bytes,
        tags: d.tags,
        createdAt: d.createdAt,
        ingestStatus: d.ingest.status,
        chunkCount: d.ingest.chunkCount ?? 0,
      }))
    return {
      content: [{ type: 'text', text: `${docs.length} document(s).` }],
      structuredContent: { documents: docs },
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
        {
          type: 'text',
          text: `# ${meta.title}\n\n${text || '(no extracted text)'}`,
        },
      ],
      structuredContent: { document: meta, text: text ?? '' },
    }
  }

  throw new Error(`unknown tool: ${name}`)
}

async function dispatch(token: ApiToken, msg: RpcRequest): Promise<RpcResponse | null> {
  const id = msg.id ?? null

  // Notifications (no id) get no response.
  const isNotification = msg.id === undefined || msg.id === null
  switch (msg.method) {
    case 'initialize':
      return ok(id, SERVER_INFO)
    case 'initialized':
    case 'notifications/initialized':
      return isNotification ? null : ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
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

  // GET on /mcp is reserved by the spec for SSE streams; we don't open them yet,
  // so respond with 405 for clarity.
  app.get('/mcp', async (_req, reply) => {
    return reply.code(405).send({ error: 'streaming not implemented; use POST /mcp' })
  })
}
