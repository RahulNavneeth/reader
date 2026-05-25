/**
 * OAuth 2.1 helpers: token minting, PKCE verification, scope set
 * helpers, and the canonical per-tool scope catalog used by the
 * consent UI and the MCP scope enforcer.
 *
 * Scope naming: `tool:<tool_name>` for each MCP tool, plus `mcp`
 * as a meta scope that grants ALL tool scopes (a convenience for
 * clients that want everything without listing 18 strings).
 */
import crypto from 'node:crypto'

// ── Scope catalog ───────────────────────────────────────────────────

/**
 * Per-tool scopes, one entry per MCP tool. The label + description
 * power the consent UI; the `write` flag drives the recommended-
 * default behavior (writes default to UNCHECKED so a careless click
 * doesn't hand over destructive privileges).
 */
export type ScopeDef = {
  scope: string
  label: string
  description: string
  write: boolean
}

export const TOOL_SCOPES: ScopeDef[] = [
  { scope: 'tool:search_knowledge', label: 'Search',          description: 'Semantic + keyword search across the vault.', write: false },
  { scope: 'tool:list_documents',   label: 'List documents',  description: 'Enumerate files with optional path/tag filters.', write: false },
  { scope: 'tool:get_document',     label: 'Read document',   description: 'Fetch a single document’s full text + metadata.', write: false },
  { scope: 'tool:list_folder',      label: 'List folder',     description: 'Browse a folder’s direct children.', write: false },
  { scope: 'tool:get_outline',      label: 'Outline',         description: 'Heading outline of a markdown document.', write: false },
  { scope: 'tool:get_section',      label: 'Read section',    description: 'Fetch one section of a markdown document.', write: false },
  { scope: 'tool:get_chunk',        label: 'Read chunk',      description: 'Fetch one chunk by id (after a search hit).', write: false },
  { scope: 'tool:whoami',           label: 'Identify',        description: 'See the calling user’s username + role.', write: false },
  { scope: 'tool:upload_text',      label: 'Upload text',     description: 'Create or overwrite a text file in the vault.', write: true },
  { scope: 'tool:upload_from_url',  label: 'Upload from URL', description: 'Fetch a remote URL and import it as a document.', write: true },
  { scope: 'tool:upload_file',      label: 'Upload file',     description: 'Upload a base64-encoded file into the vault.', write: true },
  { scope: 'tool:set_tags',         label: 'Set tags',        description: 'Replace the tag set on a document.', write: true },
  { scope: 'tool:replace_section',  label: 'Replace section', description: 'Rewrite one section of a markdown document.', write: true },
  { scope: 'tool:insert_after',     label: 'Insert after',    description: 'Insert content after a section heading.', write: true },
  { scope: 'tool:append_to_section',label: 'Append to section', description: "Append content at the end of a section's body, before any nested sub-section.", write: true },
  { scope: 'tool:delete_section',   label: 'Delete section',  description: 'Remove a section from a markdown document.', write: true },
  { scope: 'tool:append_text',      label: 'Append text',     description: 'Append text to the end of a document.', write: true },
  { scope: 'tool:prepend_text',     label: 'Prepend text',    description: 'Prepend text to the start of a document.', write: true },
  { scope: 'tool:pin',              label: 'Pin / unpin',     description: 'Pin or unpin a document to the sidebar.', write: true },
  { scope: 'tool:pdf_page_count',   label: 'PDF page count',  description: 'Count pages in a PDF document.', write: false },
  { scope: 'tool:pdf_page_text',    label: 'PDF page text',   description: 'Extract text from one page of a PDF.', write: false },
  { scope: 'tool:csv_columns',      label: 'CSV schema',      description: 'List columns + sample rows from a CSV.', write: false },
  { scope: 'tool:csv_rows',         label: 'CSV rows',        description: 'Read a window of CSV rows as JSON.', write: false },
  { scope: 'tool:csv_query',        label: 'CSV query',       description: 'Filter CSV rows by column-equals predicates.', write: false },
  { scope: 'tool:resolve_path',     label: 'Resolve path',    description: 'Look up a document’s metadata by its vault path.', write: false },
  { scope: 'tool:list_pins',        label: 'List pins',       description: 'List the calling user’s sidebar pins.', write: false },
  { scope: 'tool:list_tags',        label: 'List tags',       description: 'Enumerate every tag in use across visible documents.', write: false },
  { scope: 'tool:list_versions',    label: 'List versions',   description: 'List historical snapshots of a document.', write: false },
  { scope: 'tool:get_pdf_outline',  label: 'PDF bookmarks',   description: 'Return a PDF document’s bookmark / outline tree.', write: false },
  { scope: 'tool:delete_document',  label: 'Delete document', description: 'Move a document to Trash (recoverable for 30 days).', write: true },
  { scope: 'tool:unpin',            label: 'Unpin',           description: 'Remove a pin from the sidebar.', write: true },
  { scope: 'tool:move_file',        label: 'Move / rename',   description: 'Move or rename a file in the vault.', write: true },
  { scope: 'tool:mkdir',            label: 'Create folder',   description: 'Create an empty folder in the vault.', write: true },
  { scope: 'tool:set_visibility',   label: 'Set visibility',  description: 'Toggle a document’s public link (with optional password + expiry).', write: true },
  { scope: 'tool:restore_version',  label: 'Restore version', description: 'Roll a document back to a prior snapshot.', write: true },
  { scope: 'tool:rmdir',            label: 'Remove folder',   description: 'Remove an empty folder, or recursively trash its contents.', write: true },
]

