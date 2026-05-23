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
import { config } from '../config.js'
import { addPin } from '../stores/pins.js'
import type { ApiToken, DocumentMeta } from '../types.js'
import { withEditLock } from '../lib/editLock.js'
import { createRateLimit } from '../lib/rateLimit.js'

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
    name: 'upload_from_url',
    description:
      "Fetch a file from an http(s) URL and store it in the token-owner vault. Server-side: avoids needing to base64 a binary into JSON. SSRF-guarded (no private/loopback addresses, no redirects). Subject to the same upload size limit as multipart uploads.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative target path. Extension determines mime.' },
        url: { type: 'string', description: 'Public http or https URL.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['path', 'url'],
    },
  },
  {
    name: 'upload_file',
    description:
      "Upload binary content directly as base64. Use when the file isn't reachable via a URL (e.g. an agent-generated image or PDF). Subject to the same upload size limit as multipart uploads.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative target path.' },
        content: { type: 'string', description: 'Base64-encoded file bytes.' },
        mime: { type: 'string', description: 'Optional content-type hint; otherwise inferred from the path.' },
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
    name: 'get_outline',
    description:
      "Return a markdown document's heading tree as a flat list ({level, heading, slug, line}). Cheap structural overview before targeted edits — no need to fetch the full document just to know what sections exist.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document id.' } },
      required: ['id'],
    },
  },
  {
    name: 'get_section',
    description:
      "Return the body text under a specific heading in a markdown document. Heading text is matched case-sensitively; the section runs until the next sibling-or-ancestor heading (so a section includes its sub-sections).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        heading: { type: 'string', description: 'Exact heading text (no leading #).' },
      },
      required: ['id', 'heading'],
    },
  },
  {
    name: 'get_chunk',
    description:
      "Return one chunk's text by index. Chunks are the ingest-time splits search_knowledge ranks against; pair this with search_knowledge results (whose `chunkIdx` you can pass back here) to read the exact passage that matched.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        idx: { type: 'number', description: 'Zero-based chunk index.' },
      },
      required: ['id', 'idx'],
    },
  },
  {
    name: 'replace_section',
    description:
      "Replace the body under a heading with new content. The heading line itself is preserved. Use this instead of full-overwrite upload_text when you only need to change one section.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        heading: { type: 'string', description: 'Exact heading text (no leading #).' },
        content: { type: 'string', description: 'New body text. Do not include the heading line.' },
      },
      required: ['id', 'heading', 'content'],
    },
  },
  {
    name: 'insert_after',
    description:
      "Insert content immediately after the matched section (after its body and any nested sub-sections). Useful for adding a new sibling section.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        heading: { type: 'string', description: 'Exact heading text to anchor against.' },
        content: { type: 'string', description: 'Content to insert (typically starts with a `## New Heading` line).' },
      },
      required: ['id', 'heading', 'content'],
    },
  },
  {
    name: 'delete_section',
    description:
      "Remove a heading and its body (including nested sub-sections). Use carefully — this is destructive.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        heading: { type: 'string', description: 'Exact heading text.' },
      },
      required: ['id', 'heading'],
    },
  },
  {
    name: 'append_text',
    description: 'Append content to the end of a markdown document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        content: { type: 'string' },
      },
      required: ['id', 'content'],
    },
  },
  {
    name: 'prepend_text',
    description: 'Prepend content to the start of a markdown document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        content: { type: 'string' },
      },
      required: ['id', 'content'],
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

