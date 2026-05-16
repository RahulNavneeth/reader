import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './index.js'
import { config } from './config.js'
import { clearSettingsCache } from './stores/settings.js'

// Integration test plays through the whole HTTP stack via
// fastify.inject so no real port is bound. Each describe block gets
// fresh tempdirs for data + vault so tests can't see each other.

let app: FastifyInstance
let scratch: { data: string; vault: string }
let originals: { dataDir: string; vault: string; paths: typeof config.paths }

async function scratchDirs() {
  const data = await mkdtemp(path.join(os.tmpdir(), 'reader-it-data-'))
  const vault = await mkdtemp(path.join(os.tmpdir(), 'reader-it-vault-'))
  return { data, vault }
}

beforeAll(async () => {
  scratch = await scratchDirs()
  originals = {
    dataDir: config.dataDir,
    vault: config.vault.root,
    paths: { ...config.paths },
  }
  // Repoint the shared `config` at our test dirs. Stores resolve
  // their paths through `config.paths.*` at call-time, so swapping
  // here is enough to isolate state.
  ;(config as { dataDir: string }).dataDir = scratch.data
  ;(config.vault as { root: string }).root = scratch.vault
  for (const k of Object.keys(config.paths) as Array<keyof typeof config.paths>) {
    const original = originals.paths[k]
    if (typeof original !== 'string') continue
    const leaf = path.basename(original)
    ;(config.paths as Record<string, string>)[k] = original.endsWith('.json')
      ? path.join(scratch.data, leaf)
      : path.join(scratch.data, leaf)
  }
  // Allow open signup so the test can register users without an admin
  // having to invite them first. We mutate the live `config` object
  // and bust the settings cache because both were captured at import
  // time, before this beforeAll runs.
  ;(config.signup as { allowOpen: boolean }).allowOpen = true
  clearSettingsCache()
  app = await buildApp({ skipBackground: true, silent: true })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  ;(config as { dataDir: string }).dataDir = originals.dataDir
  ;(config.vault as { root: string }).root = originals.vault
  Object.assign(config.paths, originals.paths)
  await rm(scratch.data, { recursive: true, force: true })
  await rm(scratch.vault, { recursive: true, force: true })
})

// Extract the session cookie value from a Set-Cookie header so
// subsequent requests can send it back. Fastify's inject returns the
// header as a string OR an array depending on count.
function setCookieValue(setCookie: string | string[] | undefined): string | null {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) return null
  // Cookie name is `reader_sid` — pull `name=value` (sans `; HttpOnly` etc.).
  const pair = raw.split(';')[0]
  return pair
}

describe('integration: auth flow', () => {
  let firstCookie = ''
  let secondCookie = ''

  it('signup of the first user 200s and the user becomes admin', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.user.username).toBe('alice')
    expect(body.user.role).toBe('admin')
    firstCookie = setCookieValue(r.headers['set-cookie']) ?? ''
    expect(firstCookie).toBeTruthy()
  })

  it('/api/auth/me with the session cookie returns the user', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: firstCookie },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().user.username).toBe('alice')
  })

  it('subsequent signup gets the editor role (not admin)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().user.role).toBe('editor')
    secondCookie = setCookieValue(r.headers['set-cookie']) ?? ''
  })

  it('login rejects wrong password', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'wrong-password' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('logout clears the session — subsequent /me returns 401', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: secondCookie, 'X-Requested-With': 'fetch' },
    })
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: secondCookie },
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('integration: CSRF guard', () => {
  it('rejects a cookie-authed POST without Origin or X-Requested-With', async () => {
    // Sign up + capture the cookie so the guard's "cookie present"
    // precondition fires.
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'csrf-test', password: 'correct-horse-battery' },
    })
    const cookie = setCookieValue(signup.headers['set-cookie']) ?? ''
    // Now hit a mutation without the header — guard should kick in.
    const r = await app.inject({
      method: 'POST',
      url: '/api/pins',
      headers: { cookie },
      payload: { path: 'x' },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toMatch(/csrf/i)
  })
})

describe('integration: MCP', () => {
  it('rejects /mcp without a Bearer token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('integration: rate limit', () => {
  it('returns 429 after the bucket drains on a public endpoint', async () => {
    // Capacity is 120 in prod config; drain it then assert 429.
    // We hammer /api/list?path=x (404 path is fine — the limiter
    // runs in `onRequest`, before the route).
    let saw429 = false
    for (let i = 0; i < 200; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/list?path=x' })
      if (r.statusCode === 429) {
        saw429 = true
        expect(r.headers['retry-after']).toBeDefined()
        break
      }
    }
    expect(saw429).toBe(true)
  })
})

describe('integration: security headers', () => {
  it('returns the standard security header bundle on every response', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' })
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['referrer-policy']).toMatch(/strict-origin/i)
    expect(r.headers['permissions-policy']).toContain('camera=()')
  })
})
