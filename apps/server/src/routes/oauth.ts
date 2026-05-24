/**
 * OAuth 2.1 endpoints for the MCP server. Implements the slice of the
 * MCP auth spec (2025-06-18) that lets third-party MCP clients —
 * Claude Desktop, Cursor, Inspector — "Connect" via browser consent
 * instead of pasting a static API token.
 *
 * Flow per a client like Claude Desktop:
 *   1. Fetch GET  /.well-known/oauth-protected-resource          → AS URL
 *   2. Fetch GET  /.well-known/oauth-authorization-server        → endpoints
 *   3. POST       /oauth/register                                → client_id (DCR)
 *   4. Open       /oauth/authorize?response_type=code&...        (browser)
 *      ├─ if not signed in, redirect to /login?next=...
 *      └─ /oauth/consent React page renders, user approves
 *   5. POST       /oauth/authorize/decide                        → code, then 302 to redirect_uri
 *   6. POST       /oauth/token                                   → access + refresh tokens
 *   7. Subsequent /mcp calls with `Authorization: Bearer <access>`
 *   8. POST       /oauth/token (grant_type=refresh_token)        on expiry
 *
 * Auth between steps 5 ↔ 6 is PKCE-bound: the client commits to a
 * code_verifier at step 4 via its hash; we check the hash at step 6.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../stores/audit.js'
import { config } from '../config.js'
import { createRateLimit } from '../lib/rateLimit.js'
import {
  insertClient,
  getClient,
  verifyClientSecret,
  insertAuthCode,
  consumeAuthCode,
  insertAccessToken,
  insertRefreshToken,
  claimRefreshToken,
  rotateRefreshToken,
  revokeGrant,
  revokeAccessToken,
  revokeRefreshToken,
  findRefreshToken,
  findAccessToken,
  hashOpaque,
} from '../db/oauthRepo.js'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TOOL_SCOPES,
  expandScopes,
  generateAccessToken,
  generateAuthCode,
  generateClientId,
  generateClientSecret,
  generateRefreshToken,
  signAuthorizeRequest,
  validateScopes,
  verifyAuthorizeRequest,
  verifyPkceS256,
} from '../services/oauth.js'

/** Issuer URL — the canonical base for everything OAuth-related. The
 *  spec requires this match across discovery + token claims, so we
 *  pin it to `config.appUrl` rather than reading the request host
 *  (which can vary across reverse-proxy setups). */
function issuer(): string {
  return config.appUrl.replace(/\/$/, '')
}

/**
 * Per-IP throttle on /oauth/register. DCR is open by design (any MCP
 * client can self-register), so we need a budget to keep an attacker
 * from bloating the DB with millions of bogus clients or fuzzing
 * client_name values. 10 registrations / hour / IP is generous for a
 * power user installing several clients in a session while choking
 * any sustained automated flood.
 */
const REGISTER_RATE_LIMIT = createRateLimit({
  capacity: 10,
  refillPerSecond: 10 / 3600,
})

/** WHATWG URL parses IPv6 hosts without brackets in `hostname`. The
 *  set covers the literal forms we want to treat as loopback. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Per-user budget on /oauth/consent-context. The endpoint takes a
 * client_id query param, so it can't be used to enumerate clients
 * from cold (client_ids are 256-bit opaque), but a malicious script
 * running in an authed session could grind through any leaked list.
 * 60 lookups/minute is generous for the legitimate consent flow
 * (one call per page mount) while choking sustained probing.
 */
const CONSENT_CONTEXT_RATE_LIMIT = createRateLimit({
  capacity: 60,
  refillPerSecond: 1,
})

/** Test hook — clears both OAuth limiters so a suite registering
 *  dozens of clients doesn't trip the 10/hour DCR throttle. */
export function _resetOauthRateLimitsForTest(): void {
  REGISTER_RATE_LIMIT.reset()
  CONSENT_CONTEXT_RATE_LIMIT.reset()
}