// Per-doc edit serialisation lives in lib/editLock.ts so the chat
// apply-edit endpoint shares the same map — a concurrent agent
// edit + chat edit on the same doc serialise together.

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
    // Snapshot the pre-edit state of an existing doc before
    // overwriting. The watcher would otherwise race saveMeta and
    // snapshot the new state instead. snapshotVersion dedupes by
    // sha256 so this is safe even if the watcher also fires.
    {
      const existingForSnap = await findDocByPath(actingUser, rel)
      if (existingForSnap) {
        const { snapshotVersion } = await import('../stores/versions.js')
        await snapshotVersion(existingForSnap.id, {
          actor: actingUser,
          source: 'mcp',
          reason: 'upload',
        }).catch(() => null)
      }
    }
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

  if (name === 'upload_from_url' || name === 'upload_file') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    if (!rel) throw new Error('path required')
    const tags = Array.isArray(args?.tags)
      ? (args.tags as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
      : []

    // Pull the bytes via the tool-specific path, then run the shared
    // post-write pipeline. Both flows share size cap + magic-byte
    // validation so an `image/jpeg` claim with HTML bytes is caught
    // either way.
    let buffer: Buffer
    let sourceMime: string | undefined
    let sourceUrl: string | undefined
    if (name === 'upload_from_url') {
      const url = String(args?.url ?? '').trim()
      if (!url) throw new Error('url required')
      const { safeFetch } = await import('../lib/safeFetch.js')
      const res = await safeFetch(url, {
        maxBytes: config.ingest.maxFileBytes,
        timeoutMs: 30_000,
      })
      buffer = res.buffer
      sourceMime = res.contentType
      sourceUrl = res.finalUrl
    } else {
      // upload_file — base64 in payload. JSON-RPC's transport is
      // text-only, so anything that needs literal binary bytes must
      // come through this path.
      let raw = String(args?.content ?? '')
      if (!raw) throw new Error('content required')
      // Agents (and many copy-paste flows) hand over a full data URI
      // like `data:image/png;base64,iVBORw0...`. Strip that prefix
      // and inherit the declared MIME when the caller didn't supply one.
      const { parseDataUri } = await import('../lib/safeFetch.js')
      const parsed = parseDataUri(raw)
      if (parsed) {
        if (!sourceMime && parsed.mime) sourceMime = parsed.mime
        raw = parsed.data
      }
      // Reject obviously non-base64 input early — `Buffer.from` is
      // permissive and would silently drop unknown chars.
      if (!/^[A-Za-z0-9+/=\s]*$/.test(raw)) {
        throw new Error('content must be valid base64')
      }
      try {
        buffer = Buffer.from(raw, 'base64')
      } catch {
        throw new Error('content must be valid base64')
      }
      if (buffer.length === 0) {
        throw new Error('decoded content is empty (was the base64 valid?)')
      }
      if (buffer.length > config.ingest.maxFileBytes) {
        throw new Error(
          `decoded content exceeds the ${config.ingest.maxFileBytes}-byte upload cap`,
        )
      }
      const declared = args?.mime
      if (typeof declared === 'string') sourceMime = declared
    }

    // Magic-byte sanity check. uploadGuard sniffs the leading bytes
    // and refuses if the file's actual format doesn't match the
    // claimed extension — same protection multipart uploads get.
    const { validateUpload } = await import('../lib/uploadGuard.js')
    const filename = path.basename(rel)
    const guard = await validateUpload(buffer, filename, sourceMime)
    if (!guard.ok) {
      throw new Error(`refusing upload: ${guard.reason}`)
    }

    await ensureUserVault(actingUser)
    const abs = resolveUserVault(actingUser, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    // Snapshot pre-write content if this is an overwrite. Same
    // race-avoidance reason as the other MCP write paths.
    {
      const existingForSnap = await findDocByPath(actingUser, rel)
      if (existingForSnap) {
        const { snapshotVersion } = await import('../stores/versions.js')
        await snapshotVersion(existingForSnap.id, {
          actor: actingUser,
          source: 'mcp',
          reason: 'upload',
        }).catch(() => null)
      }
    }
    await writeFile(abs, buffer)

    const now = Date.now()
    const existing = await findDocByPath(actingUser, rel)
    let meta: DocumentMeta
    if (existing) {
      meta = {
        ...existing,
        bytes: buffer.length,
        sha256: sha256Of(buffer),
        mime: guard.mime || existing.mime,
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
        mime: guard.mime || sourceMime || 'application/octet-stream',
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
    meta = await ingestDocument(meta, buffer)
    // Strip any embedded basic-auth creds from the source URL before
    // it lands in the audit log — passwords don't belong there.
    const { sanitizeUrlForLog } = await import('../lib/safeFetch.js')
    await audit({
      actor: actingUser,
      action: name === 'upload_from_url' ? 'mcp.upload_from_url' : 'mcp.upload_file',
      target: meta.id,
      meta: {
        path: rel,
        bytes: buffer.length,
        mime: meta.mime,
        ...(sourceUrl ? { url: sanitizeUrlForLog(sourceUrl) } : {}),
      },
    })
    return {
      content: [
        {
          type: 'text',
          text:
            name === 'upload_from_url'
              ? `Fetched and stored ${rel} (${buffer.length} bytes, ${meta.mime})`
              : `Wrote ${rel} (${buffer.length} bytes, ${meta.mime})`,
        },
      ],
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

  // -------- Granular markdown edits --------
  //
  // All eight tools share the same authz + persistence skeleton:
  //   1. Load meta by id, check edit grant.
  //   2. Resolve the doc's on-disk path and read its current text.
  //   3. Apply the structural transformation (lib/mdx.ts).
  //   4. Write the new text back to disk, save meta, re-ingest, audit.
  //
  // Read-only variants (`get_outline`, `get_section`) skip steps 3-4
  // and don't audit.
  //
  // Heading matching is case-sensitive exact-match by design — fuzzy
  // matching here would surprise agents in subtle ways. If multiple
  // headings have the same text, the first is used; callers should
  // disambiguate by adding context to the heading text.

  if (name === 'get_chunk') {
    const id = String(args?.id ?? '')
    const idx = Number(args?.idx)
    if (!id) throw new Error('id required')
    if (!Number.isInteger(idx) || idx < 0) throw new Error('idx must be a non-negative integer')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    const { userCanRead } = await import('../stores/documents.js')
    if (!userCanRead(meta, actingUser, token.role)) throw new Error('forbidden')
    const { getChunk, chunkCount } = await import('../db/chunksRepo.js')
    const chunk = getChunk(id, idx)
    if (!chunk) {
      const total = chunkCount(id)
      throw new Error(
        total === 0
          ? `document has no chunks yet (ingest may still be running)`
          : `chunk index out of range (got ${idx}, document has ${total} chunk${total === 1 ? '' : 's'} 0..${total - 1})`,
      )
    }
    return {
      content: [{ type: 'text', text: chunk.text }],
      structuredContent: { idx: chunk.idx, text: chunk.text },
    }
  }

  if (
    name === 'get_outline' ||
    name === 'get_section' ||
    name === 'replace_section' ||
    name === 'insert_after' ||
    name === 'delete_section' ||
    name === 'append_text' ||
    name === 'prepend_text'
  ) {
    const id = String(args?.id ?? '')
    if (!id) throw new Error('id required')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')

    // get_* are read-only: only read ACL needed. The other five are
    // mutations and require edit grant.
    const isRead = name === 'get_outline' || name === 'get_section'
    if (isRead) {
      const { userCanRead } = await import('../stores/documents.js')
      if (!userCanRead(meta, actingUser, token.role)) throw new Error('forbidden')
    } else {
      if (!userCanEdit(meta, actingUser, token.role)) throw new Error('forbidden')
    }

    // Heuristic: granular edits only make sense for markdown-ish
    // documents. Refuse on binary mimes so an agent doesn't acci-
    // dentally corrupt a PDF by trying to insert a section.
    const mime = (meta.mime || '').toLowerCase()
    const isMarkdownish =
      mime.startsWith('text/') ||
      mime.includes('markdown') ||
      mime === 'application/json' ||
      /\.(md|markdown|mdx|txt)$/i.test(meta.originalFilename)
    if (!isMarkdownish) {
      throw new Error(
        `granular edits require a text/markdown document (this one is ${mime || 'unknown'})`,
      )
    }

    // Always resolve against the doc's true owner. Using actingUser
    // would point at the editor's vault for a cross-owner shared
    // doc — wrong file, or worse, a phantom write under a path that
    // doesn't exist in their namespace.
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    const { readFile, writeFile } = await import('node:fs/promises')
    let buffer: Buffer
    try {
      buffer = await readFile(abs)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(`document file is missing on disk (path: ${meta.storageKey})`)
      }
      if (code === 'EACCES') {
        throw new Error(`cannot read document on disk (path: ${meta.storageKey})`)
      }
      throw e
    }
    const text = buffer.toString('utf8')

    const mdx = await import('../lib/mdx.js')

    if (name === 'get_outline') {
      const out = mdx.outlineForTool(text)
      return {
        content: [
          {
            type: 'text',
            text:
              out.length === 0
                ? '(no headings)'
                : out
                    .map(
                      (h) =>
                        `${'  '.repeat(Math.max(0, h.level - 1))}${'#'.repeat(h.level)} ${h.heading}  (line ${h.line})`,
                    )
                    .join('\n'),
          },
        ],
        structuredContent: { outline: out },
      }
    }
    if (name === 'get_section') {
      const heading = String(args?.heading ?? '')
      if (!heading) throw new Error('heading required')
      const body = mdx.getSection(text, heading)
      if (body == null) throw new Error(`heading not found: "${heading}"`)
      return {
        content: [{ type: 'text', text: body }],
        structuredContent: { heading, body },
      }
    }

    // Mutations: serialize per-docId so concurrent edits don't race
    // on the read → write window. Inside the lock we re-read the
    // file (in case a prior holder mutated it) before applying the
    // edit, so we never overwrite someone else's just-committed
    // change.
    return await withEditLock(id, async () => {
      let currentBuffer: Buffer
      try {
        currentBuffer = await readFile(abs)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          throw new Error(`document file is missing on disk (path: ${meta.storageKey})`)
        }
        throw e
      }
      const currentText = currentBuffer.toString('utf8')

      let nextText: string
      let auditAction = ''
      let auditMeta: Record<string, unknown> = { path: meta.storageKey }
      if (name === 'replace_section') {
        const heading = String(args?.heading ?? '')
        const content = String(args?.content ?? '')
        if (!heading) throw new Error('heading required')
        nextText = mdx.replaceSection(currentText, heading, content)
        auditAction = 'mcp.replace_section'
        auditMeta = { ...auditMeta, heading, bytes: content.length }
      } else if (name === 'insert_after') {
        const heading = String(args?.heading ?? '')
        const content = String(args?.content ?? '')
        if (!heading) throw new Error('heading required')
        if (!content) throw new Error('content required')
        nextText = mdx.insertAfter(currentText, heading, content)
        auditAction = 'mcp.insert_after'
        auditMeta = { ...auditMeta, heading, bytes: content.length }
      } else if (name === 'delete_section') {
        const heading = String(args?.heading ?? '')
        if (!heading) throw new Error('heading required')
        nextText = mdx.deleteSection(currentText, heading)
        auditAction = 'mcp.delete_section'
        auditMeta = { ...auditMeta, heading }
      } else if (name === 'append_text') {
        const content = String(args?.content ?? '')
        if (!content) throw new Error('content required')
        nextText = mdx.appendText(currentText, content)
        auditAction = 'mcp.append_text'
        auditMeta = { ...auditMeta, bytes: content.length }
      } else {
        // name === 'prepend_text'
        const content = String(args?.content ?? '')
        if (!content) throw new Error('content required')
        nextText = mdx.prependText(currentText, content)
        auditAction = 'mcp.prepend_text'
        auditMeta = { ...auditMeta, bytes: content.length }
      }

      const nextBuffer = Buffer.from(nextText, 'utf8')
      // Snapshot the pre-edit doc before applying this granular
      // MCP edit. snapshotVersion dedupes by sha256 so the
      // watcher's later fire on the file change is a no-op.
      {
        const { snapshotVersion } = await import('../stores/versions.js')
        await snapshotVersion(meta.id, {
          actor: actingUser,
          source: 'mcp',
          reason: auditAction,
        }).catch(() => null)
      }
      await writeFile(abs, nextBuffer)
      const nextMeta: DocumentMeta = {
        ...meta,
        bytes: nextBuffer.length,
        sha256: sha256Of(nextBuffer),
        updatedAt: Date.now(),
        ingest: { status: 'pending', embedded: false },
      }
      await saveMeta(nextMeta)
      const finalMeta = await ingestDocument(nextMeta, nextBuffer)
      await audit({ actor: actingUser, action: auditAction, target: id, meta: auditMeta })
      return {
        content: [
          {
            type: 'text',
            text: `Updated ${meta.storageKey} (${nextBuffer.length} bytes)`,
          },
        ],
        structuredContent: { document: finalMeta },
      }
    })
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

/**
 * Per-MCP-token rate limiter. Keyed on the token id so multiple
 * agents / workflows sharing one IP don't interfere, AND so a
 * single compromised token can be killed by deleting it rather
 * than blocking the whole IP. Bucket is generous on bursts
 * (legitimate agents fan-out reads when crawling a doc set) but
 * capped on sustained rate so a runaway loop can't pin the server.
 *
 * Counts the OUTER POST /mcp call. Batched JSON-RPC arrays count
 * as one call regardless of how many sub-requests they contain —
 * we don't want to penalize the protocol's batching affordance.
 *
 * For each rate-limit hit we also emit an audit entry so the user
 * can see in their activity log that a token tripped the limiter
 * and trace it back to which agent.
 */
const MCP_RATE_LIMIT = createRateLimit({
  // 60-token burst (one a second for a minute, plus a buffer for
  // multiget patterns) with 5/sec sustained refill — that's 18,000
  // calls/hour at saturation, more than any honest agent needs.
  capacity: 60,
  refillPerSecond: 5,
})

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

    // Throttle per token. Token id is the bucket key — same token
    // from many IPs gets one bucket; many tokens from one IP get
    // independent buckets.
    const check = MCP_RATE_LIMIT.check(token.id)
    if (!check.allowed) {
      await audit({
        actor: token.createdBy,
        action: 'mcp.throttled',
        target: token.id,
        meta: { retryAfter: check.retryAfterSeconds, tokenName: token.name },
      }).catch(() => null)
      return reply
        .code(429)
        .header('Retry-After', String(check.retryAfterSeconds))
        .send({
          jsonrpc: '2.0',
          id: (req.body as any)?.id ?? null,
          error: {
            code: -32002,
            message: 'rate limit exceeded; retry later',
            data: { retryAfterSeconds: check.retryAfterSeconds },
          },
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

/** Test hook — clears the rate-limit bucket so tests don't trip
 *  it from prior runs in the same process. */
export function _resetMcpRateLimitForTest() {
  MCP_RATE_LIMIT.reset()
}
