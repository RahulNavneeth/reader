/**
 * `reader generate-secret` — print a 32-byte hex string suitable for
 * SESSION_SECRET. Same output as `openssl rand -hex 32`, just so users
 * who don't have openssl handy aren't blocked.
 *
 * Usage:
 *   node apps/server/dist/cli/genSecret.js
 *   docker compose exec reader node apps/server/dist/cli/genSecret.js
 */
import crypto from 'node:crypto'

process.stdout.write(crypto.randomBytes(32).toString('hex') + '\n')
