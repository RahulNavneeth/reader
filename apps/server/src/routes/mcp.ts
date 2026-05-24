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
import { dispatch as dispatchWebhook, markExpectedWrite } from '../services/webhooks.js'
import { config } from '../config.js'
import { addPin, listPins, removePin } from '../stores/pins.js'
import { moveToTrash } from '../stores/trash.js'
import { listVersions, readVersionText, snapshotVersion } from '../stores/versions.js'
import { rename } from 'node:fs/promises'
import { invalidateSearchCache } from '../services/search.js'
import { hashPassword as hashShareSecret } from '../lib/sharePassword.js'
import type { DocumentMeta, Role } from '../types.js'
import { withEditLock } from '../lib/editLock.js'
import { createRateLimit } from '../lib/rateLimit.js'
import { findAccessToken, touchAccessToken } from '../db/oauthRepo.js'
import { hasScope, scopeForTool } from '../services/oauth.js'
import { getUser } from '../stores/users.js'

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
      'Create or overwrite any text-based file in the token-owner vault — markdown, plain text, CSV, JSON, YAML, TOML, XML, HTML, log. Path is vault-relative (e.g. "notes/agent-output.md", "data/exports/run.csv"). The file is auto-ingested for search. For binary formats (PDF, images, docx, etc.) use upload_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative target path. Extension determines mime.' },
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
  {
    name: 'pdf_page_count',
    description:
      "Number of pages in a PDF document. Cheap probe before paging through with pdf_page_text.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document id (must be a PDF).' } },
      required: ['id'],
    },
  },
  {
    name: 'pdf_page_text',
    description:
      "Extract text from one page of a PDF (1-indexed). Use when you want a specific page without paying the cost of fetching the full extracted blob via get_document.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (must be a PDF).' },
        page: { type: 'number', description: '1-indexed page number.' },
      },
      required: ['id', 'page'],
    },
  },
  {
    name: 'csv_columns',
    description:
      "Discover a CSV file's schema — returns the column names, total row count, and a few sample rows. Cheap to call before csv_rows so you know which columns exist.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (must be a CSV/TSV).' },
        sampleCount: { type: 'number', description: 'Number of sample rows to return (default 3, max 20).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'csv_rows',
    description:
      "Read a window of rows from a CSV file as JSON objects, optionally projected down to a subset of columns. Default page size is 50, max 500.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (must be a CSV/TSV).' },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 500).' },
        offset: { type: 'number', description: 'Skip this many rows from the start (default 0).' },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional column projection. Unknown columns are silently skipped.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'csv_query',
    description:
      "Filter CSV rows by column-equals predicates (AND across multiple), then optionally project + paginate. Comparison is loose-equality after string coercion — fine for IDs, enums, exact-match name lookups. For ranges or partial matches, use csv_rows + client-side filtering.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (must be a CSV/TSV).' },
        where: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              equals: {},
            },
            required: ['column', 'equals'],
          },
          description: 'Array of {column, equals} predicates ANDed together.',
        },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 500).' },
        offset: { type: 'number', description: 'Skip this many MATCHING rows (default 0).' },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional column projection.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resolve_path',
    description:
      "Look up a document's metadata by its vault path. Returns null if no document exists at that path under the caller's vault. Bridge for tools that take docId when the agent only has a path.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path.' },
        owner: { type: 'string', description: 'Optional — defaults to the token user.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_pins',
    description:
      "List the calling user's pinned files + folders, newest first.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tags',
    description:
      "Enumerate every tag in use across documents the caller can read, with per-tag counts.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_versions',
    description:
      "List historical snapshots of a document (file content + meta at write-time). Use restore_version to roll back.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document id.' } },
      required: ['id'],
    },
  },
  {
    name: 'get_pdf_outline',
    description:
      "Return a PDF's bookmark / outline tree (chapter list) as a nested array. Empty array when the PDF has no embedded outline.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document id (must be a PDF).' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_document',
    description:
      "Move a document to Trash. Recoverable for 30 days, after which the daily sweep purges it. Use carefully — there's no MCP-side undo, the user has to restore from the web UI.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document id.' } },
      required: ['id'],
    },
  },
  {
    name: 'unpin',
    description:
      "Remove a pin from the calling user's sidebar. Inverse of `pin`.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the pinned item.' },
        owner: { type: 'string', description: 'Optional — defaults to the token user.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    description:
      "Move or rename a file in the vault. Updates the document's storageKey and any references. Refuses to overwrite an existing destination. For folder moves use the web UI.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id of the file to move.' },
        to: { type: 'string', description: 'New vault-relative path.' },
      },
      required: ['id', 'to'],
    },
  },
  {
    name: 'mkdir',
    description:
      "Create an empty folder in the token-owner vault. Parent folders are created as needed. No-op if the folder already exists.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative folder path.' } },
      required: ['path'],
    },
  },
  {
    name: 'set_visibility',
    description:
      "Toggle a document's public-link visibility. With `public:true`, anyone with the URL can read; pass `password` to gate it; pass `expiresInSeconds` to auto-expire. With `public:false`, link is revoked.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        public: { type: 'boolean', description: 'True to publish, false to revoke.' },
        password: { type: 'string', description: 'Optional gate password (only honored when public:true).' },
        expiresInSeconds: { type: 'number', description: 'Optional auto-expiry from now in seconds.' },
      },
      required: ['id', 'public'],
    },
  },
  {
    name: 'restore_version',
    description:
      "Roll a document back to a prior snapshot's content. The current version is snapshotted first, so the rollback itself is reversible. Markdown-only (we restore the text body, not arbitrary binary state).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        ts: { type: 'number', description: 'Snapshot timestamp from list_versions.' },
      },
      required: ['id', 'ts'],
    },
  },
  {
    name: 'rmdir',
    description:
      "Remove a folder from the token-owner vault. By default refuses non-empty folders (POSIX `rmdir` semantics). Pass `recursive: true` to trash every file inside (each goes to Trash, recoverable for 30 days) and then remove the folder itself.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative folder path.' },
        recursive: {
          type: 'boolean',
          description: 'When true, trash every file under the folder then remove it. Default false.',
        },
      },
      required: ['path'],
    },
  },
] as const