const TOOL_SCOPE_SET = new Set(TOOL_SCOPES.map((s) => s.scope))

/** Map of tool name → required scope. The MCP dispatcher checks this
 *  on every tool call. The mapping is the IDENTITY function
 *  (`tool:<name>`) but lives here so the source of truth is one
 *  place. */
export function scopeForTool(toolName: string): string {
  return `tool:${toolName}`
}

/** Returns true if the token's scope set covers the required scope.
 *  Honors the meta `mcp` scope as a wildcard over `tool:*`. */
export function hasScope(tokenScopes: string[], required: string): boolean {
  if (tokenScopes.includes(required)) return true
  if (required.startsWith('tool:') && tokenScopes.includes('mcp')) return true
  return false
}

/** Filter caller-requested scopes down to the ones we recognize. The
 *  authorize handler uses this to reject unknown scopes loudly rather
 *  than silently dropping them — a client asking for `tool:foo` that
 *  doesn't exist needs to know. */
export function validateScopes(requested: string[]): { ok: string[]; unknown: string[] } {
  const ok: string[] = []
  const unknown: string[] = []
  for (const s of requested) {
    if (s === 'mcp' || TOOL_SCOPE_SET.has(s)) ok.push(s)
    else unknown.push(s)
  }
  return { ok, unknown }
}

/** Expand `mcp` to the full tool-scope set, deduped. Used when the
 *  client requested the meta scope and we want the granted scope list
 *  to be explicit on the consent screen + access-token row. */
export function expandScopes(scopes: string[]): string[] {
  const out = new Set<string>()
  for (const s of scopes) {
    if (s === 'mcp') {
      for (const t of TOOL_SCOPES) out.add(t.scope)
    } else {
      out.add(s)
    }
  }
  return Array.from(out).sort()
}

// ── Token generation ───────────────────────────────────────────────

/** Opaque, URL-safe, 256-bit-of-entropy tokens. Prefix lets the
 *  /mcp validator route to OAuth vs. legacy API-token lookup
 *  without trial-decryption. */
export function generateAccessToken(): string {
  return 'oat_' + crypto.randomBytes(32).toString('base64url')
}

export function generateRefreshToken(): string {
  return 'ort_' + crypto.randomBytes(32).toString('base64url')
}

export function generateAuthCode(): string {
  return 'oac_' + crypto.randomBytes(24).toString('base64url')
}

