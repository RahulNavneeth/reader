/**
 * OAuth 2.1 persistence layer. Backs the `/oauth/*` routes and the
 * MCP bearer-token validator. All client_secrets, codes, access
 * tokens, and refresh tokens are stored hashed (sha256-hex) — the
 * plaintext only ever exists on the wire and in the requesting
 * client's memory. A DB dump can't authenticate as anyone.
 *
 * Single-use defenses:
 *  - Authorization codes flip `used = 1` on first exchange. Any
 *    second use triggers `revokeGrant()` (see RFC 6749 §10.5).
 *  - Refresh tokens rotate on every use; the retired token's
 *    `replaced_by` is set. Presenting a retired token is treated as
 *    a replay attack and revokes the whole grant per the OAuth 2.1
 *    security BCP.
 */
import crypto from 'node:crypto'
import { db } from './sqlite.js'

export function hashOpaque(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

// ── Clients ────────────────────────────────────────────────────────

export type OAuthClient = {
  clientId: string
  clientName: string
  redirectUris: string[]
  softwareId?: string
  softwareVersion?: string
  /** True for confidential clients (server-to-server). Public clients
   *  (the common case for MCP) have no secret and rely on PKCE. */
  hasSecret: boolean
  createdAt: number
  createdBy?: string
}

type ClientRow = {
  client_id: string
  client_name: string
  redirect_uris_json: string
  software_id: string | null
  software_version: string | null
  client_secret_hash: string | null
  created_at: number
  created_by: string | null
}

function clientFromRow(r: ClientRow): OAuthClient {
  return {
    clientId: r.client_id,
    clientName: r.client_name,
    redirectUris: JSON.parse(r.redirect_uris_json) as string[],
    softwareId: r.software_id ?? undefined,
    softwareVersion: r.software_version ?? undefined,
    hasSecret: r.client_secret_hash != null,
    createdAt: r.created_at,
    createdBy: r.created_by ?? undefined,
  }
}

export function insertClient(c: {
  clientId: string
  clientName: string
  redirectUris: string[]
  softwareId?: string
  softwareVersion?: string
  clientSecretHash?: string
  createdBy?: string
}): OAuthClient {
  const now = Date.now()
  db().prepare(
    `INSERT INTO oauth_clients
       (client_id, client_name, redirect_uris_json, software_id,
        software_version, client_secret_hash, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.clientId,
    c.clientName,
    JSON.stringify(c.redirectUris),
    c.softwareId ?? null,
    c.softwareVersion ?? null,
    c.clientSecretHash ?? null,
    now,
    c.createdBy ?? null,
  )
  return {
    clientId: c.clientId,
    clientName: c.clientName,
    redirectUris: c.redirectUris,
    softwareId: c.softwareId,
    softwareVersion: c.softwareVersion,
    hasSecret: !!c.clientSecretHash,
    createdAt: now,
    createdBy: c.createdBy,
  }
}

export function getClient(clientId: string): OAuthClient | null {
  const r = db()
    .prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`)
    .get(clientId) as ClientRow | undefined
  return r ? clientFromRow(r) : null
}

/** Verify a confidential client's secret. Returns false for public
 *  clients (no secret on file) — those use PKCE instead. */
export function verifyClientSecret(clientId: string, secret: string): boolean {
  const r = db()
    .prepare(`SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?`)
    .get(clientId) as { client_secret_hash: string | null } | undefined
  if (!r || !r.client_secret_hash) return false
  return crypto.timingSafeEqual(
    Buffer.from(r.client_secret_hash, 'hex'),
    Buffer.from(hashOpaque(secret), 'hex'),
  )
}

// ── Authorization codes ─────────────────────────────────────────────

export type AuthCodeInsert = {
  code: string
  clientId: string
  userId: string
  scopes: string[]
  codeChallenge: string
  challengeMethod: 'S256'
  redirectUri: string
  ttlSeconds: number
}

export function insertAuthCode(c: AuthCodeInsert): void {
  const now = Date.now()
  db().prepare(
    `INSERT INTO oauth_auth_codes
       (code_hash, client_id, user_id, scopes, code_challenge,
        challenge_method, redirect_uri, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    hashOpaque(c.code),
    c.clientId,
    c.userId,
    c.scopes.join(' '),
    c.codeChallenge,
    c.challengeMethod,
    c.redirectUri,
    now,
    now + c.ttlSeconds * 1000,
  )
}

export type AuthCodeRecord = {
  clientId: string
  userId: string
  scopes: string[]
  codeChallenge: string
  challengeMethod: string
  redirectUri: string
  expiresAt: number
  used: boolean
}

/**
 * Atomically claim an authorization code for exchange. The single
 * UPDATE...WHERE used = 0 / changes check guarantees that exactly
 * one concurrent /token call wins — eliminating the SELECT-then-
 * UPDATE race that would otherwise let both succeed across async
 * ticks in Fastify.
 *
 * Three outcomes:
 *  - `null`               — code doesn't exist OR has expired.
 *  - `{ replayed: true }` — code exists, was already used. Caller
 *    must treat this as a replay attempt and revoke the entire grant
 *    per RFC 6749 §10.5. Includes the record so the caller knows
 *    WHICH (user, client) pair to revoke.
 *  - `{ replayed: false, record }` — first-use win.
 */
export function consumeAuthCode(
  code: string,
): { record: AuthCodeRecord; replayed: boolean } | null {
  const hash = hashOpaque(code)
  const tx = db().transaction((): { record: AuthCodeRecord; replayed: boolean } | null => {
    const row = db()
      .prepare(
        `SELECT client_id, user_id, scopes, code_challenge, challenge_method,
                redirect_uri, expires_at, used
           FROM oauth_auth_codes WHERE code_hash = ?`,
      )
      .get(hash) as
      | {
          client_id: string
          user_id: string
          scopes: string
          code_challenge: string
          challenge_method: string
          redirect_uri: string
          expires_at: number
          used: number
        }
      | undefined
    if (!row) return null
    if (row.expires_at < Date.now()) return null
    const record: AuthCodeRecord = {
      clientId: row.client_id,
      userId: row.user_id,
      scopes: row.scopes ? row.scopes.split(' ') : [],
      codeChallenge: row.code_challenge,
      challengeMethod: row.challenge_method,
      redirectUri: row.redirect_uri,
      expiresAt: row.expires_at,
      used: row.used === 1,
    }
    if (record.used) return { record, replayed: true }
    // CAS: only flip if the row is still unclaimed. If two requests
    // race, exactly one sees changes === 1; the other sees 0 and is
    // routed to the replay branch on its next consumeAuthCode call
    // (since `used` is now 1).
    const upd = db()
      .prepare(`UPDATE oauth_auth_codes SET used = 1 WHERE code_hash = ? AND used = 0`)
      .run(hash)
    if (upd.changes === 0) {
      // Another concurrent caller won. From our perspective this is
      // indistinguishable from a replay.
      return { record, replayed: true }
    }
    return { record, replayed: false }
  })
  return tx()
}

export function pruneExpiredAuthCodes(): number {
  return db()
    .prepare(`DELETE FROM oauth_auth_codes WHERE expires_at < ?`)
    .run(Date.now()).changes
}

// ── Access tokens ───────────────────────────────────────────────────

export function insertAccessToken(t: {
  token: string
  clientId: string
  userId: string
  scopes: string[]
  ttlSeconds: number
}): void {
  const now = Date.now()
  db().prepare(
    `INSERT INTO oauth_access_tokens
       (token_hash, client_id, user_id, scopes, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(hashOpaque(t.token), t.clientId, t.userId, t.scopes.join(' '), now, now + t.ttlSeconds * 1000)
}

export type AccessTokenRecord = {
  clientId: string
  userId: string
  scopes: string[]
  createdAt: number
  expiresAt: number
  lastUsedAt?: number
}

/** Pure lookup — no side effects. Use `touchAccessToken` to record
 *  a successful use AFTER all downstream validity checks
 *  (user not disabled, etc.) have passed. Splitting the two keeps
 *  the activity timeline honest. */
export function findAccessToken(token: string): AccessTokenRecord | null {
  const hash = hashOpaque(token)
  const r = db()
    .prepare(
      `SELECT client_id, user_id, scopes, created_at, expires_at, last_used_at
         FROM oauth_access_tokens WHERE token_hash = ?`,
    )
    .get(hash) as
    | {
        client_id: string
        user_id: string
        scopes: string
        created_at: number
        expires_at: number
        last_used_at: number | null
      }
    | undefined
  if (!r) return null
  if (r.expires_at < Date.now()) return null
  return {
    clientId: r.client_id,
    userId: r.user_id,
    scopes: r.scopes ? r.scopes.split(' ') : [],
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at ?? undefined,
  }
}

/** Record that an access token was successfully used. Caller MUST
 *  have already verified the underlying user is still valid — this
 *  is intentionally not idempotent with `findAccessToken` so a
 *  rejected lookup (disabled user, missing user) doesn't fake an
 *  activity timestamp. */
export function touchAccessToken(token: string): void {
  db()
    .prepare(`UPDATE oauth_access_tokens SET last_used_at = ? WHERE token_hash = ?`)
    .run(Date.now(), hashOpaque(token))
}

// ── Refresh tokens ──────────────────────────────────────────────────

export function insertRefreshToken(t: {
  token: string
  clientId: string
  userId: string
  scopes: string[]
  ttlSeconds: number
}): void {
  const now = Date.now()
  db().prepare(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, client_id, user_id, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hashOpaque(t.token), t.clientId, t.userId, t.scopes.join(' '), now, now + t.ttlSeconds * 1000)
}

export type RefreshTokenRecord = {
  tokenHash: string
  clientId: string
  userId: string
  scopes: string[]
  expiresAt: number
  replacedBy?: string
  revokedAt?: number
}

export function findRefreshToken(token: string): RefreshTokenRecord | null {
  const hash = hashOpaque(token)
  const r = db()
    .prepare(
      `SELECT token_hash, client_id, user_id, scopes, expires_at,
              replaced_by, revoked_at
         FROM oauth_refresh_tokens WHERE token_hash = ?`,
    )
    .get(hash) as
    | {
        token_hash: string
        client_id: string
        user_id: string
        scopes: string
        expires_at: number
        replaced_by: string | null
        revoked_at: number | null
      }
    | undefined
  if (!r) return null
  return {
    tokenHash: r.token_hash,
    clientId: r.client_id,
    userId: r.user_id,
    scopes: r.scopes ? r.scopes.split(' ') : [],
    expiresAt: r.expires_at,
    replacedBy: r.replaced_by ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
  }
}

/** Mark a refresh token as retired and point at its replacement so
 *  a future presentation of the old token is unambiguously a replay. */
export function rotateRefreshToken(oldHash: string, newTokenHash: string): void {
  db().prepare(
    `UPDATE oauth_refresh_tokens
        SET replaced_by = ?, revoked_at = ?
      WHERE token_hash = ?`,
  ).run(newTokenHash, Date.now(), oldHash)
}

/**
 * Atomically "claim" a refresh token for rotation. Single transaction:
 *  1. Try `UPDATE ... SET revoked_at = now WHERE token_hash = ? AND revoked_at IS NULL`.
 *  2. If `changes === 0`, the token either doesn't exist, expired, or
 *     was already claimed by a concurrent /token call — return the
 *     state so the caller can branch (replay vs unknown).
 *  3. On a win, fetch the now-revoked row to return its scopes/user/client.
 *
 * Three outcomes mirror consumeAuthCode:
 *  - `null`            — unknown token
 *  - `{ replayed: true, record }` — already revoked; caller must nuke the grant
 *  - `{ replayed: false, record }` — first-claim win
 *
 * Caller must follow up with `rotateRefreshToken(record.tokenHash, hashOpaque(newToken))`
 * to point `replaced_by` at the newly-issued token (so a future replay
 * is identifiable as such for audit).
 */
export function claimRefreshToken(
  token: string,
): { record: RefreshTokenRecord; replayed: boolean } | null {
  const hash = hashOpaque(token)
  const tx = db().transaction((): { record: RefreshTokenRecord; replayed: boolean } | null => {
    // Pre-fetch to distinguish "unknown" from "already claimed" — both
    // would otherwise return changes=0 below.
    const row = db()
      .prepare(
        `SELECT token_hash, client_id, user_id, scopes, expires_at,
                replaced_by, revoked_at
           FROM oauth_refresh_tokens WHERE token_hash = ?`,
      )
      .get(hash) as
      | {
          token_hash: string
          client_id: string
          user_id: string
          scopes: string
          expires_at: number
          replaced_by: string | null
          revoked_at: number | null
        }
      | undefined
    if (!row) return null
    if (row.expires_at < Date.now()) return null
    const record: RefreshTokenRecord = {
      tokenHash: row.token_hash,
      clientId: row.client_id,
      userId: row.user_id,
      scopes: row.scopes ? row.scopes.split(' ') : [],
      expiresAt: row.expires_at,
      replacedBy: row.replaced_by ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
    }
    if (row.revoked_at != null) return { record, replayed: true }
    const upd = db()
      .prepare(
        `UPDATE oauth_refresh_tokens
            SET revoked_at = ?
          WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(Date.now(), hash)
    if (upd.changes === 0) return { record, replayed: true }
    return { record, replayed: false }
  })
  return tx()
}

// ── Grants (user-facing view) ───────────────────────────────────────

export type Grant = {
  clientId: string
  clientName: string
  scopes: string[]
  createdAt: number
  lastUsedAt?: number
}

/**
 * One grant per (user, client) pair the user can still revoke.
 *
 * "Still revocable" = the user has at least one live refresh token
 * (unexpired, not revoked). Refresh tokens live 30 days; access
 * tokens live 1 hour. If we keyed off access tokens, an idle grant
 * would silently drop out of the UI after 1 hour, leaving the user
 * with no way to revoke the still-valid refresh token — a true
 * revocation gap. Joining off refresh tokens fixes that.
 *
 * Last-used + scopes come from a LEFT JOIN over access tokens (most
 * recent first) so the row carries useful telemetry when available
 * but doesn't disappear when it isn't.
 */
export function listGrantsForUser(userId: string): Grant[] {
  const rows = db()
    .prepare(
      `SELECT r.client_id          AS clientId,
              c.client_name        AS clientName,
              MAX(r.scopes)        AS scopes,
              MIN(r.created_at)    AS createdAt,
              (
                SELECT MAX(a.last_used_at)
                  FROM oauth_access_tokens a
                 WHERE a.user_id = r.user_id
                   AND a.client_id = r.client_id
              )                    AS lastUsedAt
         FROM oauth_refresh_tokens r
              JOIN oauth_clients c ON c.client_id = r.client_id
        WHERE r.user_id = ?
          AND r.expires_at > ?
          AND r.revoked_at IS NULL
        GROUP BY r.client_id, c.client_name`,
    )
    .all(userId, Date.now()) as Array<{
    clientId: string
    clientName: string
    scopes: string
    createdAt: number
    lastUsedAt: number | null
  }>
  return rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    scopes: r.scopes ? r.scopes.split(' ') : [],
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? undefined,
  }))
}

/**
 * Revoke every access + refresh token for one (user, client) pair.
 * Called from the Connected Apps "Revoke" button and from the replay
 * detector when a retired refresh token is presented again.
 */
export function revokeGrant(userId: string, clientId: string): {
  accessRevoked: number
  refreshRevoked: number
} {
  const a = db()
    .prepare(`DELETE FROM oauth_access_tokens WHERE user_id = ? AND client_id = ?`)
    .run(userId, clientId).changes
  const r = db()
    .prepare(`DELETE FROM oauth_refresh_tokens WHERE user_id = ? AND client_id = ?`)
    .run(userId, clientId).changes
  return { accessRevoked: a, refreshRevoked: r }
}

// ── Admin: client inspection + GC ──────────────────────────────────

export type ClientWithUsage = OAuthClient & {
  /** Number of distinct (user, client) pairs that have at least one
   *  live access OR refresh token — i.e. how many users this client
   *  is currently serving. */
  activeGrants: number
  /** Most recent `last_used_at` across all access tokens this client
   *  holds, or undefined if it's never been used. */
  lastUsedAt?: number
}

/** Admin-only listing of every registered client + usage counters
 *  derived from token tables. Powers the "OAuth clients" page in
 *  workspace settings — admins need to see what's been registered
 *  (open DCR means it can be anything) and revoke / delete rogues. */
export function listClientsWithUsage(): ClientWithUsage[] {
  const rows = db()
    .prepare(
      `SELECT c.*,
              COALESCE(g.activeGrants, 0) AS activeGrants,
              g.lastUsedAt              AS lastUsedAt
         FROM oauth_clients c
              LEFT JOIN (
                SELECT client_id,
                       COUNT(DISTINCT user_id) AS activeGrants,
                       MAX(last_used_at)       AS lastUsedAt
                  FROM oauth_access_tokens
                 WHERE expires_at > ?
                 GROUP BY client_id
              ) g ON g.client_id = c.client_id
        ORDER BY c.created_at DESC`,
    )
    .all(Date.now()) as Array<
    ClientRow & { activeGrants: number; lastUsedAt: number | null }
  >
  return rows.map((r) => ({
    ...clientFromRow(r),
    activeGrants: r.activeGrants,
    lastUsedAt: r.lastUsedAt ?? undefined,
  }))
}

/** Delete a client and (via ON DELETE CASCADE on the FKs) every
 *  derived auth-code / access-token / refresh-token row. Admins
 *  call this for rogue or stale DCR registrations. Returns true if
 *  a row was deleted. */
export function deleteClient(clientId: string): boolean {
  return db()
    .prepare(`DELETE FROM oauth_clients WHERE client_id = ?`)
    .run(clientId).changes > 0
}

/**
 * Periodic cleanup: drop clients that look abandoned. Criteria:
 *  - Registered more than `staleAfterMs` ago, AND
 *  - No live access tokens, AND
 *  - No live refresh tokens.
 *
 * Returns the number of rows deleted (for logging). FK cascades
 * still apply but should be no-ops since we already verified zero
 * live tokens.
 */
export function pruneStaleClients(staleAfterMs: number): number {
  const cutoff = Date.now() - staleAfterMs
  return db()
    .prepare(
      `DELETE FROM oauth_clients
        WHERE created_at < ?
          AND client_id NOT IN (
            SELECT client_id FROM oauth_access_tokens WHERE expires_at > ?
            UNION
            SELECT client_id FROM oauth_refresh_tokens
             WHERE expires_at > ? AND revoked_at IS NULL
          )`,
    )
    .run(cutoff, Date.now(), Date.now()).changes
}

export function revokeAccessToken(token: string): boolean {
  const r = db()
    .prepare(`DELETE FROM oauth_access_tokens WHERE token_hash = ?`)
    .run(hashOpaque(token))
  return r.changes > 0
}

export function revokeRefreshToken(token: string): boolean {
  const r = db()
    .prepare(`DELETE FROM oauth_refresh_tokens WHERE token_hash = ?`)
    .run(hashOpaque(token))
  return r.changes > 0
}