/**
 * Map an extension to a text-friendly mime for `upload_text`. Returns
 * `null` when the extension obviously names a binary format — the
 * caller surfaces a clear error pointing the agent at `upload_file`.
 * No extension at all falls back to `text/plain` so an agent writing
 * a `README` (sans `.md`) still works.
 */
function mimeForTextUpload(filename: string): string | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase()
  // Common binary formats — caller should use upload_file instead.
  const binary = new Set([
    'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'heif',
    'mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus',
    'mp4', 'mov', 'webm', 'mkv', 'avi',
    'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
    'exe', 'dmg', 'iso', 'pkg', 'deb', 'rpm',
    'wasm', 'so', 'dll', 'dylib',
    'ttf', 'otf', 'woff', 'woff2',
  ])
  if (binary.has(ext)) return null
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'text/markdown; charset=utf-8'
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'tsv':
      return 'text/tab-separated-values; charset=utf-8'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'yaml':
    case 'yml':
      return 'application/yaml; charset=utf-8'
    case 'toml':
      return 'application/toml; charset=utf-8'
    case 'xml':
      return 'application/xml; charset=utf-8'
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8'
    case 'css':
      return 'text/css; charset=utf-8'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
    case 'jsx':
      return 'text/plain; charset=utf-8'
    default:
      // Unknown extensions default to text/plain — covers `LICENSE`,
      // `README`, `Dockerfile`, `Makefile`, `.env`, custom log
      // formats, etc. The content is bytes the caller picked.
      return 'text/plain; charset=utf-8'
  }
}