export async function oauthRoutes(app: FastifyInstance) {
  // ── Discovery ────────────────────────────────────────────────────

  /**
   * RFC 9728 — protected-resource metadata. MCP clients fetch this
   * from the resource URL (`/mcp`) to discover the auth server. We
   * advertise this server as both the AS and the RS (single binary).
   */
  app.get('/.well-known/oauth-protected-resource', async () => {
    return {
      resource: `${issuer()}/mcp`,
      authorization_servers: [issuer()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp', ...TOOL_SCOPES.map((s) => s.scope)],
    }
  })

  /**
   * RFC 8414 — authorization-server metadata. Lists endpoint URLs,
   * supported PKCE methods, and supported grant types so clients can
   * negotiate without hardcoded paths.
   */
  app.get('/.well-known/oauth-authorization-server', async () => {
    return {
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/oauth/authorize`,
      token_endpoint: `${issuer()}/oauth/token`,
      registration_endpoint: `${issuer()}/oauth/register`,
      revocation_endpoint: `${issuer()}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp', ...TOOL_SCOPES.map((s) => s.scope)],
    }
  })

  // ── Dynamic Client Registration (RFC 7591) ──────────────────────

  /**
   * Open DCR per the user's policy choice. Any MCP client can self-
   * register without operator approval — the trust boundary is the
   * per-user consent screen, not the registration. Confidential
   * clients (server-to-server) MAY include a `client_secret_post`
   * token_endpoint_auth_method preference, but public clients
   * (the MCP norm) get a `none` method back.
   */
  app.post('/oauth/register', async (req, reply) => {
    // Per-IP DCR throttle. See REGISTER_RATE_LIMIT.
    const check = REGISTER_RATE_LIMIT.check(req.ip)
    if (!check.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(check.retryAfterSeconds))
        .send({
          error: 'rate_limited',
          error_description: 'too many client registrations from this address',
        })
    }
    const body = z
      .object({
        client_name: z.string().min(1).max(200),
        redirect_uris: z.array(z.string().url()).min(1).max(10),
        software_id: z.string().max(200).optional(),
        software_version: z.string().max(60).optional(),
        token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).optional(),
      })
      .parse(req.body)

    // Loopback redirect URIs (http://127.0.0.1, http://localhost) are
    // allowed regardless of TLS — that's the MCP-client norm. Other
    // http:// URIs are rejected to defeat code-interception over
    // plaintext channels. Note: WHATWG URL parses IPv6 hosts without
    // brackets in `hostname`, so we match against `::1` not `[::1]`.
    for (const u of body.redirect_uris) {
      const url = new URL(u)
      const isLoopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
      if (url.protocol !== 'https:' && !isLoopback) {
        return reply.code(400).send({
          error: 'invalid_redirect_uri',
          error_description: `redirect_uri must be https or loopback http: ${u}`,
        })
      }
    }

    const clientId = generateClientId()
    const wantsSecret = body.token_endpoint_auth_method === 'client_secret_post'
    const secret = wantsSecret ? generateClientSecret() : undefined
    insertClient({
      clientId,
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      softwareId: body.software_id,
      softwareVersion: body.software_version,
      clientSecretHash: secret ? hashOpaque(secret) : undefined,
      createdBy: req.currentUser?.username,
    })
    await audit({
      actor: req.currentUser?.username ?? 'anonymous',
      action: 'oauth.client.register',
      target: clientId,
      meta: { name: body.client_name, software_id: body.software_id },
    })
    return reply.code(201).send({
      client_id: clientId,
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: wantsSecret ? 'client_secret_post' : 'none',
      ...(secret ? { client_secret: secret } : {}),
    })
  })

  // ── Authorization endpoint ──────────────────────────────────────

  /**
   * Step 4 — GET /oauth/authorize. Validates client_id + redirect_uri
   * + PKCE challenge + requested scopes, then hands off to the
   * React consent page. The validation result is encoded into the
   * /oauth/consent URL so the page can render `client_name` + scope
   * checkboxes without an extra round-trip.
   *
   * If the user isn't signed in, redirect to /login?next= and come
   * back here after authentication.
   */
  app.get('/oauth/authorize', async (req, reply) => {
    const q = z
      .object({
        response_type: z.literal('code'),
        client_id: z.string().min(1),
        redirect_uri: z.string().url(),
        scope: z.string().optional(),
        state: z.string().min(1).max(512),
        code_challenge: z.string().min(43).max(128),
        code_challenge_method: z.literal('S256'),
      })
      .safeParse(req.query)
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_request', error_description: q.error.message })
    }
    const params = q.data
    const client = getClient(params.client_id)
    if (!client) {
      return reply.code(400).send({ error: 'invalid_client' })
    }
    if (!client.redirectUris.includes(params.redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri' })
    }
    const requested = (params.scope ?? 'mcp').split(/\s+/).filter(Boolean)
    const { ok: knownScopes, unknown } = validateScopes(requested)
    if (unknown.length > 0) {
      const redir = new URL(params.redirect_uri)
      redir.searchParams.set('error', 'invalid_scope')
      redir.searchParams.set('error_description', `unknown scopes: ${unknown.join(', ')}`)
      redir.searchParams.set('state', params.state)
      return reply.redirect(redir.toString())
    }

    // Hand off to the SPA's consent page. When the user isn't signed
    // in, the page renders the AuthScreen first and then re-fetches
    // the consent context after login.
    //
    // The `req` param is an HMAC over the canonical authorize-request
    // tuple. /decide verifies it server-side, which:
    //   (a) defeats CSRF — a malicious POST without this URL's `req`
    //       value can't forge a valid decision.
    //   (b) pins the originally-requested scope set so /decide can
    //       reject scope-upgrade attempts (selected ⊄ requested).
    const expandedScope = expandScopes(knownScopes).join(' ')
    const reqToken = signAuthorizeRequest({
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      state: params.state,
      scope: expandedScope,
    })
    const consent = new URL(`${issuer()}/oauth/consent`)
    consent.searchParams.set('client_id', params.client_id)
    consent.searchParams.set('redirect_uri', params.redirect_uri)
    consent.searchParams.set('state', params.state)
    consent.searchParams.set('code_challenge', params.code_challenge)
    consent.searchParams.set('code_challenge_method', params.code_challenge_method)
    consent.searchParams.set('scope', expandedScope)
    consent.searchParams.set('req', reqToken)
    return reply.redirect(consent.toString())
  })

  /**
   * Step 5 — POST /oauth/authorize/decide. The consent page posts the
   * user's selection (a subset of the originally requested scopes).
   * Requires the session cookie — anonymous decisions are rejected.
   * On approval we mint an authorization code and return the final
   * client redirect URL; on deny we return the spec error redirect.
   */
  app.post('/oauth/authorize/decide', async (req, reply) => {
    // Origin check — defense in depth alongside SameSite=Lax cookies
    // and the HMAC binding below. A POST issued from any origin other
    // than this server's app URL is rejected outright.
    const origin = req.headers.origin
    if (origin && origin !== issuer()) {
      return reply.code(403).send({ error: 'origin_not_allowed' })
    }
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const body = z
      .object({
        client_id: z.string().min(1),
        redirect_uri: z.string().url(),
        state: z.string().min(1),
        code_challenge: z.string().min(43).max(128),
        code_challenge_method: z.literal('S256'),
        /** Originally-requested scope string, exactly as advertised on
         *  the consent page URL. Used as the upper bound for what the
         *  user may grant — a /decide POST that submits scopes outside
         *  this set is rejected as a scope-upgrade attempt. */
        scope: z.string().min(1),
        /** HMAC of the (client_id, redirect_uri, code_challenge,
         *  challenge_method, state, scope) tuple, signed at /authorize.
         *  Verifying here ties this POST to a real authorize round-trip
         *  and prevents a malicious /decide POST from forging params. */
        req: z.string().min(1),
        scopes: z.array(z.string()).default([]),
        approve: z.boolean(),
      })
      .parse(req.body)

    if (
      !verifyAuthorizeRequest(
        {
          client_id: body.client_id,
          redirect_uri: body.redirect_uri,
          code_challenge: body.code_challenge,
          code_challenge_method: body.code_challenge_method,
          state: body.state,
          scope: body.scope,
        },
        body.req,
      )
    ) {
      // Either the params have been tampered with or this POST never
      // went through /authorize. Either way the only safe move is to
      // refuse and audit.
      await audit({
        actor: req.currentUser.username,
        action: 'oauth.consent.bad_signature',
        target: body.client_id,
      })
      return reply.code(400).send({ error: 'invalid_request', error_description: 'bad signature' })
    }

    const client = getClient(body.client_id)
    if (!client) return reply.code(400).send({ error: 'invalid_client' })
    if (!client.redirectUris.includes(body.redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri' })
    }
    const { ok: knownScopes, unknown } = validateScopes(body.scopes)
    if (unknown.length > 0) {
      return reply.code(400).send({
        error: 'invalid_scope',
        error_description: `unknown scopes: ${unknown.join(', ')}`,
      })
    }

    // Scope-upgrade check — the user can only grant a subset of what
    // the client originally requested. Without this check, a malicious
    // /decide POST (or even an over-eager UI) could hand the client
    // scopes it never asked for.
    const requestedSet = new Set(body.scope.split(/\s+/).filter(Boolean))
    const upgraded = knownScopes.filter((s) => !requestedSet.has(s))
    if (upgraded.length > 0) {
      await audit({
        actor: req.currentUser.username,
        action: 'oauth.consent.scope_upgrade',
        target: body.client_id,
        meta: { upgraded: upgraded.join(' ') },
      })
      return reply.code(400).send({
        error: 'invalid_scope',
        error_description: `scopes not in the original request: ${upgraded.join(', ')}`,
      })
    }

    const target = new URL(body.redirect_uri)
    target.searchParams.set('state', body.state)
    if (!body.approve) {
      target.searchParams.set('error', 'access_denied')
      await audit({
        actor: req.currentUser.username,
        action: 'oauth.consent.deny',
        target: body.client_id,
      })
      return { redirect: target.toString() }
    }

    const code = generateAuthCode()
    const granted = knownScopes
    insertAuthCode({
      code,
      clientId: body.client_id,
      userId: req.currentUser.username,
      scopes: granted,
      codeChallenge: body.code_challenge,
      challengeMethod: body.code_challenge_method,
      redirectUri: body.redirect_uri,
      ttlSeconds: AUTH_CODE_TTL_SECONDS,
    })
    target.searchParams.set('code', code)
    await audit({
      actor: req.currentUser.username,
      action: 'oauth.consent.grant',
      target: body.client_id,
      meta: { scopes: granted.join(' '), client_name: client.clientName },
    })
    return { redirect: target.toString() }
  })

  /**
   * Read-only mirror of the same validation logic. The consent page
   * calls this on mount to fetch the client name + canonical scope
   * list (after we've expanded `mcp` to the full set). Saves the
   * client from parsing query strings + duplicating validation.
   */
  app.get('/oauth/consent-context', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'auth required' })
    const check = CONSENT_CONTEXT_RATE_LIMIT.check(`consent:${req.currentUser.username}`)
    if (!check.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(check.retryAfterSeconds))
        .send({ error: 'rate_limited' })
    }
    const q = z
      .object({
        client_id: z.string().min(1),
        scope: z.string().optional(),
        /** Pre-resolved redirect URI from the URL — surfaced back to
         *  the user so they can verify the destination host before
         *  approving (phishing defense against name-collision DCR). */
        redirect_uri: z.string().url().optional(),
      })
      .parse(req.query)
    const client = getClient(q.client_id)
    if (!client) return reply.code(404).send({ error: 'invalid_client' })
    const requested = (q.scope ?? 'mcp').split(/\s+/).filter(Boolean)
    const { ok: knownScopes } = validateScopes(requested)
    // Resolve the host of the redirect URI for display. Validating it
    // against the client's registered list ensures we don't echo an
    // arbitrary host to the user — if the URL was tampered with, we
    // refuse the context call rather than render misleading info.
    let redirectHost: string | undefined
    let redirectIsLoopback = false
    if (q.redirect_uri) {
      if (!client.redirectUris.includes(q.redirect_uri)) {
        return reply.code(400).send({ error: 'invalid_redirect_uri' })
      }
      const u = new URL(q.redirect_uri)
      redirectHost = u.host
      redirectIsLoopback = u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)
    }
    return {
      client: {
        clientId: client.clientId,
        clientName: client.clientName,
        softwareId: client.softwareId,
        createdAt: client.createdAt,
      },
      redirect: redirectHost
        ? { host: redirectHost, isLoopback: redirectIsLoopback }
        : null,
      requested: expandScopes(knownScopes),
      catalog: TOOL_SCOPES,
    }
  })

  // ── Token endpoint ──────────────────────────────────────────────

  /**
   * POST /oauth/token — code exchange + refresh-token rotation.
   *
   * Confidential clients send `client_secret` in the form body.
   * Public clients (PKCE-only) leave it blank. We pick the right
   * verification path based on the client record.
   *
   * Refresh-token replay defense (RFC 6749 §10.5):
   * the first /token call rotates the refresh token; presenting the
   * old token afterwards revokes the entire grant under the theory
   * that the attacker and the legitimate client are now both holding
   * tokens and we can't tell them apart.
   */
  app.post('/oauth/token', async (req, reply) => {
    const ct = String(req.headers['content-type'] ?? '')
    const bodyRaw =
      ct.includes('application/x-www-form-urlencoded')
        ? (req.body as Record<string, string>)
        : (req.body as Record<string, string>)
    return await issueToken(bodyRaw, req, reply)
  })

  // ── Revocation (RFC 7009) ───────────────────────────────────────

  /**
   * RFC 7009 revocation. Accepts either an access or refresh token
   * and returns 200 either way (so an attacker can't enumerate which
   * strings are live tokens). Two hardening rules:
   *
   *  1. `client_id` is REQUIRED. Without it, anyone holding an opaque
   *     token string could DoS the legitimate client by revoking it.
   *     Per the spec, public clients MAY use the endpoint without a
   *     secret, but they MUST identify themselves.
   *  2. The token's `client_id` MUST match the caller's `client_id`.
   *     Confidential clients also pass `client_secret`. This stops
   *     cross-client revocation even if a token leaks across grants
   *     to the same user.
   */
  app.post('/oauth/revoke', async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(1),
        token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
        client_id: z.string().min(1),
        client_secret: z.string().optional(),
      })
      .parse(req.body)
    const client = getClient(body.client_id)
    // Per RFC 7009 §2.2: invalid client → return as if nothing matched.
    // We still return 200 because the spec forbids leaking whether the
    // token existed.
    if (!client) return reply.send({ ok: true })
    if (client.hasSecret) {
      if (!body.client_secret || !verifyClientSecret(body.client_id, body.client_secret)) {
        return reply.code(401).send({ error: 'invalid_client' })
      }
    }
    // Verify ownership BEFORE deleting. Look up by token, check the
    // record's client_id matches the caller's, and only then revoke.
    let hit = false
    if (body.token_type_hint !== 'access_token') {
      const rec = findRefreshToken(body.token)
      if (rec && rec.clientId === body.client_id) {
        revokeRefreshToken(body.token)
        hit = true
      }
    }
    if (!hit && body.token_type_hint !== 'refresh_token') {
      const rec = findAccessToken(body.token)
      if (rec && rec.clientId === body.client_id) {
        revokeAccessToken(body.token)
        hit = true
      }
    }
    if (hit) {
      await audit({
        actor: req.currentUser?.username ?? 'oauth.client',
        action: 'oauth.token.revoke',
        target: body.client_id,
      })
    }
    return reply.send({ ok: true })
  })
}