export function generateClientId(): string {
  return 'oclient_' + crypto.randomBytes(16).toString('base64url')
}

export function generateClientSecret(): string {
  return 'osec_' + crypto.randomBytes(32).toString('base64url')
}

// ── PKCE ───────────────────────────────────────────────────────────

/** S256 verifier: BASE64URL(SHA-256(verifier)) must equal challenge.
 *  Per RFC 7636 §4.6. Plain method is rejected entirely (PKCE
 *  required policy, OAuth 2.1). */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false
  if (verifier.length < 43 || verifier.length > 128) return false
  const hash = crypto.createHash('sha256').update(verifier).digest()
  const expected = hash.toString('base64url')
  if (expected.length !== challenge.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(challenge))
}

// ── TTLs ───────────────────────────────────────────────────────────

/** One hour. Short enough that revocation is meaningful; long enough
 *  that a chatty agent doesn't burn its refresh budget. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60

/** 30 days, rolling. Each refresh issues a new refresh token + retires
 *  the old one (see oauthRepo.rotateRefreshToken). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/** 60 seconds. Authorization codes are one-shot anyway; the short TTL
 *  just bounds the replay window for an interception attack. */
export const AUTH_CODE_TTL_SECONDS = 60

// ── Authorize-request binding (CSRF + scope-upgrade defense) ───────
//
// The OAuth consent flow has two HTTP hops the user walks through:
//   1. GET  /oauth/authorize       — server validates client + scopes
//   2. POST /oauth/authorize/decide — user clicks Allow/Deny
//
// Between (1) and (2) the request parameters live ONLY in the URL
// the user is staring at. Without binding, a malicious /decide POST
// (CSRF) could submit any client_id / scope set / redirect_uri it
// wants — the session cookie alone isn't enough to know "the user
// actually completed the flow this client started".
//
// We sign the canonical (client_id, redirect_uri, code_challenge,
// challenge_method, state, scope) tuple at /authorize using an HMAC
// derived from the session secret, and verify in /decide. The HMAC
// also pins the originally-requested scope set so /decide can reject
// scope-upgrade attempts (selected ⊄ requested).
//
// Stateless — no DB row to GC, no horizontal-scaling concerns.

import { config } from '../config.js'

export type AuthorizeRequest = {
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: 'S256'
  state: string
  /** Space-separated scope string as advertised on the consent page. */
  scope: string
}

function authorizeSigningKey(): Buffer {
  // HKDF-style derivation scoped to this purpose. Reusing
  // config.session.secret directly would let a forgery on one
  // signing context (cookies) be replayed in another (authorize req).
  const h = crypto.createHash('sha256')
  h.update('reader-oauth-authorize-request-v1')
  h.update('\x00')
  h.update(config.session.secret)
  return h.digest()
}

function canonicalize(r: AuthorizeRequest): string {
  // Deterministic JSON over a fixed key order. Don't rely on
  // JSON.stringify property order — it's spec-ambiguous for
  // non-integer keys (in practice insertion order on V8, but
  // explicit is better).
  return JSON.stringify([
    r.client_id,
    r.redirect_uri,
    r.code_challenge,
    r.code_challenge_method,
    r.state,
    r.scope,
  ])
}

/** Sign the canonical authorize-request tuple. Returned token is
 *  base64url of HMAC-SHA256, ~43 chars. Embedded in the /consent URL
 *  as `?req=...` and round-tripped to /decide. */
export function signAuthorizeRequest(r: AuthorizeRequest): string {
  return crypto
    .createHmac('sha256', authorizeSigningKey())
    .update(canonicalize(r))
    .digest('base64url')
}

/** Constant-time verify that the body's params match what /authorize
 *  originally signed. Returns true only on exact match. */
export function verifyAuthorizeRequest(r: AuthorizeRequest, sig: string): boolean {
  if (!sig || typeof sig !== 'string') return false
  const expected = signAuthorizeRequest(r)
  if (expected.length !== sig.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
}