function ok(id: number | string | null, result: any): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}
function err(id: number | string | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Unified principal for /mcp calls. Two flavors:
 *  - `api-token`: legacy static token from /api/account/tokens. No
 *    scope set; role drives what the token can do (admin tokens see
 *    everything, viewer/editor tokens scoped per ACL).
 *  - `oauth`: access token issued via /oauth/token after a consent
 *    flow. Carries an explicit `scopes` array; each tool call checks
 *    its required scope against this set. Role still comes from the
 *    underlying user record so existing ACL code keeps working.
 */
type McpPrincipal =
  | {
      kind: 'api-token'
      tokenId: string
      role: Role
      user: string
      /** Display label for the rate-limit bucket + audit. */
      rateBucketKey: string
    }
  | {
      kind: 'oauth'
      clientId: string
      role: Role
      user: string
      scopes: string[]
      rateBucketKey: string
    }

async function authHeaderToken(req: FastifyRequest): Promise<McpPrincipal | null> {
  const h = req.headers.authorization
  if (!h || !h.toLowerCase().startsWith('bearer ')) return null
  const secret = h.slice(7).trim()
  if (!secret) return null

  // OAuth tokens carry an `oat_` prefix per services/oauth.ts. Cheap
  // to discriminate so we don't have to probe both stores.
  if (secret.startsWith('oat_')) {
    const rec = findAccessToken(secret)
    if (!rec) return null
    const user = await getUser(rec.userId)
    if (!user || user.disabled) return null
    // Touch AFTER the disabled-user check so a token belonging to a
    // disabled user doesn't keep updating `last_used_at` and lying
    // to the Connected Apps page about being live.
    touchAccessToken(secret)
    return {
      kind: 'oauth',
      clientId: rec.clientId,
      role: user.role,
      user: user.username,
      scopes: rec.scopes,
      // Bucket per (client, user) so two simultaneous clients of the
      // same user don't share a budget.
      rateBucketKey: `oauth:${rec.clientId}:${rec.userId}`,
    }
  }

  const api = await findTokenBySecret(secret)
  if (!api) return null
  return {
    kind: 'api-token',
    tokenId: api.id,
    role: api.role,
    user: api.createdBy,
    rateBucketKey: `api:${api.id}`,
  }
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

async function handleCall(token: McpPrincipal, name: string, args: any) {
  // For read tools that go through ACL: synthetic principal where
  // role drives visibility. For write tools the `user` field is the
  // acting principal — for OAuth that's the consenting user; for an
  // API token it's whoever created the token.
  const tokenLabel = token.kind === 'api-token' ? `token:${token.tokenId}` : `oauth:${token.clientId}`
  const principal = { username: tokenLabel, role: token.role }
  const actingUser = token.user

  if (name === 'whoami') {
    const label =
      token.kind === 'api-token'
        ? `token=${token.tokenId}`
        : `oauth=${token.clientId} scopes=[${token.scopes.join(',')}]`
    return {
      content: [
        { type: 'text', text: `${label}, user=${actingUser}, role=${token.role}` },
      ],
      structuredContent: {
        ...(token.kind === 'api-token'
          ? { token: token.tokenId }
          : { clientId: token.clientId, scopes: token.scopes }),
        user: actingUser,
        role: token.role,
      },
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
    const filename = path.basename(rel)
    const mime = mimeForTextUpload(filename)
    if (!mime) {
      throw new Error(
        `upload_text only accepts text-based extensions (md, txt, csv, tsv, json, yaml, toml, xml, html, log, ...). ` +
          `Use upload_file for binary content like .${filename.split('.').pop() ?? 'pdf'}.`,
      )
    }
    // Tell the watcher this sha is an in-app write so its chokidar
    // fire doesn't double-dispatch the edit/upload webhook below.
    markExpectedWrite(abs, sha256Of(buffer))
    const isOverwrite = !!(await findDocByPath(actingUser, rel))
    await writeFile(abs, buffer)
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
    invalidateSearchCache()
    dispatchWebhook(
      isOverwrite
        ? { type: 'edit', path: rel, actor: actingUser, bytes: buffer.length, source: 'mcp' }
        : { type: 'upload', path: rel, actor: actingUser, bytes: buffer.length },
    ).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.upload_text',
      target: rel,
      meta: { docId: meta.id, bytes: buffer.length, overwrite: isOverwrite },
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
    markExpectedWrite(abs, sha256Of(buffer))
    const isOverwrite = !!(await findDocByPath(actingUser, rel))
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
    invalidateSearchCache()
    dispatchWebhook(
      isOverwrite
        ? { type: 'edit', path: rel, actor: actingUser, bytes: buffer.length, source: 'mcp' }
        : { type: 'upload', path: rel, actor: actingUser, bytes: buffer.length },
    ).catch(() => null)
    // Strip any embedded basic-auth creds from the source URL before
    // it lands in the audit log — passwords don't belong there.
    const { sanitizeUrlForLog } = await import('../lib/safeFetch.js')
    await audit({
      actor: actingUser,
      action: name === 'upload_from_url' ? 'mcp.upload_from_url' : 'mcp.upload_file',
      target: rel,
      meta: {
        docId: meta.id,
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
      target: next.storageKey,
      meta: { docId: id, tags: next.tags },
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
      // Tell the watcher this sha is an in-app write so its
      // chokidar fire doesn't double-dispatch the edit webhook.
      markExpectedWrite(abs, sha256Of(nextBuffer))
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
      // Use storageKey (path) as the audit target so the per-file
      // activity panel — which keys off path via /api/file/activity —
      // surfaces every MCP-driven edit alongside in-app edits. Keep
      // the docId on meta for cross-reference.
      await audit({
        actor: actingUser,
        action: auditAction,
        target: meta.storageKey,
        meta: { ...auditMeta, docId: id },
      })
      dispatchWebhook({
        type: 'edit',
        path: meta.storageKey,
        actor: actingUser,
        bytes: nextBuffer.length,
        source: 'mcp',
      }).catch(() => null)
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
    dispatchWebhook({
      type: 'pin',
      path: rel,
      actor: actingUser,
      pinned: true,
      isFolder,
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.pin',
      target: rel,
      meta: { owner, isFolder },
    })
    return {
      content: [{ type: 'text', text: `Pinned ${rel}. ${pins.length} pin(s) total.` }],
      structuredContent: { pins },
    }
  }

  if (name === 'pdf_page_count' || name === 'pdf_page_text') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanRead(meta, principal.username, principal.role)) throw new Error('forbidden')
    if (!meta.mime?.toLowerCase().includes('pdf')) {
      throw new Error(`not a PDF (mime ${meta.mime || 'unknown'})`)
    }
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    const { getPdfPageCount, getPdfPageText } = await import('../services/pdfPage.js')
    if (name === 'pdf_page_count') {
      const pageCount = await getPdfPageCount(abs)
      return {
        content: [{ type: 'text', text: `${meta.title}: ${pageCount} page${pageCount === 1 ? '' : 's'}` }],
        structuredContent: { docId: id, pageCount },
      }
    }
    const page = Number(args?.page)
    if (!Number.isInteger(page) || page < 1) throw new Error('page must be a positive integer')
    const r = await getPdfPageText(abs, page)
    return {
      content: [{ type: 'text', text: r.text || '(no extractable text on this page)' }],
      structuredContent: { docId: id, ...r },
    }
  }

  if (name === 'csv_columns' || name === 'csv_rows') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanRead(meta, principal.username, principal.role)) throw new Error('forbidden')
    // Accept any CSV/TSV via mime OR extension fallback — Reader's
    // upload pipeline sometimes lands plain text/csv files as
    // text/plain when the OS lacks a strong mime hint.
    const m = (meta.mime || '').toLowerCase()
    const ext = meta.storageKey.split('.').pop()?.toLowerCase() ?? ''
    const isCsv =
      m.includes('csv') ||
      m.includes('tab-separated') ||
      ext === 'csv' ||
      ext === 'tsv'
    if (!isCsv) throw new Error(`not a CSV (mime ${meta.mime || 'unknown'})`)
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    const { getCsvColumns, getCsvRows } = await import('../services/csvTable.js')
    if (name === 'csv_columns') {
      const sampleCount = Number.isFinite(args?.sampleCount)
        ? Math.min(20, Math.max(0, Number(args.sampleCount)))
        : 3
      const r = await getCsvColumns(abs, sampleCount)
      return {
        content: [
          {
            type: 'text',
            text:
              `${meta.title}: ${r.columns.length} columns × ${r.rowCount} rows.\n` +
              `Columns: ${r.columns.join(', ') || '(none)'}`,
          },
        ],
        structuredContent: { docId: id, ...r },
      }
    }
    // csv_rows
    const limit = Number.isFinite(args?.limit) ? Number(args.limit) : 50
    const offset = Number.isFinite(args?.offset) ? Number(args.offset) : 0
    const columns: string[] = Array.isArray(args?.columns)
      ? args.columns.filter((c: any) => typeof c === 'string')
      : []
    const r = await getCsvRows(abs, { limit, offset, columns: columns.length ? columns : undefined })
    return {
      content: [
        {
          type: 'text',
          text:
            `${meta.title}: returned ${r.rows.length} of ${r.totalRows} rows ` +
            `(offset ${offset}, ${r.hasMore ? 'more available' : 'end of table'}).`,
        },
      ],
      structuredContent: { docId: id, ...r },
    }
  }

  if (name === 'resolve_path') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    if (!rel) throw new Error('path required')
    const owner = String(args?.owner ?? actingUser)
    const docs = await listAllDocuments()
    const meta = docs.find((d) => d.storageKey === rel && d.owner === owner) ?? null
    if (meta && !userCanRead(meta, principal.username, principal.role)) {
      throw new Error('forbidden')
    }
    return {
      content: [
        {
          type: 'text',
          text: meta
            ? `Found ${meta.title} (id: ${meta.id}, owner: ${meta.owner})`
            : `No document at ${rel}`,
        },
      ],
      structuredContent: { document: meta },
    }
  }

  if (name === 'list_pins') {
    const pins = await listPins(actingUser)
    return {
      content: [{ type: 'text', text: `${pins.length} pin(s).` }],
      structuredContent: { pins },
    }
  }

  if (name === 'list_tags') {
    const docs = await listAllDocuments()
    const counts = new Map<string, number>()
    for (const d of docs) {
      if (!userCanRead(d, principal.username, principal.role)) continue
      for (const t of d.tags ?? []) {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    const tags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
    return {
      content: [
        { type: 'text', text: `${tags.length} distinct tag(s) across visible documents.` },
      ],
      structuredContent: { tags },
    }
  }

  if (name === 'list_versions') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanRead(meta, principal.username, principal.role)) throw new Error('forbidden')
    const versions = await listVersions(id)
    return {
      content: [
        {
          type: 'text',
          text:
            versions.length === 0
              ? 'No version snapshots.'
              : versions
                  .map(
                    (v) =>
                      `${new Date(v.ts).toISOString()}  ${v.bytes}b  ${v.sha256.slice(0, 8)}${v.hasText ? '  (text)' : ''}`,
                  )
                  .join('\n'),
        },
      ],
      structuredContent: { docId: id, versions },
    }
  }

  if (name === 'get_pdf_outline') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanRead(meta, principal.username, principal.role)) throw new Error('forbidden')
    if (!meta.mime?.toLowerCase().includes('pdf')) {
      throw new Error(`not a PDF (mime ${meta.mime || 'unknown'})`)
    }
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(abs)
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdf = await getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
    } as any).promise
    try {
      const raw = (await pdf.getOutline()) as any[] | null
      const flatten = (items: any[] | null): any[] =>
        !items
          ? []
          : items.map((it) => ({
              title: it.title,
              // Items without a destination (broken bookmarks) get null.
              hasDest: !!it.dest || !!it.url,
              url: it.url ?? undefined,
              children: flatten(it.items ?? null),
            }))
      const outline = flatten(raw)
      return {
        content: [
          {
            type: 'text',
            text:
              outline.length === 0
                ? 'PDF has no embedded outline.'
                : `${outline.length} top-level outline entr${outline.length === 1 ? 'y' : 'ies'}.`,
          },
        ],
        structuredContent: { docId: id, outline },
      }
    } finally {
      await pdf.cleanup()
      await pdf.destroy()
    }
  }

  if (name === 'csv_query') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanRead(meta, principal.username, principal.role)) throw new Error('forbidden')
    const m = (meta.mime || '').toLowerCase()
    const ext = meta.storageKey.split('.').pop()?.toLowerCase() ?? ''
    const isCsv =
      m.includes('csv') ||
      m.includes('tab-separated') ||
      ext === 'csv' ||
      ext === 'tsv'
    if (!isCsv) throw new Error(`not a CSV (mime ${meta.mime || 'unknown'})`)
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    const { getCsvRows } = await import('../services/csvTable.js')
    // Fetch ALL rows (no limit), then filter, project, paginate. The
    // CSV row cap is bounded by xlsx's parser; we trust the rate
    // limiter for abuse defense.
    const all = await getCsvRows(abs, { limit: 500_000, offset: 0 })
    const where: Array<{ column: string; equals: unknown }> = Array.isArray(args?.where)
      ? (args.where as Array<Record<string, unknown>>)
          .filter((w) => typeof w?.column === 'string' && 'equals' in w)
          .map((w) => ({ column: String(w.column), equals: w.equals }))
      : []
    const matched = where.length
      ? all.rows.filter((row) =>
          where.every((p) => {
            const v = (row as Record<string, unknown>)[p.column]
            if (v == null || p.equals == null) return v === p.equals
            return String(v) === String(p.equals)
          }),
        )
      : all.rows
    const limit = Math.min(Math.max(1, Number(args?.limit) || 50), 500)
    const offset = Math.max(0, Number(args?.offset) || 0)
    const page = matched.slice(offset, offset + limit)
    const cols: string[] = Array.isArray(args?.columns)
      ? args.columns.filter((c: any) => typeof c === 'string')
      : []
    const projected = cols.length
      ? page.map((row) => {
          const out: Record<string, unknown> = {}
          for (const c of cols) if (c in row) out[c] = (row as Record<string, unknown>)[c]
          return out
        })
      : page
    return {
      content: [
        {
          type: 'text',
          text: `Matched ${matched.length} of ${all.totalRows} rows; returning ${page.length}.`,
        },
      ],
      structuredContent: {
        docId: id,
        rows: projected,
        matched: matched.length,
        totalRows: all.totalRows,
        hasMore: offset + page.length < matched.length,
      },
    }
  }

  if (name === 'delete_document') {
    const id = String(args?.id ?? '')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanEdit(meta, actingUser, token.role)) throw new Error('forbidden')
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) throw new Error('file missing on disk')
    const entry = await moveToTrash({
      storageKey: meta.storageKey,
      vaultAbs: abs,
      docId: meta.id,
      owner: meta.owner,
      bytes: meta.bytes,
      trashedBy: actingUser,
    })
    // Drop the dangling SQLite row so resolve_path / list_documents
    // reflect the deletion. The trash manifest holds enough state to
    // recreate the doc on restore (separate from the live index).
    // This intentionally diverges from /api/file DELETE which leaves
    // a phantom row — that quirk is fine for the web UI (it reads
    // listings from disk) but confuses MCP agents that rely on the
    // index as the source of truth.
    const { deleteDocument } = await import('../stores/documents.js')
    await deleteDocument(meta.id).catch(() => null)
    invalidateSearchCache()
    dispatchWebhook({
      type: 'trash',
      path: meta.storageKey,
      actor: actingUser,
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.delete_document',
      target: meta.storageKey,
      meta: { docId: id, trashEntryId: entry.id },
    })
    return {
      content: [{ type: 'text', text: `Moved ${meta.storageKey} to Trash (recoverable for 30d).` }],
      structuredContent: { trashed: true, trashEntry: entry },
    }
  }

  if (name === 'unpin') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    if (!rel) throw new Error('path required')
    const owner = String(args?.owner ?? actingUser)
    const pins = await removePin(actingUser, owner, rel)
    // Best-effort isFolder probe — needed for the event schema but
    // the file may already be gone (e.g. unpinning a deleted item).
    // Falling back to false is fine; receivers care about the path.
    let isFolder = false
    try {
      const abs = resolveUserVault(owner, rel)
      const st = await stat(abs)
      isFolder = st.isDirectory()
    } catch {
      /* swallow */
    }
    dispatchWebhook({
      type: 'pin',
      path: rel,
      actor: actingUser,
      pinned: false,
      isFolder,
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.unpin',
      target: rel,
      meta: { owner },
    })
    return {
      content: [{ type: 'text', text: `Unpinned ${rel}. ${pins.length} pin(s) remain.` }],
      structuredContent: { pins },
    }
  }

  if (name === 'move_file') {
    const id = String(args?.id ?? '')
    const to = String(args?.to ?? '').replace(/^\/+|\/+$/g, '')
    if (!to) throw new Error('destination path required')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanEdit(meta, actingUser, token.role)) throw new Error('forbidden')
    if (meta.storageKey === to) throw new Error('source and destination are identical')
    const absFrom = resolveUserVault(meta.owner, meta.storageKey)
    const absTo = resolveUserVault(meta.owner, to)
    const dstStat = await stat(absTo).catch(() => null)
    if (dstStat) throw new Error('destination already exists')
    await mkdir(path.dirname(absTo), { recursive: true })
    await rename(absFrom, absTo)
    const next: DocumentMeta = {
      ...meta,
      storageKey: to,
      updatedAt: Date.now(),
    }
    await saveMeta(next)
    invalidateSearchCache()
    dispatchWebhook({
      type: 'move',
      path: to,
      actor: actingUser,
      from: meta.storageKey,
      to,
      isFolder: false,
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.move_file',
      target: to,
      meta: { docId: id, from: meta.storageKey },
    })
    return {
      content: [{ type: 'text', text: `Moved ${meta.storageKey} → ${to}` }],
      structuredContent: { document: next, from: meta.storageKey, to },
    }
  }

  if (name === 'mkdir') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    if (!rel) throw new Error('path required')
    await ensureUserVault(actingUser)
    const abs = resolveUserVault(actingUser, rel)
    await mkdir(abs, { recursive: true })
    dispatchWebhook({ type: 'mkdir', path: rel, actor: actingUser }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.mkdir',
      target: rel,
    })
    return {
      content: [{ type: 'text', text: `Created ${rel}.` }],
      structuredContent: { path: rel },
    }
  }

  if (name === 'set_visibility') {
    const id = String(args?.id ?? '')
    const isPublic = !!args?.public
    const password = typeof args?.password === 'string' ? args.password : undefined
    const expiresInSeconds =
      typeof args?.expiresInSeconds === 'number' ? args.expiresInSeconds : undefined
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanEdit(meta, actingUser, token.role)) throw new Error('forbidden')
    let publicExpiresAt: number | null = null
    if (isPublic && typeof expiresInSeconds === 'number') {
      publicExpiresAt = Date.now() + Math.max(60, Math.floor(expiresInSeconds)) * 1000
    }
    const publicPasswordHash =
      isPublic && password ? hashShareSecret(password) : null
    const next: DocumentMeta = {
      ...meta,
      public: isPublic,
      publicExpiresAt: isPublic ? publicExpiresAt : null,
      publicPasswordHash: isPublic ? publicPasswordHash : null,
      updatedAt: Date.now(),
    }
    await saveMeta(next)
    // Visibility changes the result set of public-vs-private search
    // for anonymous callers — flush the cache so the next anon
    // search sees the new state.
    invalidateSearchCache()
    dispatchWebhook({
      type: 'visibility',
      path: meta.storageKey,
      actor: actingUser,
      public: isPublic,
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.set_visibility',
      target: meta.storageKey,
      meta: { docId: id, public: isPublic, hasPassword: !!password },
    })
    return {
      content: [
        {
          type: 'text',
          text: isPublic
            ? `Published ${meta.storageKey}${password ? ' (password-gated)' : ''}.`
            : `Revoked public link for ${meta.storageKey}.`,
        },
      ],
      structuredContent: { document: next },
    }
  }

  if (name === 'restore_version') {
    const id = String(args?.id ?? '')
    const ts = Number(args?.ts)
    if (!Number.isFinite(ts)) throw new Error('ts required')
    const meta = await loadMeta(id)
    if (!meta) throw new Error('document not found')
    if (!userCanEdit(meta, actingUser, token.role)) throw new Error('forbidden')
    const text = await readVersionText(id, ts)
    if (text == null) throw new Error('version has no extractable text (binary snapshot)')
    // Snapshot the current state BEFORE overwriting so the restore
    // itself is reversible (one more entry shows up in list_versions).
    await snapshotVersion(id, {
      actor: actingUser,
      source: 'mcp',
      reason: 'restore_version',
    }).catch(() => null)
    const buffer = Buffer.from(text, 'utf8')
    const abs = resolveUserVault(meta.owner, meta.storageKey)
    markExpectedWrite(abs, sha256Of(buffer))
    await writeFile(abs, buffer)
    const next: DocumentMeta = {
      ...meta,
      bytes: buffer.length,
      sha256: sha256Of(buffer),
      updatedAt: Date.now(),
      ingest: { status: 'pending', embedded: false },
    }
    await saveMeta(next)
    const finalMeta = await ingestDocument(next, buffer)
    dispatchWebhook({
      type: 'edit',
      path: meta.storageKey,
      actor: actingUser,
      bytes: buffer.length,
      source: 'mcp',
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.restore_version',
      target: meta.storageKey,
      meta: { docId: id, restoredTs: ts },
    })
    return {
      content: [
        {
          type: 'text',
          text: `Restored ${meta.storageKey} to snapshot ${new Date(ts).toISOString()}.`,
        },
      ],
      structuredContent: { document: finalMeta, restoredTs: ts },
    }
  }

  if (name === 'rmdir') {
    const rel = String(args?.path ?? '').replace(/^\/+|\/+$/g, '')
    if (!rel) throw new Error('path required')
    const recursive = !!args?.recursive
    const abs = resolveUserVault(actingUser, rel)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isDirectory()) throw new Error('folder not found')

    // Walk the folder and trash every file in it. We collect first so
    // we can fail before any deletion if any file is forbidden (e.g.
    // shared-only docs the agent shouldn't be able to nuke).
    const { rm } = await import('node:fs/promises')
    const { deleteDocument } = await import('../stores/documents.js')
    const { deleteFolderMeta, listFolderMetas } = await import('../stores/folderMetas.js')

    type Item = { abs: string; rel: string }
    const files: Item[] = []
    const subdirs: Item[] = []
    async function walk(dirAbs: string, dirRel: string): Promise<void> {
      const entries = await readdir(dirAbs, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const childAbs = path.join(dirAbs, e.name)
        const childRel = dirRel ? `${dirRel}/${e.name}` : e.name
        if (e.isDirectory()) {
          subdirs.push({ abs: childAbs, rel: childRel })
          await walk(childAbs, childRel)
        } else if (e.isFile()) {
          files.push({ abs: childAbs, rel: childRel })
        }
      }
    }
    await walk(abs, rel)

    if (!recursive && (files.length > 0 || subdirs.length > 0)) {
      throw new Error(
        `folder not empty (${files.length} file(s), ${subdirs.length} subfolder(s)); pass recursive:true to trash + remove`,
      )
    }

    // ACL pre-check on every file, so we fail before any partial damage.
    const allDocs = await listAllDocuments()
    for (const f of files) {
      const meta = allDocs.find((d) => d.storageKey === f.rel && d.owner === actingUser)
      if (meta && !userCanEdit(meta, actingUser, token.role)) {
        throw new Error(`forbidden: cannot delete ${f.rel}`)
      }
    }

    // Trash each file. Reuses delete_document semantics so resolve_path
    // / list_documents stop reporting them. Fires one `trash` (or
    // `delete` on the EXDEV fallback) webhook per file so receivers
    // mirroring vault state see each child go individually, not just
    // a single batch `delete` for the folder.
    const trashedFiles: string[] = []
    for (const f of files) {
      const meta = allDocs.find((d) => d.storageKey === f.rel && d.owner === actingUser)
      const fstat = await stat(f.abs).catch(() => null)
      if (!fstat?.isFile()) continue
      let softDeleted = true
      try {
        await moveToTrash({
          storageKey: f.rel,
          vaultAbs: f.abs,
          docId: meta?.id,
          owner: actingUser,
          bytes: fstat.size,
          trashedBy: actingUser,
        })
      } catch {
        // Trash failed (e.g. cross-device EXDEV in a misconfigured
        // deploy) — fall through to hard remove so we don't leave the
        // folder in a half-deleted state. Receivers get `delete`
        // instead of `trash` so they don't expect a restore window.
        softDeleted = false
        await rm(f.abs, { force: true }).catch(() => null)
      }
      if (meta) await deleteDocument(meta.id).catch(() => null)
      trashedFiles.push(f.rel)
      dispatchWebhook(
        softDeleted
          ? { type: 'trash', path: f.rel, actor: actingUser }
          : { type: 'delete', path: f.rel, actor: actingUser },
      ).catch(() => null)
    }

    // Folder metas: clear out the dir's own meta + any nested folder
    // metas that no longer correspond to a real folder.
    const fms = await listFolderMetas(actingUser)
    for (const fm of fms) {
      if (fm.storageKey === rel || fm.storageKey.startsWith(rel + '/')) {
        await deleteFolderMeta(actingUser, fm.storageKey).catch(() => null)
      }
    }

    // Recursive rm to remove the directory tree (now empty of files
    // since they're all in trash).
    await rm(abs, { recursive: true, force: true })
    invalidateSearchCache()
    dispatchWebhook({
      type: 'delete',
      path: rel,
      actor: actingUser,
    }).catch(() => null)
    await audit({
      actor: actingUser,
      action: 'mcp.rmdir',
      target: rel,
      meta: { recursive, trashedFiles: trashedFiles.length },
    })
    return {
      content: [
        {
          type: 'text',
          text:
            trashedFiles.length === 0
              ? `Removed empty folder ${rel}.`
              : `Removed ${rel}. Trashed ${trashedFiles.length} file(s) (recoverable for 30 days).`,
        },
      ],
      structuredContent: { path: rel, recursive, trashedFiles },
    }
  }

  throw new Error(`unknown tool: ${name}`)
}