// ── Token issuance helpers ─────────────────────────────────────────

/**
 * Resolve the client credentials presented on a /oauth/token call.
 *
 * Two transport options per RFC 6749:
 *   - §2.3.1: `Authorization: Basic base64(client_id:client_secret)` (preferred for confidential clients).
 *   - §3.2.1: `client_id` / `client_secret` in the form-encoded body.
 *
 * Spec rule: a request MUST NOT present both forms — if it does, the
 * server MUST reject it. We enforce that.
 *
 * Both client_id and client_secret in the Basic header are
 * `application/x-www-form-urlencoded` encoded per the spec (so
 * `id%3Awith%3Acolon` decodes to `id:with:colon`), separated by a
 * single literal `:`. We decode after split, not before, so a `:` in
 * the encoded id stays distinguishable.
 */
function parseClientCreds(
  req: FastifyRequest,
  body: { client_id?: string; client_secret?: string },
): { clientId: string | null; clientSecret?: string; error?: string } {
  const authz = req.headers.authorization
  const hasBasic = typeof authz === 'string' && authz.toLowerCase().startsWith('basic ')
  if (hasBasic) {
    // §2.3.1: clients MUST NOT use more than one auth method per request.
    if (body.client_id || body.client_secret) {
      return { clientId: null, error: 'multiple_client_auth' }
    }
    let decoded: string
    try {
      decoded = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf8')
    } catch {
      return { clientId: null, error: 'invalid_basic' }
    }
    const sep = decoded.indexOf(':')
    if (sep <= 0) return { clientId: null, error: 'invalid_basic' }
    const id = safeUrlDecode(decoded.slice(0, sep))
    const secret = safeUrlDecode(decoded.slice(sep + 1))
    if (!id) return { clientId: null, error: 'invalid_basic' }
    return { clientId: id, clientSecret: secret }
  }
  if (!body.client_id) return { clientId: null, error: 'missing_client_id' }
  return { clientId: body.client_id, clientSecret: body.client_secret }
}

function safeUrlDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    // The spec encoding is application/x-www-form-urlencoded but
    // some clients send raw values. Fall through to the raw string —
    // verifyClientSecret is a constant-time compare on the hash, so
    // a mis-decoded secret just fails to match without a side channel.
    return s
  }
}

async function issueToken(
  body: Record<string, string>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const grant = body.grant_type
  if (grant === 'authorization_code') return issueFromCode(body, req, reply)
  if (grant === 'refresh_token') return issueFromRefresh(body, req, reply)
  return reply.code(400).send({ error: 'unsupported_grant_type' })
}

async function issueFromCode(
  body: Record<string, string>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // client_id / client_secret may arrive via HTTP Basic or body —
  // resolve before zod validation so the body schema can treat them
  // as optional and we still surface the right error per spec.
  const creds = parseClientCreds(req, body)
  if (!creds.clientId) {
    await audit({ actor: null, action: 'oauth.token.bad_request', meta: { reason: creds.error } })
    return reply.code(400).send({ error: 'invalid_request', error_description: creds.error })
  }
  const parsed = z
    .object({
      code: z.string().min(1),
      redirect_uri: z.string().url(),
      code_verifier: z.string().min(43).max(128),
    })
    .safeParse(body)
  if (!parsed.success) {
    await audit({ actor: null, action: 'oauth.token.bad_request', meta: { reason: parsed.error.message } })
    return reply.code(400).send({ error: 'invalid_request', error_description: parsed.error.message })
  }
  const p = { ...parsed.data, client_id: creds.clientId, client_secret: creds.clientSecret }
  const client = getClient(p.client_id)
  if (!client) {
    await audit({ actor: null, action: 'oauth.token.invalid_client', target: p.client_id })
    return reply.code(400).send({ error: 'invalid_client' })
  }
  if (client.hasSecret) {
    if (!p.client_secret || !verifyClientSecret(p.client_id, p.client_secret)) {
      await audit({ actor: null, action: 'oauth.token.bad_secret', target: p.client_id })
      return reply.code(401).send({ error: 'invalid_client' })
    }
  }
  const consumed = consumeAuthCode(p.code)
  if (!consumed) {
    await audit({ actor: null, action: 'oauth.token.unknown_code', target: p.client_id })
    return reply.code(400).send({ error: 'invalid_grant' })
  }
  if (consumed.replayed) {
    // Spec §10.5: kill the entire grant on code reuse.
    revokeGrant(consumed.record.userId, consumed.record.clientId)
    await audit({
      actor: consumed.record.userId,
      action: 'oauth.replay.code',
      target: consumed.record.clientId,
    })
    return reply.code(400).send({ error: 'invalid_grant' })
  }
  const rec = consumed.record
  if (rec.clientId !== p.client_id) {
    await audit({
      actor: rec.userId,
      action: 'oauth.token.client_mismatch',
      target: rec.clientId,
      meta: { presentedClient: p.client_id },
    })
    return reply.code(400).send({ error: 'invalid_grant' })
  }
  if (rec.redirectUri !== p.redirect_uri) {
    await audit({
      actor: rec.userId,
      action: 'oauth.token.redirect_mismatch',
      target: rec.clientId,
      meta: { presented: p.redirect_uri, expected: rec.redirectUri },
    })
    return reply.code(400).send({ error: 'invalid_grant' })
  }
  if (!verifyPkceS256(p.code_verifier, rec.codeChallenge)) {
    await audit({
      actor: rec.userId,
      action: 'oauth.token.pkce_failed',
      target: rec.clientId,
    })
    return reply.code(400).send({ error: 'invalid_grant', error_description: 'pkce failed' })
  }

  const access = generateAccessToken()
  const refresh = generateRefreshToken()
  insertAccessToken({
    token: access,
    clientId: rec.clientId,
    userId: rec.userId,
    scopes: rec.scopes,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  })
  insertRefreshToken({
    token: refresh,
    clientId: rec.clientId,
    userId: rec.userId,
    scopes: rec.scopes,
    ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
  })
  await audit({
    actor: rec.userId,
    action: 'oauth.token.issue',
    target: rec.clientId,
    meta: { scopes: rec.scopes.join(' ') },
  })
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope: rec.scopes.join(' '),
  }
}

