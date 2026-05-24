-- OAuth 2.1 + Dynamic Client Registration for the MCP endpoint.
-- Lets third-party MCP clients (Claude Desktop, Cursor, Inspector,
-- etc.) "Connect" via browser consent instead of pasting a static
-- API token. Modeled after Notion / Jira / Atlassian's MCP auth: open
-- DCR, PKCE-required code flow, per-tool scopes.
--
-- Tokens are stored hashed (sha256-hex of the opaque secret) so a DB
-- dump alone can't authenticate as anyone, mirroring how
-- `api_tokens` already works.

CREATE TABLE oauth_clients (
  -- Public client_id surfaced to the registering app. Random opaque.
  client_id          TEXT PRIMARY KEY,
  -- Display name from the DCR request ("Claude Desktop on Bob's Mac").
  -- Shown on the consent screen + Connected Apps list.
  client_name        TEXT NOT NULL,
  -- JSON-encoded array of allowed redirect URIs. Authorize requests
  -- whose `redirect_uri` isn't an exact match get 400.
  redirect_uris_json TEXT NOT NULL,
  -- DCR-supplied software identifiers (optional). Kept for audit /
  -- display purposes only — not used for auth decisions.
  software_id        TEXT,
  software_version   TEXT,
  -- Public clients (PKCE-required, no client_secret). MCP clients
  -- are public by default; we keep the column for the rare confidential
  -- client (server-to-server) case. Hashed (sha256-hex) when set.
  client_secret_hash TEXT,
  created_at         INTEGER NOT NULL,
  -- Username of the operator who triggered first registration. Null
  -- for true DCR (no auth on /oauth/register). Populated when an admin
  -- explicitly creates a client.
  created_by         TEXT
);

CREATE INDEX idx_oauth_clients_created_at ON oauth_clients (created_at DESC);

CREATE TABLE oauth_auth_codes (
  -- sha256-hex of the opaque code. The plaintext never lands in the
  -- DB; the only place it exists is in the browser redirect URL and
  -- the client's PKCE state.
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL,
  -- Space-separated list of scope strings. Per-tool scopes look like
  -- `tool:search`, `tool:upload_text`, etc.
  scopes         TEXT NOT NULL,
  -- PKCE: code_challenge (S256) + method, verifier-checked on token
  -- exchange. Codes without a challenge are rejected (PKCE required).
  code_challenge TEXT NOT NULL,
  challenge_method TEXT NOT NULL DEFAULT 'S256',
  -- Must match exactly on /oauth/token to defeat code-interception
  -- across redirect URIs.
  redirect_uri   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  -- Single-use: flipped to 1 on first successful exchange. A second
  -- attempt with the same code triggers token revocation for the
  -- entire grant (RFC 6749 §10.5 replay defense).
  used           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_oauth_codes_expires ON oauth_auth_codes (expires_at);

CREATE TABLE oauth_access_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  -- Updated on every successful /mcp call so the Connected Apps page
  -- can show "last used 2h ago" without scanning the audit log.
  last_used_at INTEGER
);

CREATE INDEX idx_oauth_access_expires ON oauth_access_tokens (expires_at);
CREATE INDEX idx_oauth_access_user_client ON oauth_access_tokens (user_id, client_id);

CREATE TABLE oauth_refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- Rolling rotation: on every refresh we issue a new token + revoke
  -- the old one. `replaced_by` lets us detect replay attempts (an
  -- attacker presenting a token we already retired) and kill the
  -- whole grant per the OAuth 2.1 security BCP.
  replaced_by TEXT,
  revoked_at  INTEGER
);

CREATE INDEX idx_oauth_refresh_user_client ON oauth_refresh_tokens (user_id, client_id);
CREATE INDEX idx_oauth_refresh_expires ON oauth_refresh_tokens (expires_at);