async function dispatch(token: McpPrincipal, msg: RpcRequest): Promise<RpcResponse | null> {
  const id = msg.id ?? null

  const isNotification = msg.id === undefined || msg.id === null
  switch (msg.method) {
    case 'initialize':
      return ok(id, SERVER_INFO)
    case 'initialized':
    case 'notifications/initialized':
      return isNotification ? null : ok(id, {})
    case 'tools/list': {
      // Annotate every tool with its required scope so spec-aware
      // clients can render a "you need scope X" hint when a call
      // would fail. Annotation is in `_meta` per MCP convention so
      // older clients ignore it without trouble.
      //
      // OAuth tokens additionally filter the catalog down to only
      // the tools the user actually consented to — there's no point
      // advertising a tool that will immediately return
      // -32003 insufficient_scope when called. Legacy API tokens
      // see the whole catalog (their authority is implicit in role,
      // not in a per-tool scope set).
      const enriched = TOOLS.map((t) => ({
        ...t,
        _meta: { scope: scopeForTool(t.name) },
      }))
      const visible =
        token.kind === 'api-token'
          ? enriched
          : enriched.filter((t) => hasScope(token.scopes, scopeForTool(t.name)))
      return ok(id, { tools: visible })
    }
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
      // OAuth tokens carry an explicit scope set; API tokens don't
      // (their authority is implicit in the role). Enforce here so
      // every tool branch in handleCall doesn't have to repeat the
      // check. Returns the JSON-RPC `insufficient_scope` shape from
      // the MCP spec so clients can prompt the user to re-consent.
      if (token.kind === 'oauth') {
        const required = scopeForTool(name)
        if (!hasScope(token.scopes, required)) {
          return err(id, -32003, `insufficient_scope: ${name} requires ${required}`)
        }
      }
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
      // Point spec-compliant clients at the resource-metadata doc so
      // they can discover the authorization server URL and start the
      // OAuth flow. Bearer realm follows RFC 9728 §5.1.
      return reply
        .code(401)
        .header(
          'WWW-Authenticate',
          `Bearer realm="reader-mcp", resource_metadata="${config.appUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource"`,
        )
        .send({
          jsonrpc: '2.0',
          id: (req.body as any)?.id ?? null,
          error: { code: -32001, message: 'authentication required' },
        })
    }

    // Throttle per principal. The bucket key already encodes whether
    // this is an API token or an OAuth client so two distinct
    // grants from the same user don't share a budget.
    const check = MCP_RATE_LIMIT.check(token.rateBucketKey)
    if (!check.allowed) {
      await audit({
        actor: token.user,
        action: 'mcp.throttled',
        target: token.rateBucketKey,
        meta: { retryAfter: check.retryAfterSeconds },
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