async function issueFromRefresh(
  body: Record<string, string>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const creds = parseClientCreds(req, body)
  if (!creds.clientId) {
    await audit({ actor: null, action: 'oauth.refresh.bad_request', meta: { reason: creds.error } })
    return reply.code(400).send({ error: 'invalid_request', error_description: creds.error })
  }
  const parsed = z
    .object({
      refresh_token: z.string().min(1),
      // Down-scoping per RFC 6749 §6: refresh request MAY narrow the
      // scope set. We accept the narrowing but never widen.
      scope: z.string().optional(),
    })
    .safeParse(body)
  if (!parsed.success) {
    await audit({ actor: null, action: 'oauth.refresh.bad_request', meta: { reason: parsed.error.message } })
    return reply.code(400).send({ error: 'invalid_request', error_description: parsed.error.message })
  }
  const p = { ...parsed.data, client_id: creds.clientId, client_secret: creds.clientSecret }
  const client = getClient(p.client_id)
  if (!client) {
    await audit({ actor: null, action: 'oauth.refresh.invalid_client', target: p.client_id })
    return reply.code(400).send({ error: 'invalid_client' })
  }
  if (client.hasSecret) {
    if (!p.client_secret || !verifyClientSecret(p.client_id, p.client_secret)) {
      await audit({ actor: null, action: 'oauth.refresh.bad_secret', target: p.client_id })
      return reply.code(401).send({ error: 'invalid_client' })
    }
  }

  // Atomic claim: exactly one concurrent /token call wins. Two
  // simultaneous refreshes used to both see `revoked_at IS NULL`
  // (Fastify yielded between the SELECT and the UPDATE) and both
  // mint fresh token pairs — only the THIRD call would trigger
  // replay defense. claimRefreshToken collapses the check + flip
  // into a single UPDATE...WHERE so the race window is closed.
  const claim = claimRefreshToken(p.refresh_token)
  if (!claim) {
    await audit({ actor: null, action: 'oauth.refresh.unknown_token', target: p.client_id })
    return reply.code(400).send({ error: 'invalid_grant' })
  }
  const rec = claim.record
  if (rec.clientId !== p.client_id) {
    await audit({
      actor: rec.userId,
      action: 'oauth.refresh.client_mismatch',
      target: rec.clientId,
      meta: { presentedClient: p.client_id },
    })
    return reply.code(400).send({ error: 'invalid_grant' })
  }

  if (claim.replayed) {
    // Token was already retired — either by a prior refresh OR by a
    // concurrent claim. Both are treated as a replay attempt per RFC
    // 6749 §10.5 and kill the whole grant.
    revokeGrant(rec.userId, rec.clientId)
    await audit({
      actor: rec.userId,
      action: 'oauth.replay.refresh',
      target: rec.clientId,
    })
    return reply.code(400).send({ error: 'invalid_grant' })
  }

  let scopes = rec.scopes
  if (p.scope) {
    const requested = p.scope.split(/\s+/).filter(Boolean)
    // RFC 6749 §6: the new scope set MUST be a subset of the original.
    const original = new Set(rec.scopes)
    const narrowed = requested.filter((s) => original.has(s))
    if (narrowed.length === 0) {
      return reply.code(400).send({
        error: 'invalid_scope',
        error_description: 'requested scopes are not a subset of the original grant',
      })
    }
    scopes = narrowed
  }

  const newAccess = generateAccessToken()
  const newRefresh = generateRefreshToken()
  insertAccessToken({
    token: newAccess,
    clientId: rec.clientId,
    userId: rec.userId,
    scopes,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  })
  insertRefreshToken({
    token: newRefresh,
    clientId: rec.clientId,
    userId: rec.userId,
    scopes,
    ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
  })
  rotateRefreshToken(rec.tokenHash, hashOpaque(newRefresh))
  await audit({
    actor: rec.userId,
    action: 'oauth.token.refresh',
    target: rec.clientId,
  })
  return {
    access_token: newAccess,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefresh,
    scope: scopes.join(' '),
  }
}
