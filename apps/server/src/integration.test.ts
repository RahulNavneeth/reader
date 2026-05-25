import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './index.js'
import { config } from './config.js'
import { clearSettingsCache } from './stores/settings.js'
import { db } from './db/sqlite.js'

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

  it('per-token throttle: kicks in after sustained bursts (429 + Retry-After + audit)', async () => {
    // Mint a fresh token. Per-token rate limit is bucket-capacity
    // 60 + 5/sec refill; we can drain it with ~70 calls in a
    // tight loop and observe the 429 + audit emit.
    const { _resetMcpRateLimitForTest } = await import('./routes/mcp.js')
    _resetMcpRateLimitForTest()

    // Login alice, mint a token through the account endpoint.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    const cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    const mint = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'rate-limit-test' },
    })
    expect(mint.statusCode).toBe(200)
    const { secret, token } = mint.json() as {
      secret: string
      token: { id: string; name: string }
    }

    // Hit /mcp with a lightweight tools/list until we see a 429.
    let saw429 = false
    let retryAfter = ''
    for (let i = 0; i < 120; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: i, method: 'tools/list' },
      })
      if (r.statusCode === 429) {
        saw429 = true
        retryAfter = r.headers['retry-after'] as string
        const body = r.json() as {
          error: { message: string; data?: { retryAfterSeconds?: number } }
        }
        expect(body.error.message).toMatch(/rate limit/i)
        expect(body.error.data?.retryAfterSeconds).toBeGreaterThan(0)
        break
      }
    }
    expect(saw429).toBe(true)
    expect(Number(retryAfter)).toBeGreaterThan(0)

    // Audit entry should have landed. Bucket key for API-token
    // principals is `api:<token-id>` — see McpPrincipal in routes/mcp.
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: `api:${token.id}`, limit: 10 })
    const throttled = events.find((e) => e.action === 'mcp.throttled')
    expect(throttled?.actor).toBe('alice')
    expect((throttled?.meta as { retryAfter?: number })?.retryAfter).toBeGreaterThan(0)
  })

  it('per-token throttle uses INDEPENDENT buckets per token', async () => {
    // Reset, mint two tokens, drain the first to 429, verify the
    // second still works.
    const { _resetMcpRateLimitForTest } = await import('./routes/mcp.js')
    _resetMcpRateLimitForTest()

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    const cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    const mintA = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'token-a' },
    })
    const mintB = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'token-b' },
    })
    const secretA = (mintA.json() as { secret: string }).secret
    const secretB = (mintB.json() as { secret: string }).secret

    // Drain token A.
    let tokenADrained = false
    for (let i = 0; i < 120; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${secretA}`, 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: i, method: 'tools/list' },
      })
      if (r.statusCode === 429) {
        tokenADrained = true
        break
      }
    }
    expect(tokenADrained).toBe(true)

    // Token B should still get a 200 on the very next call.
    const bResp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${secretB}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(bResp.statusCode).toBe(200)
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

describe('integration: admin settings PATCH', () => {
  it('persists ollama.chatModel + chatEnabled (regression: Zod schema was stripping them)', async () => {
    // Sign up an admin (first user gets admin role by virtue of the
    // bootstrap path; we already created `alice` above, but that's
    // in a different describe block with its own beforeAll. Reuse
    // the live `app` and sign up a fresh user — they get editor by
    // default. We need admin, so use the admin-bootstrap path
    // instead by promoting via a separate route would be too much
    // setup. Easier: this test depends on the same `app` instance
    // and the first signed-up user is alice (admin from the auth
    // describe above), but cookie state isn't shared across tests.
    // Sign in as alice using the password set up earlier.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    const cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(cookie).toBeTruthy()

    const r = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { ollama: { chatEnabled: false, chatModel: 'qwen2.5:0.5b-instruct' } },
    })
    expect(r.statusCode).toBe(200)

    const sys = await app.inject({
      method: 'GET',
      url: '/api/admin/system',
      headers: { cookie },
    })
    expect(sys.statusCode).toBe(200)
    const body = sys.json()
    expect(body.ollama.chatEnabled).toBe(false)
    expect(body.ollama.chatModel).toBe('qwen2.5:0.5b-instruct')

    // Restore so it doesn't leak into the chat-endpoints block.
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { ollama: { chatEnabled: true } },
    })
  })
})

describe('integration: chat endpoints', () => {
  let cookie = ''

  it('signs up a user and gets a session', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'chatuser', password: 'correct-horse-battery' },
    })
    expect(r.statusCode).toBe(200)
    cookie = setCookieValue(r.headers['set-cookie']) ?? ''
    expect(cookie).toBeTruthy()
  })

  it('rejects unauthenticated chat history reads', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/chat/anydoc/messages',
    })
    expect(r.statusCode).toBe(401)
  })

  it('returns an empty thread for a doc with no prior chat', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/chat/missing-doc/messages',
      headers: { cookie },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().messages).toEqual([])
  })

  it('rejects a POST stream with empty content (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/chat/some-doc/stream',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { content: '' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/content required/i)
  })

  it('rejects a POST stream with a wildly oversized message (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/chat/some-doc/stream',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { content: 'x'.repeat(5000) },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/too long/i)
  })

  it('rejects a POST stream against a missing doc (400 from assembleContext)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/chat/missing-doc/stream',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { content: 'hello?' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/document not found/i)
  })

  it('clears chat history (DELETE) without complaint when thread is empty', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/chat/missing-doc',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().cleared).toBe(0)
  })
})

describe('integration: AI memories', () => {
  let cookie = ''

  it('signs up + logs in', async () => {
    // Reuse the existing alice; signup would 409 since the auth-flow
    // describe block above already registered her. Just log in.
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(r.statusCode).toBe(200)
    cookie = setCookieValue(r.headers['set-cookie']) ?? ''
    expect(cookie).toBeTruthy()
  })

  it('rejects /api/ai-memories without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ai-memories' })
    expect(r.statusCode).toBe(401)
  })

  it('POST + GET roundtrips a permanent memory', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/ai-memories',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { fact: 'currency is ₹' },
    })
    expect(add.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/ai-memories', headers: { cookie } })
    expect(list.statusCode).toBe(200)
    const facts = list.json().memories.map((m: { fact: string }) => m.fact)
    expect(facts).toContain('currency is ₹')
  })

  it('rejects an empty fact (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/ai-memories',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { fact: '   ' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('DELETE removes the memory and 404s on the next try', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/ai-memories',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { fact: 'temporary fact' },
    })
    const id = add.json().memory.id
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/ai-memories/${id}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(del.statusCode).toBe(200)
    const del2 = await app.inject({
      method: 'DELETE',
      url: `/api/ai-memories/${id}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(del2.statusCode).toBe(404)
  })

  it('rejects feedback without question/correction', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/chat/anydoc/feedback',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { correction: '' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('accepts a complete feedback note', async () => {
    // chat_error_notes has an FK on doc_id → documents(id), so we
    // need a real doc row to feedback against. Insert directly
    // instead of going through the upload pipeline (which would
    // pull in the whole ingest stack into this test).
    const docId = 'feedback-stub-doc'
    const now = Date.now()
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?)`,
      )
      .run(docId, 'alice', 'stub.md', 'Stub', 'stub.md', 'text/markdown', now, now)
    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/feedback`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { question: 'what is X?', correction: 'X is actually Y', wrongAnswer: 'X is Z' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().note.correction).toBe('X is actually Y')
  })
})

describe('integration: slash commands', () => {
  it('parses /remember + persists the fact', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    const cmd = parseSlashCommand('/remember currency is ₹')
    expect(cmd).toEqual({ kind: 'remember', fact: 'currency is ₹' })
  })

  it('parses /remember-here with multi-word arg', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    const cmd = parseSlashCommand('/remember-here PPFCF = Parag Parikh Flexi Cap Fund')
    expect(cmd).toEqual({ kind: 'remember-here', fact: 'PPFCF = Parag Parikh Flexi Cap Fund' })
  })

  it('parses bare /memories', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    expect(parseSlashCommand('/memories')).toEqual({ kind: 'memories' })
  })

  it('parses /forget with substring', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    expect(parseSlashCommand('/forget currency')).toEqual({ kind: 'forget', needle: 'currency' })
  })

  it('returns null for non-commands', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    expect(parseSlashCommand('hi there')).toBeNull()
    expect(parseSlashCommand('explain scenario b')).toBeNull()
  })

  it('returns null for /remember with no argument (falls through to LLM)', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    expect(parseSlashCommand('/remember')).toBeNull()
    expect(parseSlashCommand('/remember   ')).toBeNull()
  })

  it('returns null for unknown slash verbs', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    expect(parseSlashCommand('/help me')).toBeNull()
  })

  it('tolerates leading whitespace', async () => {
    const { parseSlashCommand } = await import('./routes/chat.js')
    expect(parseSlashCommand('  \n /remember currency is ₹')).toEqual({ kind: 'remember', fact: 'currency is ₹' })
  })
})

describe('integration: chat apply-edit', () => {
  let cookie = ''
  let docId = ''

  it('logs in + seeds a markdown doc with sections', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(cookie).toBeTruthy()

    // Insert the doc directly so we don't pull the full upload
    // pipeline into the test. We need a real file on disk too,
    // since apply-edit reads it.
    docId = 'apply-edit-doc'
    const now = Date.now()
    const body = '# Heading\n\n## Caveats\n\nshort body.\n'
    const sha = await import('node:crypto').then((c) =>
      c.createHash('sha256').update(body).digest('hex'),
    )
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(docId, 'alice', 'apply-edit-doc.md', 'Apply Edit Doc', 'apply-edit-doc.md', 'text/markdown', body.length, sha, now, now)
    // Write the file to the user vault so the apply path can
    // read + write it.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'apply-edit-doc.md')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, body)

    // Insert an assistant chat turn with a pending edit.
    db()
      .prepare(
        `INSERT INTO chat_messages
           (id, doc_id, user_id, role, content, citations, memories_used,
            error_text, pending_edit, edit_applied_at, edit_target_sha256,
            created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        'asst-1',
        docId,
        'alice',
        'assistant',
        'Here is a shorter Caveats.',
        JSON.stringify([
          { op: 'replace_section', heading: 'Caveats', content: 'tiny.' },
        ]),
        sha,
        now,
      )
  })

  it('rejects apply-edit with no messageId (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/apply-edit`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {},
    })
    expect(r.statusCode).toBe(400)
  })

  it('rejects unknown messageId (404)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/apply-edit`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { messageId: 'no-such-id' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('applies a pending replace_section, marks applied, returns updated meta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/apply-edit`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { messageId: 'asst-1' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)
    expect(body.document.bytes).toBeGreaterThan(0)

    // Disk reflects the edit.
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'apply-edit-doc.md')
    const text = (await readFile(abs)).toString('utf8')
    expect(text).toContain('tiny.')
    expect(text).not.toContain('short body.')
  })

  it('refuses a second apply on the same turn (409 already applied)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/apply-edit`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { messageId: 'asst-1' },
    })
    expect(r.statusCode).toBe(409)
  })

  it('refuses on sha mismatch (conflict)', async () => {
    // Insert a new assistant turn with a stale sha.
    db()
      .prepare(
        `INSERT INTO chat_messages
           (id, doc_id, user_id, role, content, citations, memories_used,
            error_text, pending_edit, edit_applied_at, edit_target_sha256,
            created_at)
         VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        'asst-2',
        docId,
        'alice',
        'Another edit.',
        JSON.stringify([{ op: 'delete_section', heading: 'Caveats' }]),
        'stale-sha-deadbeef',
        Date.now(),
      )
    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/apply-edit`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { messageId: 'asst-2' },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('sha_mismatch')
  })

  it('DELETE discards a pending edit, content stays', async () => {
    db()
      .prepare(
        `INSERT INTO chat_messages
           (id, doc_id, user_id, role, content, citations, memories_used,
            error_text, pending_edit, edit_applied_at, edit_target_sha256,
            created_at)
         VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        'asst-3',
        docId,
        'alice',
        'Maybe rename this.',
        JSON.stringify([{ op: 'delete_section', heading: 'Heading' }]),
        null,
        Date.now(),
      )
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/chat/${docId}/pending-edit/asst-3`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)

    // Second discard should 404 — payload's gone.
    const r2 = await app.inject({
      method: 'DELETE',
      url: `/api/chat/${docId}/pending-edit/asst-3`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r2.statusCode).toBe(404)
  })

  it('apply-edit handles a rewrite_file op (full-content replace)', async () => {
    // Seed a fresh CSV file so the rewrite is a full-content swap.
    const { writeFile, readFile, mkdir } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    const aliceVault = pathMod.join(config.vault.root, 'alice')
    await mkdir(aliceVault, { recursive: true })
    const csvAbs = pathMod.join(aliceVault, 'apply-rewrite.csv')
    await writeFile(
      csvAbs,
      'name,team\nalice,platform\nbob,growth\ncarol,platform\n',
      'utf8',
    )
    // Build a meta record so apply-edit can find it.
    const { ingestDocument } = await import('./services/ingest.js')
    const { saveMeta } = await import('./stores/documents.js')
    const { sha256Of } = await import('./stores/documents.js')
    const { nanoid } = await import('nanoid')
    const csvBuf = await readFile(csvAbs)
    const csvDocId = nanoid()
    await saveMeta({
      id: csvDocId,
      title: 'apply-rewrite',
      originalFilename: 'apply-rewrite.csv',
      mime: 'text/csv; charset=utf-8',
      bytes: csvBuf.length,
      sha256: sha256Of(csvBuf),
      storageKey: 'apply-rewrite.csv',
      owner: 'alice',
      acl: { readers: [], editors: [] },
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ingest: { status: 'pending', embedded: false },
    })
    await ingestDocument(
      {
        id: csvDocId,
        title: 'apply-rewrite',
        originalFilename: 'apply-rewrite.csv',
        mime: 'text/csv; charset=utf-8',
        bytes: csvBuf.length,
        sha256: sha256Of(csvBuf),
        storageKey: 'apply-rewrite.csv',
        owner: 'alice',
        acl: { readers: [], editors: [] },
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ingest: { status: 'pending', embedded: false },
      },
      csvBuf,
    )

    // Insert an assistant chat turn with a rewrite_file pending edit.
    const rewriteContent =
      'name,team\nalice,rahul\nbob,growth\ncarol,rahul\n'
    db()
      .prepare(
        `INSERT INTO chat_messages
           (id, doc_id, user_id, role, content, citations, memories_used,
            error_text, pending_edit, edit_applied_at, edit_target_sha256,
            created_at)
         VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        'asst-rewrite-1',
        csvDocId,
        'alice',
        'Updated team to rahul where platform.',
        JSON.stringify([{ op: 'rewrite_file', content: rewriteContent }]),
        sha256Of(csvBuf),
        Date.now(),
      )

    const r = await app.inject({
      method: 'POST',
      url: `/api/chat/${csvDocId}/apply-edit`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { messageId: 'asst-rewrite-1' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().ok).toBe(true)

    const after = await readFile(csvAbs, 'utf8')
    expect(after).toBe(rewriteContent)
    // Make sure the old platform → rahul translation happened.
    expect(after).toContain('alice,rahul')
    expect(after).toContain('carol,rahul')
    expect(after).not.toContain('alice,platform')
  })
})

// ── Per-op apply / discard ────────────────────────────────────────
// Covers the granular Accept / Reject preview flow: each op in a
// multi-op turn can be committed independently, the doc's sha is
// re-anchored between calls so a second per-op apply doesn't 409
// on stale sha, and the message-level applied flag flips only once
// every op carries its own appliedAt.
describe('integration: chat per-op apply / discard', () => {
  let cookie = ''
  let docId = ''
  const startBody = '# Doc\n\n## A\n\nalpha body.\n\n## B\n\nbeta body.\n\n## C\n\ngamma body.\n'
  const apply = (msgId: string, opIndex: number) =>
    app.inject({
      method: 'POST',
      url: `/api/chat/${docId}/apply-op`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { messageId: msgId, opIndex },
    })
  const discard = (msgId: string, opIndex: number) =>
    app.inject({
      method: 'DELETE',
      url: `/api/chat/${docId}/pending-edit/${msgId}/op/${opIndex}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })

  it('logs in + seeds a 3-section doc with a 3-op pending edit', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''

    docId = 'per-op-doc'
    const now = Date.now()
    const sha = await import('node:crypto').then((c) =>
      c.createHash('sha256').update(startBody).digest('hex'),
    )
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(docId, 'alice', 'per-op-doc.md', 'Per-Op', 'per-op-doc.md', 'text/markdown', startBody.length, sha, now, now)
    const { mkdir, writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'per-op-doc.md')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, startBody)

    db()
      .prepare(
        `INSERT INTO chat_messages
           (id, doc_id, user_id, role, content, citations, memories_used,
            error_text, pending_edit, edit_applied_at, edit_target_sha256,
            created_at)
         VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        'asst-perop',
        docId,
        'alice',
        'Three edits, one per section.',
        JSON.stringify([
          { op: 'replace_section', heading: 'A', content: 'AAA.' },
          { op: 'replace_section', heading: 'B', content: 'BBB.' },
          { op: 'replace_section', heading: 'C', content: 'CCC.' },
        ]),
        sha,
        now,
      )
  })

  it('applies a single op, stamps its appliedAt, leaves others pending', async () => {
    const r = await apply('asst-perop', 0)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)

    const row = db()
      .prepare(`SELECT pending_edit, edit_applied_at FROM chat_messages WHERE id = ?`)
      .get('asst-perop') as { pending_edit: string; edit_applied_at: number | null }
    const ops = JSON.parse(row.pending_edit) as Array<{ appliedAt?: number | null }>
    expect(ops).toHaveLength(3)
    expect(ops[0].appliedAt).toBeTruthy()
    expect(ops[1].appliedAt ?? null).toBeNull()
    expect(ops[2].appliedAt ?? null).toBeNull()
    // Message-level applied flag stays null until ALL ops land.
    expect(row.edit_applied_at).toBeNull()

    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const text = (await readFile(path.join(config.vault.root, 'alice', 'per-op-doc.md'))).toString('utf8')
    expect(text).toContain('AAA.')
    expect(text).not.toContain('alpha body.')
    expect(text).toContain('beta body.')
    expect(text).toContain('gamma body.')
  })

  it('refuses re-applying the same op (409)', async () => {
    const r = await apply('asst-perop', 0)
    expect(r.statusCode).toBe(409)
  })

  // The regression that motivated this whole audit pass: the
  // second per-op apply used to 409 on sha_mismatch because we
  // forgot to update edit_target_sha256 after the first apply.
  it('re-anchors sha so a second per-op apply succeeds', async () => {
    const r = await apply('asst-perop', 1)
    expect(r.statusCode).toBe(200)

    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const text = (await readFile(path.join(config.vault.root, 'alice', 'per-op-doc.md'))).toString('utf8')
    expect(text).toContain('AAA.')
    expect(text).toContain('BBB.')
    expect(text).toContain('gamma body.')
  })

  it('discarding the final pending op shrinks array + flips message-level applied (since remaining were all applied)', async () => {
    // Discard the third (still-pending) op. After this, only the
    // two appliedAt-stamped ops remain → server should mark the
    // whole turn applied so the card shows pills.
    const r = await discard('asst-perop', 2)
    expect(r.statusCode).toBe(200)

    const row = db()
      .prepare(`SELECT pending_edit, edit_applied_at FROM chat_messages WHERE id = ?`)
      .get('asst-perop') as { pending_edit: string; edit_applied_at: number | null }
    const ops = JSON.parse(row.pending_edit) as Array<unknown>
    expect(ops).toHaveLength(2)
    expect(row.edit_applied_at).toBeTruthy()
  })

  it('refuses to discard an already-applied op (409)', async () => {
    // op[0] in the (now-shrunken) array carries appliedAt — can't
    // discard it.
    const r = await discard('asst-perop', 0)
    expect(r.statusCode).toBe(409)
  })

  it('refuses apply-op on a now-fully-applied turn (409)', async () => {
    // edit_applied_at was set above; further apply-ops should
    // bounce.
    const r = await apply('asst-perop', 0)
    expect(r.statusCode).toBe(409)
  })

  it('preview endpoint surfaces opPreviews + per-op applied flags', async () => {
    // Seed a fresh turn so the doc still has a pending baseline to
    // preview against. We don't want to depend on the prior turn,
    // which was fully resolved.
    const now = Date.now()
    const liveSha = await import('node:crypto').then(async (c) => {
      const { readFile } = await import('node:fs/promises')
      const path = await import('node:path')
      const buf = await readFile(path.join(config.vault.root, 'alice', 'per-op-doc.md'))
      return c.createHash('sha256').update(buf).digest('hex')
    })
    db()
      .prepare(
        `INSERT INTO chat_messages
           (id, doc_id, user_id, role, content, citations, memories_used,
            error_text, pending_edit, edit_applied_at, edit_target_sha256,
            created_at)
         VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        'asst-preview',
        docId,
        'alice',
        'Two more.',
        JSON.stringify([
          { op: 'replace_section', heading: 'C', content: 'GGG.', appliedAt: now - 1000 },
          { op: 'replace_section', heading: 'C', content: 'HHH.' },
        ]),
        liveSha,
        now,
      )

    const r = await app.inject({
      method: 'GET',
      url: `/api/chat/${docId}/messages/asst-preview/preview`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(Array.isArray(body.opPreviews)).toBe(true)
    expect(body.opPreviews).toHaveLength(2)
    expect(body.opPreviews[0].applied).toBe(true)
    expect(body.opPreviews[1].applied ?? false).toBe(false)
    expect(typeof body.opPreviews[1].next).toBe('string')
  })

  it('apply-op on out-of-range opIndex returns 409 stale-state', async () => {
    // 409 (not 400) — the server treats this as "your client has stale
    // state, refresh" rather than a malformed request. The client UI
    // auto-refetches the preview on this code.
    const r = await apply('asst-preview', 99)
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('pending_edits_stale')
  })

  it('discard-op rejects unknown opIndex (400)', async () => {
    const r = await discard('asst-preview', 99)
    expect(r.statusCode).toBe(400)
  })

  it('discard-op rejects negative opIndex (400)', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/chat/${docId}/pending-edit/asst-preview/op/-1`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('audits version.snapshot with reader-ai attribution on per-op apply', async () => {
    // Apply the still-pending op on asst-preview, then sweep the
    // audit log for a version.snapshot row attributed to Reader AI.
    const r = await apply('asst-preview', 1)
    expect(r.statusCode).toBe(200)

    const { listAudit } = await import('./stores/audit.js')
    const entries = await listAudit({ target: docId, limit: 50 })
    const snap = entries.find(
      (e) => e.action === 'version.snapshot' && e.meta?.source === 'reader-ai',
    )
    expect(snap).toBeTruthy()
    expect(snap?.actor).toBe('alice')
  })
})

// ── Pins routes ───────────────────────────────────────────────────
// Covers the GET / POST / DELETE happy paths, the access guards
// (you can't pin a file in someone else's vault without a share),
// auto-pruning of dead pins on list, and audit emits for pin.add /
// pin.remove (including the system-attributed auto-cleanup row).
describe('integration: pins', () => {
  let cookie = ''
  const listPins = () =>
    app.inject({
      method: 'GET',
      url: '/api/pins',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  const addPin = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/pins',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: body,
    })
  const deletePin = (body: Record<string, unknown>) =>
    app.inject({
      method: 'DELETE',
      url: '/api/pins',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: body,
    })

  it('logs in alice + writes a vault file she can pin', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''

    const { mkdir, writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'pin-target.md')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, '# pin me')
  })

  it('starts with an empty pin list', async () => {
    const r = await listPins()
    expect(r.statusCode).toBe(200)
    expect(r.json().pins).toEqual([])
  })

  it('rejects POST without a path (400)', async () => {
    const r = await addPin({})
    expect(r.statusCode).toBe(400)
  })

  it('pins a real own-vault file', async () => {
    const r = await addPin({ path: 'pin-target.md', label: 'fav doc' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.pins).toHaveLength(1)
    expect(body.pins[0].storageKey).toBe('pin-target.md')
    expect(body.pins[0].label).toBe('fav doc')
  })

  it('audits pin.add', async () => {
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'pin-target.md' })
    const add = events.find((e) => e.action === 'pin.add')
    expect(add?.actor).toBe('alice')
    expect((add?.meta as { label?: string })?.label).toBe('fav doc')
  })

  it('refuses to pin a path the user has no access to (403)', async () => {
    // Different owner, no share grant. Must 403, not silently pin.
    const r = await addPin({ path: 'someone-else.md', owner: 'bob' })
    expect([403, 404]).toContain(r.statusCode)
  })

  it('refuses to pin a non-existent file (404)', async () => {
    const r = await addPin({ path: 'does-not-exist.md' })
    expect(r.statusCode).toBe(404)
  })

  it('DELETE removes the pin and audits it', async () => {
    const r = await deletePin({ path: 'pin-target.md' })
    expect(r.statusCode).toBe(200)
    expect(r.json().pins).toEqual([])

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'pin-target.md' })
    const remove = events.find(
      (e) => e.action === 'pin.remove' && e.actor === 'alice',
    )
    expect(remove).toBeTruthy()
  })

  it('auto-prunes pins whose target no longer exists, with a system audit', async () => {
    // Pin a file, then delete the file on disk → next listPins
    // call should drop the pin and audit pin.remove as the system.
    const { writeFile, unlink } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'soon-gone.md')
    await writeFile(abs, 'temp')
    const addR = await addPin({ path: 'soon-gone.md' })
    expect(addR.statusCode).toBe(200)
    expect(addR.json().pins).toHaveLength(1)
    await unlink(abs)

    const listR = await listPins()
    expect(listR.statusCode).toBe(200)
    expect(listR.json().pins).toEqual([])

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'soon-gone.md' })
    const auto = events.find(
      (e) =>
        e.action === 'pin.remove' &&
        e.actor === 'system' &&
        (e.meta as { source?: string })?.source === 'auto-cleanup',
    )
    expect(auto).toBeTruthy()
    expect((auto?.meta as { reason?: string })?.reason).toBe('target-missing')
  })

  it('requires auth — anonymous GET 401s', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/pins',
      headers: { 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(401)
  })
})

// ── Vault routes ──────────────────────────────────────────────────
// Coverage for the largest unauthenticated-surface file in the
// codebase. Hits the security-critical paths (auth gates, cross-
// owner access denial) and the mutation flows that audit (upload,
// visibility, tags, trash, restore, move, index, mkdir). Reads
// are exercised end-to-end through fastify.inject so any
// middleware regression (CSRF, rate-limit, security headers)
// would also trip the relevant assertion below.
describe('integration: vault routes', () => {
  let cookie = ''
  /** Seed a doc directly via DB + disk so the test can exercise
   *  the read / mutate endpoints without pulling the upload
   *  pipeline into every suite. Tags live in the document_tags
   *  join table (not a column on documents). */
  async function seed(
    docId: string,
    storageKey: string,
    body = 'seeded body',
    opts?: { mime?: string; tags?: string[]; isPublic?: boolean },
  ) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const { createHash } = await import('node:crypto')
    const sha = createHash('sha256').update(body).digest('hex')
    const abs = path.join(config.vault.root, 'alice', storageKey)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, body)
    const now = Date.now()
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, public, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docId,
        'alice',
        storageKey,
        storageKey,
        storageKey,
        opts?.mime ?? 'text/markdown',
        body.length,
        sha,
        opts?.isPublic ? 1 : 0,
        now,
        now,
      )
    if (opts?.tags && opts.tags.length > 0) {
      const ins = db().prepare(`INSERT INTO document_tags (doc_id, tag) VALUES (?, ?)`)
      for (const t of opts.tags) ins.run(docId, t)
    }
  }

  it('logs in alice', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(cookie).toBeTruthy()
  })

  // ── Reads ────────────────────────────────────────────────────────

  it('GET /api/file/text 401s when unauthenticated', async () => {
    await seed('vault-read-1', 'vault-read-1.md', 'hello')
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/text?path=vault-read-1.md',
      headers: { 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('GET /api/file/text returns the file body for the owner', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/text?path=vault-read-1.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().content).toBe('hello')
  })

  it('GET /api/file/raw streams bytes for the owner', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/raw?path=vault-read-1.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.body).toBe('hello')
  })

  it('GET /api/file/meta returns the doc record', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/meta?path=vault-read-1.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const meta = r.json().meta
    expect(meta.id).toBe('vault-read-1')
    expect(meta.owner).toBe('alice')
    expect(meta.bytes).toBe(5)
  })

  it('GET /api/file/text returns 404 for an unknown path', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/text?path=nope.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('GET /api/list returns owner files', async () => {
    await seed('vault-list-1', 'list-1.md', 'one')
    await seed('vault-list-2', 'subdir/list-2.md', 'two')
    const r = await app.inject({
      method: 'GET',
      url: '/api/list?path=',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    // Endpoint returns { path, items: [...] }, not { entries }.
    const body = r.json()
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.some((e: { name: string }) => e.name === 'list-1.md')).toBe(true)
    // Sub-folder entry is included as a dir-typed item.
    expect(body.items.some((e: { name: string; type: string }) => e.name === 'subdir' && e.type === 'dir')).toBe(true)
  })

  // ── Visibility ───────────────────────────────────────────────────

  it('POST /api/file/visibility makes a file public + audits', async () => {
    await seed('vault-vis-1', 'vis-1.md')
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/visibility',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'vis-1.md', public: true },
    })
    expect(r.statusCode).toBe(200)
    const row = db()
      .prepare(`SELECT public FROM documents WHERE storage_key = 'vis-1.md' AND owner = 'alice'`)
      .get() as { public: number }
    expect(row.public).toBe(1)

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'vis-1.md' })
    const vis = events.find((e) => e.action === 'vault.visibility')
    expect(vis?.actor).toBe('alice')
    expect((vis?.meta as { public?: boolean })?.public).toBe(true)
  })

  it('POST /api/file/visibility flips back to private', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/visibility',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'vis-1.md', public: false },
    })
    expect(r.statusCode).toBe(200)
    const row = db()
      .prepare(`SELECT public FROM documents WHERE storage_key = 'vis-1.md' AND owner = 'alice'`)
      .get() as { public: number }
    expect(row.public).toBe(0)
  })

  it('POST /api/file/visibility refuses on a doc the user does not own', async () => {
    // Seed a doc owned by bob (not alice).
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('vault-bob-1', 'bob', 'bobs-secret.md', 'Bob', 'bobs-secret.md', 'text/markdown', 0, '', Date.now(), Date.now())
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/visibility',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'bobs-secret.md', public: true, owner: 'bob' },
    })
    expect([403, 404]).toContain(r.statusCode)
  })

  // ── Tags ─────────────────────────────────────────────────────────

  it('POST /api/file/tags sets tags + audits', async () => {
    await seed('vault-tag-1', 'tag-1.md')
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/tags',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'tag-1.md', tags: ['draft', 'idea'] },
    })
    expect(r.statusCode).toBe(200)
    // Tags live in the document_tags join table.
    const rows = db()
      .prepare(`SELECT tag FROM document_tags WHERE doc_id = 'vault-tag-1' ORDER BY tag`)
      .all() as Array<{ tag: string }>
    expect(rows.map((r) => r.tag)).toEqual(['draft', 'idea'])

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'tag-1.md' })
    const tag = events.find((e) => e.action === 'vault.tags')
    expect(tag?.actor).toBe('alice')
    expect((tag?.meta as { tags?: string[] })?.tags).toEqual(['draft', 'idea'])
  })

  it('POST /api/file/tags can clear tags via empty array', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/tags',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'tag-1.md', tags: [] },
    })
    expect(r.statusCode).toBe(200)
    const rows = db()
      .prepare(`SELECT tag FROM document_tags WHERE doc_id = 'vault-tag-1'`)
      .all() as Array<{ tag: string }>
    expect(rows).toEqual([])
  })

  // ── Delete / restore / purge ─────────────────────────────────────

  it('DELETE /api/file trashes the file (moves it off disk) + audits vault.trash', async () => {
    await seed('vault-del-1', 'del-1.md', 'to be trashed')
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/file?path=del-1.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    // Vault file is gone (moved to trash dir on disk).
    const { stat } = await import('node:fs/promises')
    const path = await import('node:path')
    const exists = await stat(path.join(config.vault.root, 'alice', 'del-1.md')).catch(() => null)
    expect(exists).toBeNull()

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'del-1.md' })
    expect(events.find((e) => e.action === 'vault.trash')).toBeTruthy()
  })

  it('GET /api/trash lists trashed entries', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/trash',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(Array.isArray(body.entries)).toBe(true)
    // Trash entries are keyed by a generated id, not the docId, but
    // the storageKey survives so we can find ours that way.
    expect(
      body.entries.some(
        (e: { storageKey?: string }) => e.storageKey === 'del-1.md',
      ),
    ).toBe(true)
  })

  // ── Folder ops ───────────────────────────────────────────────────

  it('POST /api/folder creates a directory + audits vault.mkdir', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/folder',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'newfolder' },
    })
    expect(r.statusCode).toBe(200)
    const { stat } = await import('node:fs/promises')
    const path = await import('node:path')
    const s = await stat(path.join(config.vault.root, 'alice', 'newfolder')).catch(() => null)
    expect(s?.isDirectory()).toBe(true)

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'newfolder' })
    expect(events.find((e) => e.action === 'vault.mkdir')).toBeTruthy()
  })

  it('POST /api/folder/visibility flips a folder public', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/folder/visibility',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'newfolder', public: true },
    })
    expect(r.statusCode).toBe(200)
  })

  it('POST /api/folder/tags writes folder tags', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/folder/tags',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'newfolder', tags: ['work', 'archive'] },
    })
    expect(r.statusCode).toBe(200)
  })

  it('GET /api/folder/meta returns folder meta with the new tags', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/folder/meta?path=newfolder',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    // Response shape is { folder: { ... } }, not { meta: ... }.
    // Folder-tags endpoint dedups + sorts alphabetically, so the
    // returned order is ['archive', 'work'] not the input order.
    const body = r.json()
    expect(body.folder.tags).toEqual(['archive', 'work'])
    expect(body.folder.public).toBe(true)
  })

  it('GET /api/folder/activity surfaces folder-scoped events', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/folder/activity?path=newfolder',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(Array.isArray(body.entries)).toBe(true)
    // Should include the visibility + tags edits we just did.
    const actions = body.entries.map((e: { action: string }) => e.action)
    expect(actions).toContain('vault.folder-visibility')
    expect(actions).toContain('vault.folder-tags')
  })

  // ── Move ─────────────────────────────────────────────────────────

  it('POST /api/file/move renames a file + audits vault.move', async () => {
    await seed('vault-move-1', 'move-src.md', 'movable')
    // Defensive cleanup — any leftover at the destination from a
    // prior test (or a half-finished run) would 409 with
    // "destination already exists". The move endpoint refuses to
    // clobber, intentionally.
    {
      const { rm } = await import('node:fs/promises')
      const path = await import('node:path')
      await rm(path.join(config.vault.root, 'alice', 'move-dst.md'), { force: true })
    }
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/move',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      // Endpoint expects {from, to}, NOT {path, to} — regression
      // guard if anyone refactors the body shape.
      payload: { from: 'move-src.md', to: 'move-dst.md' },
    })
    expect(r.statusCode).toBe(200)
    const row = db()
      .prepare(`SELECT storage_key FROM documents WHERE id = 'vault-move-1'`)
      .get() as { storage_key: string }
    expect(row.storage_key).toBe('move-dst.md')
    const { stat } = await import('node:fs/promises')
    const path = await import('node:path')
    expect(await stat(path.join(config.vault.root, 'alice', 'move-dst.md')).catch(() => null)).toBeTruthy()

    // Audit is keyed on the SOURCE path, with the new path in meta.
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'move-src.md' })
    const move = events.find((e) => e.action === 'vault.move')
    expect(move).toBeTruthy()
    expect((move?.meta as { to?: string })?.to).toBe('move-dst.md')
  })

  // ── Versions ─────────────────────────────────────────────────────

  it('GET /api/file/versions returns [] for a doc with no snapshots', async () => {
    await seed('vault-ver-1', 'ver-1.md')
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/versions?path=ver-1.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().versions).toEqual([])
  })

  // ── Activity ─────────────────────────────────────────────────────

  it('GET /api/file/activity returns this file\'s audit entries', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/activity?path=tag-1.md',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const actions = r.json().entries.map((e: { action: string }) => e.action)
    // We set + cleared tags above; both should show in this feed.
    expect(actions).toContain('vault.tags')
  })

  // ── Tags listing ─────────────────────────────────────────────────

  it('GET /api/tags returns the user\'s tag universe', async () => {
    await seed('vault-tagset-1', 'tagset-1.md', 'a', { tags: ['alpha', 'beta'] })
    await seed('vault-tagset-2', 'tagset-2.md', 'b', { tags: ['beta', 'gamma'] })
    const r = await app.inject({
      method: 'GET',
      url: '/api/tags',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    const names = body.tags.map((t: { tag: string }) => t.tag)
    expect(names).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']))
  })

  // ── 401 / 403 / 404 guards across the surface ────────────────────

  it('every mutation endpoint 401s without auth', async () => {
    const targets = [
      { method: 'POST', url: '/api/file/visibility', payload: { path: 'x.md', public: true } },
      { method: 'POST', url: '/api/file/tags', payload: { path: 'x.md', tags: [] } },
      { method: 'POST', url: '/api/file/move', payload: { path: 'x.md', to: 'y.md' } },
      { method: 'POST', url: '/api/folder', payload: { path: 'z' } },
      { method: 'DELETE', url: '/api/file?path=x.md' },
      { method: 'POST', url: '/api/file/index', payload: { path: 'x.md' } },
    ] as const
    for (const t of targets) {
      const r = await app.inject({
        method: t.method,
        url: t.url,
        headers: { 'X-Requested-With': 'fetch' },
        payload: 'payload' in t ? t.payload : undefined,
      })
      expect(r.statusCode, `${t.method} ${t.url}`).toBe(401)
    }
  })
})

// ── Auth login lockout ────────────────────────────────────────────
// LOGIN_MAX_FAILURES wrong-password attempts within LOGIN_WINDOW_MS
// (15 min) locks the (ip, username) bucket for 15 min. Tests use a
// fresh username so we don't interfere with the existing alice
// session in other suites. Each failure should:
//   • 401 on the attempt itself
//   • emit auth.login.failed audit
// After the cap: subsequent attempts (even with the correct
// password) must 429 with Retry-After + auth.login.throttled audit.
describe('integration: auth login lockout', () => {
  let lockUser = ''
  beforeAll(async () => {
    // Unique user so we control the bucket independently of other
    // tests' alice/bob sessions.
    lockUser = `locktest-${Date.now()}`
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: lockUser, password: 'right-password-here' },
    })
    expect(signup.statusCode).toBe(200)
  })

  it('returns 401 on a single wrong password', async () => {
    // Wrong password must be ≥ 8 chars to pass the credSchema
    // (min 8) — otherwise we'd 400 at Zod and never reach the
    // auth check we're trying to exercise.
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: lockUser, password: 'wrong-pw-1' },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toMatch(/invalid credentials/i)
  })

  it('locks after 5 failures and 429s with Retry-After', async () => {
    // 4 more failures (we already burned 1 above) → trips the cap.
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: lockUser, password: `wrong-pw-${i + 2}` },
      })
      expect(r.statusCode).toBe(401)
    }
    // The 6th attempt — even with the right password — must 429.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: lockUser, password: 'right-password-here' },
    })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBeTruthy()
    const body = blocked.json()
    expect(body.error).toMatch(/too many failed attempts/i)
    expect(typeof body.retryAfter).toBe('number')
    expect(body.retryAfter).toBeGreaterThan(0)
  })

  it('audits auth.login.failed for wrong-password attempts', async () => {
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ limit: 50 })
    const failures = events.filter(
      (e) => e.action === 'auth.login.failed' && e.actor === lockUser,
    )
    expect(failures.length).toBeGreaterThanOrEqual(5)
  })

  it('audits auth.login.throttled when the bucket trips', async () => {
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ limit: 50 })
    const throttled = events.find(
      (e) => e.action === 'auth.login.throttled' && e.actor === lockUser,
    )
    expect(throttled).toBeTruthy()
    expect((throttled?.meta as { retryAfter?: number })?.retryAfter).toBeGreaterThan(0)
  })

  it('successful signup still works for OTHER users while one is locked', async () => {
    // The lockout is per-(ip, username), not per-ip. A different
    // username from the same ip must not be blocked.
    const otherUser = `other-${Date.now()}`
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: otherUser, password: 'unrelated-secret' },
    })
    expect(r.statusCode).toBe(200)
  })
})

// ── Account routes ────────────────────────────────────────────────
// User-scoped self-service: email change, personal API tokens, and
// webhooks. All emit audits. Cross-user safety: a token created by
// alice can't be deleted by bob.
describe('integration: account routes', () => {
  let cookie = ''
  let createdTokenId = ''
  let createdSecret = ''

  it('logs in alice', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
  })

  it('PATCH /api/account/email sets + audits', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/account/email',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { email: 'alice@example.com' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().user.email).toBe('alice@example.com')

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ limit: 30 })
    const ev = events.find(
      (e) => e.action === 'account.email' && e.actor === 'alice',
    )
    expect((ev?.meta as { email?: string })?.email).toBe('alice@example.com')
  })

  it('PATCH /api/account/email with empty string clears it', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/account/email',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { email: '' },
    })
    expect(r.statusCode).toBe(200)
    // app.publicUser strips undefined; assert it's not present.
    expect(r.json().user.email).toBeFalsy()
  })

  it('PATCH /api/account/email rejects malformed addresses (400)', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/account/email',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { email: 'not-an-email' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('PATCH /api/account/email 401s without auth', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/account/email',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { email: 'x@y.z' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('POST /api/account/tokens mints a token + returns secret', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'cli token' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(typeof body.secret).toBe('string')
    expect(body.secret.length).toBeGreaterThan(20)
    expect(body.token.name).toBe('cli token')
    expect(body.token.createdBy).toBe('alice')
    createdTokenId = body.token.id
    createdSecret = body.secret
  })

  it('GET /api/account/tokens lists only the caller\'s tokens', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const tokens = r.json().tokens as Array<{ id: string; createdBy: string }>
    expect(tokens.some((t) => t.id === createdTokenId)).toBe(true)
    expect(tokens.every((t) => t.createdBy === 'alice')).toBe(true)
  })

  it('POST /api/account/tokens rejects invalid payloads', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: '' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('DELETE /api/account/tokens/:id requires ownership (403 for someone else\'s)', async () => {
    // Sign in as bob, try to delete alice's token.
    const bobSignup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    expect([200, 409]).toContain(bobSignup.statusCode)
    const bobLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    const bobCookie = setCookieValue(bobLogin.headers['set-cookie']) ?? ''

    const r = await app.inject({
      method: 'DELETE',
      url: `/api/account/tokens/${createdTokenId}`,
      headers: { cookie: bobCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(403)
  })

  it('DELETE /api/account/tokens/:id deletes own token + audits', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/account/tokens/${createdTokenId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: createdTokenId })
    expect(events.find((e) => e.action === 'account.token.delete')).toBeTruthy()
    // Defensive: createdSecret was returned plaintext on mint; we
    // don't check its contents but use it to silence the unused-var
    // warning that vitest would otherwise emit.
    expect(createdSecret).toBeTruthy()
  })

  it('DELETE /api/account/tokens/:id 404s for unknown id', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/account/tokens/nope',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('GET /api/account/webhooks lists (initially empty)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(Array.isArray(body.webhooks)).toBe(true)
  })

  it('POST + DELETE /api/account/webhooks works + audits', async () => {
    // Webhook body requires { url, events: [...] } — a `name`
    // field is not part of the schema. Sending it 400s.
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { url: 'https://example.test/hook', events: ['upload', 'edit'] },
    })
    expect(create.statusCode).toBe(200)
    const id = create.json().webhook.id
    expect(id).toBeTruthy()

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${id}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(del.statusCode).toBe(200)

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: id })
    const actions = events.map((e) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining(['account.webhook.create', 'account.webhook.delete']),
    )
  })

  // Regression: /api/account/reembed previously joined storageKey
  // against the global vault root (skipping the per-user folder), so
  // every readFile 404'd and the ENOENT branch DELETED every doc
  // row the user owned. Re-indexing turned into "delete my entire
  // vault index". This guard uploads a file, calls reembed, and
  // asserts the file is still discoverable afterwards.
  it('POST /api/account/reembed re-indexes a real file without deleting it', async () => {
    const form = new FormData()
    form.append(
      'file',
      new Blob(['reembed-guard test content\n'], { type: 'text/markdown' }),
      'reembed-guard.md',
    )
    form.append('targetDir', '')
    const up = await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })
    expect(up.statusCode).toBe(201)

    const reembed = await app.inject({
      method: 'POST',
      url: '/api/account/reembed',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(reembed.statusCode).toBe(200)
    const body = reembed.json()
    // Crucial: re-index did NOT delete every doc. Pre-bug-fix, the
    // wrong path resolution made `ok` always 0 and `removed`
    // equal to the total — i.e. the whole index got nuked. After
    // the fix, real files re-index successfully and only ghost
    // rows (files actually missing on disk from earlier test
    // churn) end up removed.
    expect(body.ok).toBeGreaterThanOrEqual(1)
    expect(body.removed).toBeLessThan(body.total)

    const list = await app.inject({
      method: 'GET',
      url: '/api/list?path=',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(list.statusCode).toBe(200)
    const names = (list.json().items as Array<{ name: string }>).map(
      (i) => i.name,
    )
    expect(names).toContain('reembed-guard.md')
  })
})

// ── Webhook delivery ──────────────────────────────────────────────
// Spin up a real loopback HTTP receiver, register a hook against it,
// trigger an upload, and assert the POST lands with the right body +
// HMAC signature. Catches regressions in the dispatcher itself
// (encryption, retries, dedup) that the CRUD tests above miss.
describe('integration: webhook delivery', () => {
  let cookie = ''
  let receiverPort = 0
  let received: Array<{
    headers: Record<string, string>
    body: string
    statusToReturn: number
  }> = []
  let nextStatus = 200
  let server: import('node:http').Server

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalSettings: any

  beforeAll(async () => {
    // Snapshot settings so a stray webhook doesn't leak into later
    // suites (we clean up in afterAll regardless).
    const { loadSettings } = await import('./stores/settings.js')
    originalSettings = await loadSettings()

    const http = await import('node:http')
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [
              k.toLowerCase(),
              Array.isArray(v) ? v.join(',') : String(v ?? ''),
            ]),
          ),
          body,
          statusToReturn: nextStatus,
        })
        res.writeHead(nextStatus)
        res.end(nextStatus < 400 ? 'ok' : 'fail')
      })
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    )
    const addr = server.address() as import('node:net').AddressInfo
    receiverPort = addr.port

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Restore settings so leftover hooks don't fire during later
    // suites' uploads.
    const { saveSettings } = await import('./stores/settings.js')
    if (originalSettings) await saveSettings(originalSettings)
  })

  beforeEach(async () => {
    received = []
    nextStatus = 200
    // Reset to a known no-hooks state between tests so a previous
    // test's subscription doesn't fire on this test's uploads.
    const { loadSettings, saveSettings } = await import('./stores/settings.js')
    const s = await loadSettings()
    await saveSettings({ ...s, webhooks: [] })
  })

  // Per-test unique file basenames so successive uploads don't
  // collide with each other (the upload route auto-suffixes
  // `(2).md` on collision, which breaks the path assertions).
  let _uniqCounter = 0
  const uniq = (label: string) => `webhook-${label}-${++_uniqCounter}-${Date.now()}.md`

  it('POSTs to the receiver with a valid HMAC-SHA256 signature on upload', async () => {
    const secret = 'super-secret-test-key-1234567890'
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
        secret,
      },
    })
    expect(create.statusCode).toBe(200)
    const hookId = create.json().webhook.id

    // Trigger an upload; the dispatcher should call the receiver.
    const fname = uniq('trigger')
    const form = new FormData()
    form.append('file', new Blob(['hook-trigger\n'], { type: 'text/markdown' }), fname)
    form.append('targetDir', '')
    const up = await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })
    expect(up.statusCode).toBe(201)

    // Wait briefly for fire-and-forget dispatch to land.
    const deadline = Date.now() + 3_000
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(received.length).toBeGreaterThanOrEqual(1)
    const delivery = received[received.length - 1]
    expect(delivery.headers['content-type']).toMatch(/application\/json/)
    expect(delivery.headers['x-reader-event']).toBe('upload')
    expect(delivery.headers['x-reader-signature']).toBeTruthy()

    // Verify the HMAC matches what we'd compute with the plaintext
    // secret we just registered — proves at-rest encryption decrypts
    // correctly during signing.
    const { createHmac } = await import('node:crypto')
    const expected = createHmac('sha256', secret).update(delivery.body).digest('hex')
    expect(delivery.headers['x-reader-signature']).toBe(expected)

    const payload = JSON.parse(delivery.body)
    expect(payload.type).toBe('upload')
    expect(payload.path).toBe(fname)
    expect(payload.actor).toBe('alice')

    // Cleanup.
    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  })

  it('does not leak the encrypted secret to API responses', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
        secret: 'another-test-key-with-enough-chars',
      },
    })
    expect(create.statusCode).toBe(200)
    const hook = create.json().webhook
    expect(hook.secret).toBeUndefined()
    expect(hook.hasSecret).toBe(true)

    const list = await app.inject({
      method: 'GET',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    const got = list.json().webhooks.find((h: { id: string }) => h.id === hook.id)
    expect(got.secret).toBeUndefined()
    expect(got.hasSecret).toBe(true)

    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hook.id}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  })

  it('rejects secrets shorter than 16 chars on the account route', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: 'https://example.test/hook',
        events: ['upload'],
        secret: 'too-short',
      },
    })
    expect(r.statusCode).toBe(400)
  })

  it('retries on 5xx and lands the event in dead-letter when all fail', async () => {
    nextStatus = 503 // receiver returns 503 every call
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
        secret: 'retry-test-secret-with-enough-chars',
      },
    })
    expect(create.statusCode).toBe(200)
    const hookId = create.json().webhook.id

    // Patch the backoff so this test doesn't take 7+ seconds.
    const wh = await import('./services/webhooks.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (wh as any).RETRY_BACKOFF_MS
    // We can't reassign the const export, so we just trigger and
    // wait a bit longer. (Full timeout = 1s + 2s + 4s ≈ 7s.)
    void original

    const form = new FormData()
    form.append('file', new Blob(['retry-test\n'], { type: 'text/markdown' }), uniq('retry'))
    form.append('targetDir', '')
    await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })

    // Wait for all 4 attempts (1 initial + 3 retries) plus
    // dead-letter persistence. The receiver gets called once per
    // attempt.
    const deadline = Date.now() + 10_000
    while (received.length < 4 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(received.length).toBeGreaterThanOrEqual(4)
    for (const r of received) {
      expect(r.headers['x-reader-event']).toBe('upload')
    }

    // The dead-letter slot should now hold the failed event.
    const { loadSettings } = await import('./stores/settings.js')
    const fresh = await loadSettings()
    const stored = (fresh.webhooks ?? []).find((h) => h.id === hookId)
    expect(stored?.deadLetter?.length).toBeGreaterThanOrEqual(1)

    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  }, 15_000)

  it('PATCH /api/account/webhooks/:id edits url/events/enabled/secret', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
        secret: 'initial-secret-with-enough-chars',
      },
    })
    expect(create.statusCode).toBe(200)
    const hookId = create.json().webhook.id

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        events: ['upload', 'edit'],
        enabled: false,
        secret: 'rotated-secret-with-enough-chars',
      },
    })
    expect(patch.statusCode).toBe(200)
    const updated = patch.json().webhook
    expect(updated.events).toEqual(['upload', 'edit'])
    expect(updated.enabled).toBe(false)
    expect(updated.hasSecret).toBe(true)
    expect(updated.secret).toBeUndefined()

    // enabled:false should suppress dispatch entirely — upload a file
    // and verify the receiver gets nothing.
    received = []
    const form = new FormData()
    form.append('file', new Blob(['disabled-test\n'], { type: 'text/markdown' }), uniq('disabled'))
    form.append('targetDir', '')
    await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(received).toHaveLength(0)

    // Cleanup.
    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  })

  it('PATCH rejects another user editing your hook', async () => {
    // Create one as alice.
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
      },
    })
    const hookId = create.json().webhook.id
    // Log in as bob.
    const bobLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    const bobCookie = setCookieValue(bobLogin.headers['set-cookie']) ?? ''
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie: bobCookie, 'X-Requested-With': 'fetch' },
      payload: { enabled: false },
    })
    expect(r.statusCode).toBe(403)
    // Cleanup.
    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  })

  it('POST /api/account/webhooks/:id/test pings the receiver', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
        secret: 'ping-secret-with-enough-chars-here',
      },
    })
    const hookId = create.json().webhook.id

    received = []
    const r = await app.inject({
      method: 'POST',
      url: `/api/account/webhooks/${hookId}/test`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().ok).toBe(true)
    expect(r.json().status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].headers['x-reader-event']).toBe('test')
    const body = JSON.parse(received[0].body)
    expect(body.type).toBe('test')

    // Cleanup.
    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  })

  it('POST /api/account/webhooks/:id/retry/:entryId replays a DLQ entry', async () => {
    // Force a failure first by pointing at a closed port, then
    // re-target the hook to the working receiver before retry.
    nextStatus = 503
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['upload'],
        secret: 'replay-secret-with-enough-chars',
      },
    })
    const hookId = create.json().webhook.id

    received = []
    const form = new FormData()
    form.append('file', new Blob(['replay-test\n'], { type: 'text/markdown' }), uniq('replay'))
    form.append('targetDir', '')
    await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })
    // Wait for all 4 attempts + DLQ write.
    const deadline = Date.now() + 10_000
    const { loadSettings } = await import('./stores/settings.js')
    let entryId: string | undefined
    while (Date.now() < deadline) {
      const fresh = await loadSettings()
      const stored = (fresh.webhooks ?? []).find((h) => h.id === hookId)
      const dlq = stored?.deadLetter ?? []
      if (dlq.length > 0) {
        entryId = dlq[0].id
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(entryId).toBeTruthy()

    // Flip the receiver back to 200 and retry.
    nextStatus = 200
    received = []
    const r = await app.inject({
      method: 'POST',
      url: `/api/account/webhooks/${hookId}/retry/${entryId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().ok).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0].headers['x-reader-attempt']).toBe('retry')

    // DLQ entry should be gone after a successful replay.
    const settled = await loadSettings()
    const stored = (settled.webhooks ?? []).find((h) => h.id === hookId)
    expect(stored?.deadLetter ?? []).toHaveLength(0)

    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  }, 15_000)

  it('fires the share webhook on grant AND revoke', async () => {
    // Subscribe to share events.
    const create = await app.inject({
      method: 'POST',
      url: '/api/account/webhooks',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        url: `http://127.0.0.1:${receiverPort}/`,
        events: ['share'],
        secret: 'share-secret-with-enough-chars-ok',
      },
    })
    const hookId = create.json().webhook.id

    received = []
    // Alice uploads a file to share.
    const shareFname = uniq('share-target')
    const form = new FormData()
    form.append('file', new Blob(['share-target\n'], { type: 'text/markdown' }), shareFname)
    form.append('targetDir', '')
    const up = await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })
    expect(up.statusCode).toBe(201)
    // upload event doesn't match the share subscription — wait
    // briefly to confirm nothing fired yet.
    await new Promise((r) => setTimeout(r, 150))
    expect(received).toHaveLength(0)

    // Share with bob.
    const sh = await app.inject({
      method: 'POST',
      url: '/api/file/share-with',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { path: shareFname, recipient: 'bob' },
    })
    expect(sh.statusCode).toBe(201)
    const shareId = sh.json().share.id

    // Wait for grant dispatch.
    let deadline = Date.now() + 2_000
    while (received.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(received).toHaveLength(1)
    const grantBody = JSON.parse(received[0].body)
    expect(grantBody.type).toBe('share')
    expect(grantBody.revoked).toBe(false)
    expect(grantBody.recipient).toBe('bob')

    // Revoke.
    received = []
    const rv = await app.inject({
      method: 'DELETE',
      url: `/api/file/share-with/${shareId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(rv.statusCode).toBe(200)

    deadline = Date.now() + 2_000
    while (received.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(received).toHaveLength(1)
    const revokeBody = JSON.parse(received[0].body)
    expect(revokeBody.type).toBe('share')
    expect(revokeBody.revoked).toBe(true)
    expect(revokeBody.shareId).toBe(shareId)

    await app.inject({
      method: 'DELETE',
      url: `/api/account/webhooks/${hookId}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
  })

  it('markExpectedWrite + consumeExpectedWrite dedup unit', async () => {
    const { markExpectedWrite, consumeExpectedWrite } = await import(
      './services/webhooks.js'
    )
    // No match → returns false.
    expect(consumeExpectedWrite('/abs/path', 'sha-x')).toBe(false)
    // Mark + match → returns true once.
    markExpectedWrite('/abs/path', 'sha-x')
    expect(consumeExpectedWrite('/abs/path', 'sha-x')).toBe(true)
    // Already consumed → false.
    expect(consumeExpectedWrite('/abs/path', 'sha-x')).toBe(false)
    // Wrong sha → false, doesn't consume.
    markExpectedWrite('/abs/path2', 'sha-correct')
    expect(consumeExpectedWrite('/abs/path2', 'sha-wrong')).toBe(false)
    expect(consumeExpectedWrite('/abs/path2', 'sha-correct')).toBe(true)
  })
})

// ── User-to-user shares ───────────────────────────────────────────
// Per-file / per-folder share grants. Tests hit the security-
// critical paths: path-traversal rejection, self-share rejection,
// missing-recipient handling, and the ownership check on revoke.
describe('integration: user shares', () => {
  let aliceCookie = ''
  let bobCookie = ''

  it('logs in alice + bob and seeds a shareable file', async () => {
    const alice = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(alice.statusCode).toBe(200)
    aliceCookie = setCookieValue(alice.headers['set-cookie']) ?? ''

    // bob may already exist from the account-tokens test above.
    await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    const bobLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    expect(bobLogin.statusCode).toBe(200)
    bobCookie = setCookieValue(bobLogin.headers['set-cookie']) ?? ''

    const { mkdir, writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'share-target.md')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, '# shared with bob')
  })

  it('alice can share a file with bob', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/share-with',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'share-target.md', recipient: 'bob', canEdit: false },
    })
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body.share.owner).toBe('alice')
    expect(body.share.recipient).toBe('bob')
    expect(body.share.canEdit).toBe(false)
  })

  it('audits vault.share-with with recipient + canEdit meta', async () => {
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'share-target.md' })
    const ev = events.find((e) => e.action === 'vault.share-with')
    expect(ev?.actor).toBe('alice')
    expect((ev?.meta as { recipient?: string })?.recipient).toBe('bob')
    expect((ev?.meta as { canEdit?: boolean })?.canEdit).toBe(false)
  })

  it('refuses to share with yourself (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/share-with',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'share-target.md', recipient: 'alice' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('refuses to share with an unknown recipient (404)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/share-with',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'share-target.md', recipient: 'ghost-user' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('refuses path traversal in the share path', async () => {
    // resolveUserVault rejects `..` segments — the route should
    // surface that as a 400, not silently mint a share record
    // pointing into another user's vault.
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/share-with',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: { path: '../bob/secret.md', recipient: 'bob' },
    })
    expect([400, 404]).toContain(r.statusCode)
  })

  it('refuses to share a path that does not exist in the owner\'s vault (404)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/share-with',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: { path: 'never-existed.md', recipient: 'bob' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('GET /api/file/shares-from lists alice\'s outgoing grants', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/shares-from',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const shares = r.json().shares as Array<{ recipient: string }>
    expect(shares.some((s) => s.recipient === 'bob')).toBe(true)
  })

  it('GET /api/file/shares-to lists bob\'s incoming grants', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/file/shares-to',
      headers: { cookie: bobCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const shares = r.json().shares as Array<{ owner: string }>
    expect(shares.some((s) => s.owner === 'alice')).toBe(true)
  })

  it('DELETE /api/file/share-with/:id refuses third-party revocation (403)', async () => {
    // Create a doc owned by alice and shared with bob. A signed-in
    // THIRD user (we use the locktest user from the lockout suite)
    // must not be able to revoke that grant.
    // First find an existing share id.
    const fromR = await app.inject({
      method: 'GET',
      url: '/api/file/shares-from',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
    })
    const share = fromR.json().shares[0] as { id: string }
    expect(share?.id).toBeTruthy()
    // Sign up + login a fresh third-party user.
    const third = `third-${Date.now()}`
    await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: third, password: 'third-party-secret' },
    })
    const tl = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: third, password: 'third-party-secret' },
    })
    const thirdCookie = setCookieValue(tl.headers['set-cookie']) ?? ''
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/file/share-with/${share.id}`,
      headers: { cookie: thirdCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(403)
  })

  it('owner can revoke a share + audits vault.share-revoke', async () => {
    const fromR = await app.inject({
      method: 'GET',
      url: '/api/file/shares-from',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
    })
    const share = fromR.json().shares.find(
      (s: { storageKey: string }) => s.storageKey === 'share-target.md',
    ) as { id: string }
    expect(share?.id).toBeTruthy()

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/file/share-with/${share.id}`,
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
    })
    expect(del.statusCode).toBe(200)

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'share-target.md' })
    const rev = events.find(
      (e) => e.action === 'vault.share-revoke' && e.actor === 'alice',
    )
    expect((rev?.meta as { recipient?: string })?.recipient).toBe('bob')
  })

  it('DELETE on unknown share id 404s', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/file/share-with/nope',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('all share endpoints 401 without auth', async () => {
    const targets = [
      { method: 'POST', url: '/api/file/share-with', payload: { path: 'x', recipient: 'y' } },
      { method: 'GET', url: '/api/file/shares-from' },
      { method: 'GET', url: '/api/file/shares-to' },
      { method: 'DELETE', url: '/api/file/share-with/anything' },
    ] as const
    for (const t of targets) {
      const r = await app.inject({
        method: t.method,
        url: t.url,
        headers: { 'X-Requested-With': 'fetch' },
        payload: 'payload' in t ? t.payload : undefined,
      })
      expect(r.statusCode, `${t.method} ${t.url}`).toBe(401)
    }
  })
})

// ── Search filters + similar ──────────────────────────────────────
// Covers the v0.9 search-depth work: faceted filtering on the
// /search/knowledge endpoint (mime, tags, folder, after/before)
// plus the /search/similar/:docId endpoint which short-circuits
// to an empty list for docs without embeddings.
describe('integration: search depth', () => {
  let cookie = ''

  it('logs in alice', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(r.statusCode).toBe(200)
    cookie = setCookieValue(r.headers['set-cookie']) ?? ''
  })

  it('GET /api/search/knowledge accepts and round-trips filters', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/knowledge?q=anything&mime=text/markdown&tags=urgent,draft&folder=projects&after=1000&before=999999999999',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.query).toBe('anything')
    expect(Array.isArray(body.hits)).toBe(true)
    // Filter echo so the client can verify what got applied.
    expect(body.filters.mime).toEqual(['text/markdown'])
    expect(body.filters.tags).toEqual(['urgent', 'draft'])
    expect(body.filters.folder).toBe('projects')
    expect(body.filters.after).toBe(1000)
    expect(body.filters.before).toBe(999999999999)
  })

  it('GET /api/search/knowledge with empty q returns no hits', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/knowledge?q=',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().hits).toEqual([])
  })

  it('GET /api/search/knowledge 401s without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/knowledge?q=x',
      headers: { 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('GET /api/search/similar/:docId 404s for unknown docs', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/similar/no-such-doc',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(404)
    expect(r.json().error).toMatch(/not found/i)
  })

  it('GET /api/search/similar/:docId returns [] for a doc with no embeddings', async () => {
    // Seed a doc directly without embeddings — findSimilarDocs
    // returns an empty array (not an error) when the source has
    // nothing to centroid against.
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('similar-test-1', 'alice', 'similar-test-1.md', 'no-embed', 'similar-test-1.md', 'text/markdown', 0, '', Date.now(), Date.now())
    const { invalidateSearchCache } = await import('./services/search.js')
    invalidateSearchCache()
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/similar/similar-test-1',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().hits).toEqual([])
  })

  it('GET /api/search/similar/:docId enforces ACL (403 from a non-admin on someone else\'s doc)', async () => {
    // Seed an alice-owned doc; sign in as bob (editor, not admin)
    // and confirm bob gets 403. Alice is admin in this suite so we
    // can't use her cookie to assert the deny path — admins bypass
    // the ACL by design.
    db()
      .prepare(
        `INSERT INTO documents
           (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('alice-secret-similar', 'alice', 'alice-secret.md', 'alice', 'alice-secret.md', 'text/markdown', 0, '', Date.now(), Date.now())
    const { invalidateSearchCache } = await import('./services/search.js')
    invalidateSearchCache()
    const bobLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    expect(bobLogin.statusCode).toBe(200)
    const bobCookie = setCookieValue(bobLogin.headers['set-cookie']) ?? ''
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/similar/alice-secret-similar',
      headers: { cookie: bobCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(403)
  })

  it('GET /api/search/similar/:docId 401s without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/search/similar/anything',
      headers: { 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(401)
  })
})

// ── Document templates ────────────────────────────────────────────
// `_templates/*.md` under the user's vault drives the template list;
// instantiation copies the file with placeholder substitution and
// runs it through the regular ingest pipeline.
describe('integration: document templates', () => {
  let cookie = ''

  it('logs in alice + seeds a template under _templates/', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''

    const { mkdir, writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.join(config.vault.root, 'alice', '_templates')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'meeting-notes.md'),
      '# {{title}}\n\nDate: {{date}}\nAuthor: {{user}}\nProject: {{project}}\n',
    )
  })

  it('GET /api/templates lists the seeded template with preview', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    const t = body.templates.find(
      (x: { name: string }) => x.name === 'meeting-notes.md',
    )
    expect(t).toBeTruthy()
    expect(t.path).toBe('_templates/meeting-notes.md')
    expect(t.preview).toContain('{{title}}')
  })

  it('GET /api/templates returns [] when _templates/ does not exist', async () => {
    // Use bob — never seeded a templates dir for him.
    const bobLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob', password: 'correct-horse-battery' },
    })
    const bobCookie = setCookieValue(bobLogin.headers['set-cookie']) ?? ''
    const r = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: { cookie: bobCookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().templates).toEqual([])
  })

  it('POST /api/templates/instantiate copies + substitutes + ingests', async () => {
    // Defensive cleanup — the instantiate endpoint refuses to
    // clobber an existing file, so any leftover at this path from
    // a prior run would 409. Same defensive pattern the move test
    // uses for `move-dst.md`.
    {
      const { rm } = await import('node:fs/promises')
      const path = await import('node:path')
      await rm(
        path.join(config.vault.root, 'alice', 'projects/2026-meeting.md'),
        { force: true },
      )
    }
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/meeting-notes.md',
        target: 'projects/2026-meeting.md',
        title: 'Q3 Planning',
        vars: { project: 'reader' },
      },
    })
    expect(r.statusCode).toBe(200)
    const doc = r.json().document
    expect(doc.title).toBe('Q3 Planning')
    expect(doc.storageKey).toBe('projects/2026-meeting.md')

    // Disk content should have all placeholders resolved.
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', 'projects/2026-meeting.md')
    const text = (await readFile(abs)).toString('utf8')
    expect(text).toContain('Q3 Planning')
    expect(text).toContain('Author: alice')
    expect(text).toContain('Project: reader')
    expect(text).toMatch(/Date: \d{4}-\d{2}-\d{2}/)
    expect(text).not.toContain('{{')

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: 'projects/2026-meeting.md' })
    expect(events.find((e) => e.action === 'template.instantiate')).toBeTruthy()
  })

  it('POST /api/templates/instantiate refuses to clobber an existing file (409)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/meeting-notes.md',
        target: 'projects/2026-meeting.md',
      },
    })
    expect(r.statusCode).toBe(409)
  })

  it('POST /api/templates/instantiate refuses templates outside _templates/ (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: 'projects/2026-meeting.md',
        target: 'projects/other.md',
      },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/_templates/)
  })

  it('POST /api/templates/instantiate 404s on unknown template', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/nope.md',
        target: 'projects/x.md',
      },
    })
    expect(r.statusCode).toBe(404)
  })

  it('POST /api/templates/instantiate requires both template and target (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { template: '_templates/meeting-notes.md' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('GET /api/templates 401s without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: { 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('GET /api/templates exposes the built-in placeholder list', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    // Spot-check a few of the new ones — full list is in
    // BUILTIN_KEYS in routes/templates.ts.
    for (const k of ['date', 'time', 'year', 'weekday', 'week', 'quarter',
                     'slug', 'filename', 'folder', 'uuid', 'timestamp']) {
      expect(body.builtins).toContain(k)
    }
  })

  it('POST /api/templates/instantiate resolves the expanded built-in set', async () => {
    // Seed a template that touches every new built-in so we can
    // verify each one substitutes cleanly.
    const { mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    const dir = pathMod.join(config.vault.root, 'alice', '_templates')
    await mkdir(dir, { recursive: true })
    await writeFile(
      pathMod.join(dir, 'kitchen-sink.md'),
      [
        'date={{date}}',
        'time={{time}}',
        'year={{year}} month={{month}} month_name={{month_name}} day={{day}}',
        'weekday={{weekday}} week={{week}} quarter={{quarter}}',
        'ts={{timestamp}}',
        'title={{title}} slug={{slug}}',
        'user={{user}} filename={{filename}} folder={{folder}}',
        'id={{uuid}}',
        '',
      ].join('\n'),
    )

    const target = 'projects/sub/kitchen-sink-doc.md'
    await rm(pathMod.join(config.vault.root, 'alice', target), { force: true })

    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/kitchen-sink.md',
        target,
        title: 'My Doc Title',
      },
    })
    expect(r.statusCode).toBe(200)

    const text = (
      await readFile(pathMod.join(config.vault.root, 'alice', target))
    ).toString('utf8')
    expect(text).not.toContain('{{')
    expect(text).toMatch(/date=\d{4}-\d{2}-\d{2}/)
    expect(text).toMatch(/time=\d{2}:\d{2}/)
    expect(text).toMatch(/year=\d{4} month=\d{2} month_name=\w+ day=\d{2}/)
    expect(text).toMatch(/weekday=\w+ week=\d{2} quarter=Q[1-4]/)
    expect(text).toMatch(/ts=\d{10}/)
    expect(text).toContain('title=My Doc Title slug=my-doc-title')
    expect(text).toContain('user=alice filename=kitchen-sink-doc folder=projects/sub')
    expect(text).toMatch(/id=[A-Za-z0-9_-]{10}/)
  })

  it('POST /api/templates/instantiate resolves placeholders in target path', async () => {
    // Target like `journal/{{date}}-{{slug}}.md` should land at
    // the substituted path — convenient for date-stamped docs
    // without having to type the date yourself.
    const { rm, stat } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const finalRel = `journal/${stamp}-target-substitution-test.md`
    await rm(pathMod.join(config.vault.root, 'alice', finalRel), { force: true })
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/meeting-notes.md',
        target: 'journal/{{date}}-{{slug}}.md',
        title: 'Target Substitution Test',
        vars: { project: 'x' },
      },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().document.storageKey).toBe(finalRel)
    await expect(stat(pathMod.join(config.vault.root, 'alice', finalRel))).resolves.toBeTruthy()
  })

  it('POST /api/templates/instantiate resolves placeholders in title', async () => {
    // Title like `Notes for {{date}}` should produce a doc with
    // the resolved title — handy for date-stamped daily notes.
    const { rm } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const target = 'projects/title-subst-test.md'
    await rm(pathMod.join(config.vault.root, 'alice', target), { force: true })
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/meeting-notes.md',
        target,
        title: 'Notes for {{date}}',
        vars: { project: 'x' },
      },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().document.title).toBe(`Notes for ${stamp}`)
  })

  it('POST /api/templates/instantiate refuses target that escapes via substitution', async () => {
    // Substituted values must not let `..` escape the vault.
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/meeting-notes.md',
        target: '{{escape}}/file.md',
        title: 'Escape Test',
        vars: { escape: '../../etc/passwd', project: 'x' },
      },
    })
    expect(r.statusCode).toBe(400)
  })

  it('POST /api/templates/instantiate lets user vars override built-ins', async () => {
    // {{user}} is a built-in, but if the caller passes vars.user
    // explicitly the override should win. Lets a template author
    // re-purpose `{{user}}` for a literal value if they want.
    const { rm } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    const target = 'projects/override-test.md'
    await rm(pathMod.join(config.vault.root, 'alice', target), { force: true })
    const r = await app.inject({
      method: 'POST',
      url: '/api/templates/instantiate',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        template: '_templates/meeting-notes.md',
        target,
        title: 'Override Test',
        vars: { user: 'EXTERNAL', project: 'x' },
      },
    })
    expect(r.statusCode).toBe(200)
    const { readFile } = await import('node:fs/promises')
    const text = (
      await readFile(pathMod.join(config.vault.root, 'alice', target))
    ).toString('utf8')
    expect(text).toContain('Author: EXTERNAL')
  })
})

// ── Calendar heatmap ──────────────────────────────────────────────
// /api/account/calendar aggregates docs per day for a GitHub-style
// contribution grid. Days with zero docs are omitted so a year's
// worth of empty cells doesn't bloat the payload.
describe('integration: calendar heatmap', () => {
  let cookie = ''

  it('logs in alice + seeds 3 docs across 2 days', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''

    // Bracketed timestamps so we hit two distinct calendar days.
    const dayA = new Date(2026, 4, 10, 12, 0, 0).getTime()
    const dayB = new Date(2026, 4, 11, 8, 0, 0).getTime()
    const ins = db().prepare(
      `INSERT INTO documents
         (id, owner, storage_key, title, original_filename, mime, bytes, sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?)`,
    )
    ins.run('cal-a-1', 'alice', 'cal-a-1.md', 'a1', 'cal-a-1.md', 'text/markdown', dayA, dayA)
    ins.run('cal-a-2', 'alice', 'cal-a-2.md', 'a2', 'cal-a-2.md', 'text/markdown', dayA + 1000, dayA + 1000)
    ins.run('cal-b-1', 'alice', 'cal-b-1.md', 'b1', 'cal-b-1.md', 'text/markdown', dayB, dayB)
  })

  it('returns one entry per day with counts (zero-days omitted)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/account/calendar?from=2026-05-01&to=2026-05-31',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.from).toBe('2026-05-01')
    const dayA = body.days.find((d: { day: string }) => d.day === '2026-05-10')
    const dayB = body.days.find((d: { day: string }) => d.day === '2026-05-11')
    expect(dayA?.count).toBe(2)
    expect(dayB?.count).toBe(1)
    expect(body.total).toBeGreaterThanOrEqual(3)
    // Zero-days OMITTED: 2026-05-15 has nothing → no entry.
    expect(body.days.find((d: { day: string }) => d.day === '2026-05-15')).toBeUndefined()
  })

  it('rejects from > to (400)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/account/calendar?from=2026-05-31&to=2026-05-01',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/from must be/i)
  })

  it('rejects > 5-year windows (400)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/account/calendar?from=2000-01-01&to=2026-05-31',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/5 years/i)
  })

  it('401s without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/account/calendar',
      headers: { 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(401)
  })
})

// ── Email-in HTTP intake ──────────────────────────────────────────
// POST /api/intake/email lets users wire any incoming-mail webhook
// (Cloudflare Email Worker / SendGrid Inbound / Mailgun routes) at
// Reader. Authenticated via the same Bearer-token mechanism MCP
// uses. Each call creates a markdown doc under Inbox/ with frontmatter.
describe('integration: email intake', () => {
  let cookie = ''
  let bearer = ''

  it('logs in alice + mints an intake token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    const mint = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'email-intake' },
    })
    expect(mint.statusCode).toBe(200)
    bearer = (mint.json() as { secret: string }).secret
  })

  it('rejects calls without a Bearer token (401)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { 'content-type': 'application/json' },
      payload: { subject: 'x', body: 'y' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('writes a markdown doc under Inbox/ + audits intake.email', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        subject: 'Hello world',
        from: 'alice@example.com',
        body: 'This is the email body.\n\nWith a second paragraph.',
        received: new Date(2026, 4, 23, 9, 30, 0).getTime(),
      },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.document.title).toBe('Hello world')
    // The basename uniquifies on collision (`-1`, `-2`, …) so the
    // suite stays robust to leftover state from other test passes.
    // The day prefix + slug stay invariant.
    expect(body.document.storageKey).toMatch(/^Inbox\/2026-05-23-hello-world(-\d+)?\.md$/)

    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', body.document.storageKey)
    const text = (await readFile(abs)).toString('utf8')
    expect(text).toContain('subject: "Hello world"')
    expect(text).toContain('from: "alice@example.com"')
    expect(text).toContain('source: email-intake')
    expect(text).toContain('This is the email body')

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: body.document.storageKey })
    const ev = events.find((e) => e.action === 'intake.email')
    expect(ev?.actor).toBe('alice')
    expect((ev?.meta as { subject?: string })?.subject).toBe('Hello world')
  })

  it('handles base64 attachments + links them from the doc', async () => {
    const att = Buffer.from('attachment content here').toString('base64')
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        subject: 'With attachment',
        body: 'See attached.',
        attachments: [
          { name: 'note.txt', mime: 'text/plain', content: att },
        ],
      },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0].path).toMatch(/^Inbox\/attachments\/note(-\d+)?\.txt$/)

    const { readFile, stat } = await import('node:fs/promises')
    const path = await import('node:path')
    const attAbs = path.join(config.vault.root, 'alice', body.attachments[0].path)
    expect((await stat(attAbs)).size).toBeGreaterThan(0)
    const docAbs = path.join(config.vault.root, 'alice', body.document.storageKey)
    const docText = (await readFile(docAbs)).toString('utf8')
    expect(docText).toContain('## Attachments')
    expect(docText).toContain('note.txt')
  })

  it('falls back to html when body is empty', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { subject: 'HTML only', html: '<p>From HTML</p>' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const abs = path.join(config.vault.root, 'alice', body.document.storageKey)
    const text = (await readFile(abs)).toString('utf8')
    expect(text).toContain('From HTML')
  })

  it('refuses when neither body nor html is provided (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { subject: 'empty' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/body or html/i)
  })

  it('refuses attachments larger than 20 MB (413)', async () => {
    // Synthesize a 21 MB base64 blob — well over the cap.
    const big = Buffer.alloc(21 * 1024 * 1024).toString('base64')
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: {
        subject: 'too big',
        body: 'x',
        attachments: [{ name: 'big.bin', content: big }],
      },
    })
    expect(r.statusCode).toBe(413)
  })

  it('refuses body bodies larger than 1 MB (413)', async () => {
    const huge = 'x'.repeat(1_100_000)
    const r = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { subject: 'wall of text', body: huge },
    })
    expect(r.statusCode).toBe(413)
  })

  it('uniquifies the filename on subject collision', async () => {
    // Same subject + same day → second call must NOT clobber the
    // first; uniquePath appends `-1`.
    const ts = new Date(2026, 4, 24, 10, 0, 0).getTime()
    const a = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { subject: 'Dup subject', body: 'first', received: ts },
    })
    const b = await app.inject({
      method: 'POST',
      url: '/api/intake/email',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { subject: 'Dup subject', body: 'second', received: ts },
    })
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    const aPath = a.json().document.storageKey
    const bPath = b.json().document.storageKey
    expect(aPath).not.toBe(bPath)
    expect(bPath).toMatch(/-\d+\.md$/)
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

// ── Reconcile vault ───────────────────────────────────────────────
// Recovery action for files-on-disk-but-row-missing situations. We
// simulate the failure mode (delete the row directly, file stays on
// disk) and assert reconcile re-creates the row.
describe('integration: reconcile vault', () => {
  it('re-ingests files dropped onto disk that have no DB row', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    const cookie = setCookieValue(login.headers['set-cookie']) ?? ''

    // Simulate "file dropped externally" by writing straight to
    // alice's vault folder. The watcher runs with ignoreInitial: true
    // so the test doesn't pick this up automatically.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    const fname = `dropped-${Date.now()}.md`
    const aliceRoot = pathMod.join(config.vault.root, 'alice')
    await mkdir(aliceRoot, { recursive: true })
    await writeFile(pathMod.join(aliceRoot, fname), 'dropped from disk\n')

    // Reconcile. We don't precondition on "the file isn't there
    // yet" — chokidar might race the watcher's `add` handler ahead
    // of us, in which case the file is already indexed and
    // reconcile is a no-op. Either way the endpoint must succeed
    // and the file must end up in the listing.
    //
    // Scope to alice's vault only — without the owner filter the
    // walk covers every user's tree built up across the test run,
    // which can take minutes for a long suite.
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/reconcile-vault?owner=alice',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(r.statusCode).toBe(200)
    const result = r.json()
    expect(result.scanned).toBeGreaterThanOrEqual(1)

    const list = await app.inject({
      method: 'GET',
      url: '/api/list?path=',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    const names = (list.json().items as Array<{ name: string }>).map((i) => i.name)
    expect(names).toContain(fname)
    // Walks the cumulative test vault — grows with every new
    // describe block. 180s headroom now that the v0.9 surface
    // (OAuth, 35 MCP tools, version-restore) added enough fixtures
    // to push the cold sweep past 2 min on slower CI workers.
  }, 180_000)
})

// ── OAuth + MCP ─────────────────────────────────────────────────────
// End-to-end walk-through of the consent flow: discovery → DCR →
// authorize+consent → token exchange → MCP call with the access
// token → scope-mismatch rejection → refresh rotation + replay → revoke.
describe('integration: oauth + mcp', () => {
  let cookie = ''

  beforeAll(async () => {
    // Reset OAuth-side rate limits — this suite registers many
    // clients, well past the 10/hour DCR cap.
    const { _resetOauthRateLimitsForTest } = await import('./routes/oauth.js')
    _resetOauthRateLimitsForTest()
  })

  beforeEach(async () => {
    // Defensive: also drain between tests so a test ordering shift
    // can't re-trip the cap.
    const { _resetOauthRateLimitsForTest } = await import('./routes/oauth.js')
    _resetOauthRateLimitsForTest()
  })

  beforeAll(async () => {
    // Run-order safety: when this suite executes in isolation, alice
    // doesn't exist yet. Try login first; signup on failure.
    let login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    if (login.statusCode !== 200) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
      login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
    }
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(cookie).not.toBe('')
  })

  function pkcePair() {
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  /** Walks through GET /oauth/authorize and pulls the HMAC `req`
   *  token + canonical scope string out of the redirect URL.
   *  /decide can't be called without these now. */
  async function authorizeAndExtractReq(opts: {
    clientId: string
    redirectUri: string
    state: string
    challenge: string
    scope: string
  }): Promise<{ req: string; scope: string }> {
    const r = await app.inject({
      method: 'GET',
      url:
        '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: opts.clientId,
          redirect_uri: opts.redirectUri,
          state: opts.state,
          code_challenge: opts.challenge,
          code_challenge_method: 'S256',
          scope: opts.scope,
        }).toString(),
      headers: { cookie },
    })
    expect(r.statusCode).toBe(302)
    const loc = new URL(r.headers.location as string)
    return {
      req: loc.searchParams.get('req')!,
      scope: loc.searchParams.get('scope')!,
    }
  }

  it('serves both well-known docs with the expected scopes', async () => {
    const pr = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })
    expect(pr.statusCode).toBe(200)
    const prJson = pr.json()
    expect(prJson.authorization_servers).toHaveLength(1)
    expect(prJson.scopes_supported).toContain('mcp')
    expect(prJson.scopes_supported).toContain('tool:search_knowledge')

    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    expect(as.statusCode).toBe(200)
    const asJson = as.json()
    expect(asJson.code_challenge_methods_supported).toEqual(['S256'])
    expect(asJson.grant_types_supported).toContain('authorization_code')
    expect(asJson.grant_types_supported).toContain('refresh_token')
  })

  it('DCR → authorize → token → /mcp tools/call → revoke', async () => {
    // DCR — open by policy.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Test MCP Client',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    expect(reg.statusCode).toBe(201)
    const client = reg.json()
    expect(client.client_id).toMatch(/^oclient_/)
    expect(client.token_endpoint_auth_method).toBe('none')

    // Authorize → server redirects to /oauth/consent with normalized params.
    const { verifier, challenge } = pkcePair()
    const { req: reqToken, scope: canonicalScope } = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'xyz123',
      challenge,
      scope: 'tool:whoami tool:search_knowledge',
    })

    // Decide (approve) — issues a code via the requested redirect_uri.
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'xyz123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: canonicalScope,
        req: reqToken,
        scopes: ['tool:whoami', 'tool:search_knowledge'],
        approve: true,
      },
    })
    expect(decide.statusCode).toBe(200)
    const redirect = new URL(decide.json().redirect)
    const code = redirect.searchParams.get('code')!
    expect(code).toMatch(/^oac_/)
    expect(redirect.searchParams.get('state')).toBe('xyz123')

    // Exchange the code for tokens (PKCE-bound).
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })
    expect(tok.statusCode).toBe(200)
    const tokens = tok.json()
    expect(tokens.access_token).toMatch(/^oat_/)
    expect(tokens.refresh_token).toMatch(/^ort_/)
    expect(tokens.token_type).toBe('Bearer')

    // MCP call WITHIN scope → succeeds.
    const callOk = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      },
    })
    expect(callOk.statusCode).toBe(200)
    const okJson = callOk.json()
    expect(okJson.result.structuredContent.user).toBe('alice')
    expect(okJson.result.structuredContent.scopes).toContain('tool:whoami')

    // MCP call OUTSIDE scope → -32003 insufficient_scope.
    const callDenied = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_documents', arguments: { limit: 1 } },
      },
    })
    expect(callDenied.statusCode).toBe(200)
    const deniedJson = callDenied.json()
    expect(deniedJson.error).toBeDefined()
    expect(deniedJson.error.code).toBe(-32003)
    expect(deniedJson.error.message).toContain('tool:list_documents')

    // Revoke the grant. The same access token should now 401.
    const grants = await app.inject({
      method: 'GET',
      url: '/api/account/oauth-grants',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(grants.statusCode).toBe(200)
    expect(grants.json().grants.some((g: { clientId: string }) => g.clientId === client.client_id)).toBe(true)

    const rev = await app.inject({
      method: 'DELETE',
      url: `/api/account/oauth-grants/${encodeURIComponent(client.client_id)}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(rev.statusCode).toBe(200)

    const after = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(after.statusCode).toBe(401)
    expect(after.headers['www-authenticate']).toContain('resource_metadata=')
  })

  it('refresh token rotates and replay kills the grant', async () => {
    // Bootstrap a fresh grant for this test.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Refresh Test Client',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { verifier, challenge } = pkcePair()
    const a = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 's',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 's',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: a.scope,
        req: a.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const tok1 = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })
    const t1 = tok1.json()

    // First refresh → new pair, old refresh now retired.
    const tok2 = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'refresh_token',
        refresh_token: t1.refresh_token,
        client_id: client.client_id,
      },
    })
    expect(tok2.statusCode).toBe(200)
    const t2 = tok2.json()
    expect(t2.refresh_token).not.toBe(t1.refresh_token)
    expect(t2.access_token).not.toBe(t1.access_token)

    // Replay the OLD refresh → invalid_grant + grant nuked.
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'refresh_token',
        refresh_token: t1.refresh_token,
        client_id: client.client_id,
      },
    })
    expect(replay.statusCode).toBe(400)
    expect(replay.json().error).toBe('invalid_grant')

    // The brand-new access token from the legitimate refresh is now
    // dead too — the replay defense revokes the whole grant.
    const probe = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${t2.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(probe.statusCode).toBe(401)
  })

  it('PKCE mismatch on token exchange rejects with invalid_grant', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'PKCE Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const a = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'p',
      challenge: a.challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'p',
        code_challenge: a.challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const wrong = pkcePair()
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: wrong.verifier,
      },
    })
    expect(tok.statusCode).toBe(400)
    expect(tok.json().error).toBe('invalid_grant')
  })

  it('/decide without the HMAC req token is rejected', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { client_name: 'No-Req', redirect_uris: ['http://127.0.0.1:9999/cb'] },
    })
    const client = reg.json()
    const { challenge } = pkcePair()
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'n',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tool:whoami',
        req: 'forged-hmac-that-cannot-possibly-match',
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    expect(decide.statusCode).toBe(400)
    expect(decide.json().error).toBe('invalid_request')
  })

  it('/decide rejects scope upgrade beyond what /authorize requested', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Scope Upgrade Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { challenge } = pkcePair()
    // Authorize asking ONLY for whoami…
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'u',
      challenge,
      scope: 'tool:whoami',
    })
    // …but /decide tries to grant upload_text too. Must be rejected.
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'u',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami', 'tool:upload_text'],
        approve: true,
      },
    })
    expect(decide.statusCode).toBe(400)
    expect(decide.json().error).toBe('invalid_scope')
    expect(decide.json().error_description).toContain('tool:upload_text')
  })

  it('/decide POST from a foreign Origin is rejected', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { client_name: 'Origin Test', redirect_uris: ['http://127.0.0.1:9999/cb'] },
    })
    const client = reg.json()
    const { challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'o',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: {
        cookie,
        'X-Requested-With': 'fetch',
        origin: 'https://evil.example.com',
      },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'o',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    expect(decide.statusCode).toBe(403)
    expect(decide.json().error).toBe('origin_not_allowed')
  })

  it('/revoke ignores tokens that belong to a different client_id', async () => {
    // Two distinct clients, A and B. A's refresh token is presented
    // to /revoke with B's client_id — must be a no-op (and audit no
    // hit). A's token then continues to work via /token refresh.
    const mkClient = async (name: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { client_name: name, redirect_uris: ['http://127.0.0.1:9999/cb'] },
      })
      return r.json()
    }
    const A = await mkClient('Cross-revoke A')
    const B = await mkClient('Cross-revoke B')
    const { verifier, challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: A.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'xr',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: A.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'xr',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const tokRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: A.client_id,
        code_verifier: verifier,
      },
    })
    const tokens = tokRes.json()

    // Attempt cross-client revoke.
    const rev = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        token: tokens.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: B.client_id,
      },
    })
    expect(rev.statusCode).toBe(200) // RFC 7009 — always 200

    // A's access token still works.
    const probe = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(probe.statusCode).toBe(200)
  })

  // ── Admin OAuth-clients endpoints + cascade ──────────────────────
  // Verifies the admin listing surfaces freshly-registered clients,
  // counts active grants, and that DELETE cascades through the FK
  // chain to drop access + refresh tokens (rendering existing
  // /mcp calls 401 immediately).
  it('admin OAuth clients: GET lists registered clients with usage counts', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Admin-list Visible',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    // Walk a grant for this client so activeGrants > 0 in the listing.
    const { verifier, challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'al',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'al',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })

    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/oauth-clients',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(list.statusCode).toBe(200)
    const row = list.json().clients.find(
      (c: { clientId: string }) => c.clientId === client.client_id,
    )
    expect(row).toBeTruthy()
    expect(row.clientName).toBe('Admin-list Visible')
    expect(row.activeGrants).toBe(1)
    expect(row.hasSecret).toBe(false)
  })

  it('admin OAuth clients: DELETE cascades to access + refresh tokens', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Cascade-delete Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { verifier, challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'cd',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'cd',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const tokRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })
    const tokens = tokRes.json()

    // Confirm the token works pre-delete.
    const pre = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(pre.statusCode).toBe(200)

    // Admin delete.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/oauth-clients/${encodeURIComponent(client.client_id)}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(del.statusCode).toBe(200)

    // Token is dead — ON DELETE CASCADE dropped the row.
    const post = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(post.statusCode).toBe(401)

    // 404 on a re-delete.
    const del2 = await app.inject({
      method: 'DELETE',
      url: `/api/admin/oauth-clients/${encodeURIComponent(client.client_id)}`,
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(del2.statusCode).toBe(404)
  })

  // ── /api/account/preferences + signout cascade-revoke ────────────
  it('PATCH /api/account/preferences updates revokeOauthOnSignout and persists', async () => {
    // Default is undefined/false.
    const before = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(before.json().user.revokeOauthOnSignout).toBeFalsy()

    const upd = await app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { revokeOauthOnSignout: true },
    })
    expect(upd.statusCode).toBe(200)
    expect(upd.json().user.revokeOauthOnSignout).toBe(true)

    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie, 'X-Requested-With': 'fetch' },
    })
    expect(after.json().user.revokeOauthOnSignout).toBe(true)

    // Reset so later tests in this describe see the default behavior.
    await app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { revokeOauthOnSignout: false },
    })
  })

  it('logout cascade-revokes OAuth grants when revokeOauthOnSignout=true', async () => {
    // Use a dedicated user so flipping the pref + logging out doesn't
    // disturb the shared `cookie` other tests depend on.
    await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'oauth-logout-user', password: 'correct-horse-battery' },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'oauth-logout-user', password: 'correct-horse-battery' },
    })
    const userCookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(userCookie).not.toBe('')

    // Flip the preference on.
    await app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie: userCookie, 'X-Requested-With': 'fetch' },
      payload: { revokeOauthOnSignout: true },
    })

    // Register a client + grant.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Signout Cascade Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { verifier, challenge } = pkcePair()
    const auth = await app.inject({
      method: 'GET',
      url:
        '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: 'http://127.0.0.1:9999/cb',
          state: 'lo',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'tool:whoami',
        }).toString(),
      headers: { cookie: userCookie },
    })
    const loc = new URL(auth.headers.location as string)
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie: userCookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'lo',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: loc.searchParams.get('scope'),
        req: loc.searchParams.get('req'),
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const tokRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })
    const tokens = tokRes.json()

    // Grant is live.
    const beforeGrants = await app.inject({
      method: 'GET',
      url: '/api/account/oauth-grants',
      headers: { cookie: userCookie, 'X-Requested-With': 'fetch' },
    })
    expect(
      beforeGrants
        .json()
        .grants.some((g: { clientId: string }) => g.clientId === client.client_id),
    ).toBe(true)

    // Logout — should cascade-revoke.
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: userCookie, 'X-Requested-With': 'fetch' },
    })
    expect(out.statusCode).toBe(200)

    // The access token is dead.
    const probe = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(probe.statusCode).toBe(401)

    // And the audit shows the cascade fired.
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ limit: 200 })
    expect(
      events.some(
        (e) =>
          e.action === 'auth.logout.revoke_oauth' && e.actor === 'oauth-logout-user',
      ),
    ).toBe(true)
  })

  it('logout does NOT revoke grants when revokeOauthOnSignout is false (default)', async () => {
    // Distinct user — pref defaults to false.
    await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'oauth-keep-user', password: 'correct-horse-battery' },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'oauth-keep-user', password: 'correct-horse-battery' },
    })
    const userCookie = setCookieValue(login.headers['set-cookie']) ?? ''

    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Signout Keep Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { verifier, challenge } = pkcePair()
    const auth = await app.inject({
      method: 'GET',
      url:
        '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: 'http://127.0.0.1:9999/cb',
          state: 'k',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'tool:whoami',
        }).toString(),
      headers: { cookie: userCookie },
    })
    const loc = new URL(auth.headers.location as string)
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie: userCookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'k',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: loc.searchParams.get('scope'),
        req: loc.searchParams.get('req'),
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const tokRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })
    const tokens = tokRes.json()

    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: userCookie, 'X-Requested-With': 'fetch' },
    })

    // Token still works — grant survived signout.
    const probe = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } },
    })
    expect(probe.statusCode).toBe(200)
  })

  // ── /token failure paths emit audit entries (M3 hardening) ───────
  it('PKCE failure on /token writes an oauth.token.pkce_failed audit entry', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'PKCE Audit Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const a = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'pa',
      challenge: a.challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'pa',
        code_challenge: a.challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const wrong = pkcePair()
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: wrong.verifier,
      },
    })
    expect(tok.statusCode).toBe(400)

    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: client.client_id, limit: 50 })
    expect(events.some((e) => e.action === 'oauth.token.pkce_failed')).toBe(true)
  })

  // ── Retention sweeps ──────────────────────────────────────────────
  it('pruneAuditOlderThan deletes shards older than the cutoff', async () => {
    const { pruneAuditOlderThan } = await import('./stores/audit.js')
    const { writeFile, mkdir, readdir } = await import('node:fs/promises')
    const pathMod = await import('node:path')
    await mkdir(config.paths.audit, { recursive: true })
    // Drop two shards: one inside the window, one outside (named ~1y ago).
    const oldName = '2024-01-01.jsonl'
    const freshName =
      new Date().toISOString().slice(0, 10) + '.test-fresh.jsonl'
    await writeFile(pathMod.join(config.paths.audit, oldName), '{}\n', 'utf8')
    await writeFile(pathMod.join(config.paths.audit, freshName), '{}\n', 'utf8')

    // 180-day retention drops the 2024 shard but keeps today's.
    const removed = await pruneAuditOlderThan(180)
    expect(removed).toBeGreaterThanOrEqual(1)
    const after = await readdir(config.paths.audit)
    expect(after.includes(oldName)).toBe(false)
    // The fresh test file is not a real YYYY-MM-DD shard so prune
    // keys off `slice(0,10)` which is today's date — leave it alone.
    expect(after.includes(freshName)).toBe(true)
  })

  // MCP `tools/list` must shrink to the scope set the OAuth token
  // actually holds. The end-to-end test asserts that a tools/call
  // outside scope is denied; this one asserts the catalog itself
  // doesn't advertise tools the client can't actually call —
  // critical UX so clients render the correct tool surface and
  // don't waste user-visible "permission denied" failures on
  // tools that should be hidden.
  it('tools/list filters to only granted scopes for OAuth tokens', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Scope-filter Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { verifier, challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'sf',
      challenge,
      scope: 'tool:whoami tool:search_knowledge',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'sf',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami', 'tool:search_knowledge'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!
    const tokRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    })
    const tokens = tokRes.json()

    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(listRes.statusCode).toBe(200)
    const tools = listRes.json().result.tools as Array<{
      name: string
      _meta?: { scope?: string }
    }>
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['search_knowledge', 'whoami'])
    // Each tool carries its required scope in `_meta.scope` so
    // spec-aware clients can show a "needs scope X" hint.
    for (const t of tools) {
      expect(t._meta?.scope).toBe(`tool:${t.name}`)
    }
  })

  // RFC 6749 §3.2 — the /oauth/token endpoint MUST accept
  // application/x-www-form-urlencoded. Every real MCP client (Claude
  // Code, Cursor, Inspector) sends form-encoded. Without
  // @fastify/formbody registered, Fastify drops the body before our
  // handler sees it and the auth flow silently fails — even though
  // JSON requests work. This test pins that codepath.
  it('/oauth/token accepts application/x-www-form-urlencoded bodies', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Form-Encoded Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      },
    })
    const client = reg.json()
    const { verifier, challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'fe',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'fe',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!

    // Exchange — but as form-encoded, not JSON. The body string
    // mirrors what `curl --data-urlencode` or fetch with
    // `URLSearchParams` would send.
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:9999/cb',
      client_id: client.client_id,
      code_verifier: verifier,
    }).toString()
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'fetch',
      },
      payload: form,
    })
    expect(tok.statusCode).toBe(200)
    expect(tok.json().access_token).toMatch(/^oat_/)
  })

  // RFC 6749 §2.3.1 — confidential clients SHOULD use
  // `Authorization: Basic base64(client_id:client_secret)` to
  // authenticate at /oauth/token, as an alternative to sending
  // `client_secret` in the body (`client_secret_post`). Some
  // libraries default to Basic. We accept both.
  it('/oauth/token accepts HTTP Basic client auth (client_secret_basic)', async () => {
    // Register as a CONFIDENTIAL client — gets a secret back.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'X-Requested-With': 'fetch' },
      payload: {
        client_name: 'Basic Auth Test',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    })
    const client = reg.json()
    expect(client.token_endpoint_auth_method).toBe('client_secret_post')
    expect(client.client_secret).toBeTruthy()

    const { verifier, challenge } = pkcePair()
    const bound = await authorizeAndExtractReq({
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:9999/cb',
      state: 'b',
      challenge,
      scope: 'tool:whoami',
    })
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'b',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code = new URL(decide.json().redirect).searchParams.get('code')!

    // Token exchange — Basic header instead of client_id/secret in body.
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:9999/cb',
      code_verifier: verifier,
    }).toString()
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        'X-Requested-With': 'fetch',
      },
      payload: form,
    })
    expect(tok.statusCode).toBe(200)
    const tokens = tok.json()
    expect(tokens.access_token).toMatch(/^oat_/)

    // Wrong secret in Basic → 401, no token issued. Same body, just
    // swap the secret half.
    const wrongBasic = Buffer.from(`${client.client_id}:wrong-secret`).toString('base64')
    // Need a fresh code — the one above was already consumed.
    const decide2 = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: {
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        state: 'b',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: bound.scope,
        req: bound.req,
        scopes: ['tool:whoami'],
        approve: true,
      },
    })
    const code2 = new URL(decide2.json().redirect).searchParams.get('code')!
    const bad = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${wrongBasic}`,
        'X-Requested-With': 'fetch',
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        code_verifier: verifier,
      }).toString(),
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json().error).toBe('invalid_client')

    // Sending BOTH Basic and body creds is a spec violation — must reject.
    const both = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        'X-Requested-With': 'fetch',
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'irrelevant',
        redirect_uri: 'http://127.0.0.1:9999/cb',
        code_verifier: verifier,
        client_id: client.client_id, // illegal alongside Basic
      }).toString(),
    })
    expect(both.statusCode).toBe(400)
    expect(both.json().error).toBe('invalid_request')
  })

  it('pruneStaleClients drops clients > N days old with zero live tokens, leaves active ones', async () => {
    const { db } = await import('./db/sqlite.js')
    const { pruneStaleClients, insertClient } = await import('./db/oauthRepo.js')

    // Stale client: insert + manually backdate createdAt. No tokens.
    const staleId = 'oclient_test_stale_' + Date.now()
    insertClient({
      clientId: staleId,
      clientName: 'Stale GC Test',
      redirectUris: ['http://127.0.0.1:9999/cb'],
    })
    db()
      .prepare(`UPDATE oauth_clients SET created_at = ? WHERE client_id = ?`)
      .run(Date.now() - 1000 * 60 * 60 * 24 * 60, staleId) // 60 days ago

    // Active client: same backdate, but give it a live access token.
    const activeId = 'oclient_test_active_' + Date.now()
    insertClient({
      clientId: activeId,
      clientName: 'Active GC Test',
      redirectUris: ['http://127.0.0.1:9999/cb'],
    })
    db()
      .prepare(`UPDATE oauth_clients SET created_at = ? WHERE client_id = ?`)
      .run(Date.now() - 1000 * 60 * 60 * 24 * 60, activeId)
    db()
      .prepare(
        `INSERT INTO oauth_access_tokens
           (token_hash, client_id, user_id, scopes, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        'hash-active-' + Date.now(),
        activeId,
        'alice',
        'tool:whoami',
        Date.now(),
        Date.now() + 1000 * 60 * 60,
      )

    const n = pruneStaleClients(30 * 24 * 60 * 60 * 1000)
    expect(n).toBeGreaterThanOrEqual(1)

    const stillStale = db()
      .prepare(`SELECT 1 FROM oauth_clients WHERE client_id = ?`)
      .get(staleId)
    expect(stillStale).toBeUndefined()
    const stillActive = db()
      .prepare(`SELECT 1 FROM oauth_clients WHERE client_id = ?`)
      .get(activeId)
    expect(stillActive).toBeTruthy()

    // Cleanup so we don't leave a fake client around for later tests.
    db().prepare(`DELETE FROM oauth_clients WHERE client_id = ?`).run(activeId)
  })
})

// ── Bare-path bytes serving (tryServeBarePath) ──────────────────────
// Verifies that GET /<vault-path> serves file bytes for agents while
// browsers still get the SPA viewer (Accept negotiation). Also exercises
// the access matrix: public, shared, owned, and the 401/403/404 paths.
describe('integration: bare-path bytes', () => {
  let aliceCookie = ''
  let bobCookie = ''

  beforeAll(async () => {
    // Reuse alice (admin from first signup) + create bob.
    let login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    if (login.statusCode !== 200) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
      login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
    }
    aliceCookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(aliceCookie).not.toBe('')

    await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob-barepath', password: 'correct-horse-battery' },
    })
    const bobLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'bob-barepath', password: 'correct-horse-battery' },
    })
    bobCookie = setCookieValue(bobLogin.headers['set-cookie']) ?? ''
  })

  async function uploadAsAlice(rel: string, body: string): Promise<string> {
    const form = new FormData()
    form.append(
      'file',
      new Blob([body], { type: 'text/markdown' }),
      rel.split('/').pop()!,
    )
    const dir = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : ''
    form.append('targetDir', dir)
    const r = await app.inject({
      method: 'POST',
      url: '/api/file/upload',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: form,
    })
    expect([200, 201]).toContain(r.statusCode)
    return r.json().document.storageKey
  }

  it('owner: GET /<path> with cookie returns bytes', async () => {
    const rel = await uploadAsAlice(
      `barepath-owner-${Date.now()}.md`,
      '# Owner test\nHello.',
    )
    const r = await app.inject({
      method: 'GET',
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      headers: { cookie: aliceCookie, accept: '*/*' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toMatch(/markdown|text/)
    expect(r.body).toContain('# Owner test')
  })

  it('anonymous on private file: 401', async () => {
    const rel = await uploadAsAlice(
      `barepath-private-${Date.now()}.md`,
      'private',
    )
    const r = await app.inject({
      method: 'GET',
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      headers: { accept: '*/*' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('anonymous on PUBLIC file: 200 + bytes', async () => {
    const rel = await uploadAsAlice(
      `barepath-public-${Date.now()}.md`,
      '# Public OK',
    )
    // Let ingest finish before flipping visibility — otherwise the
    // async saveMeta from ingestDocument can race with the visibility
    // update and clobber the public flag.
    await new Promise((r) => setTimeout(r, 300))
    // Flip the file to public.
    const pub = await app.inject({
      method: 'POST',
      url: '/api/file/visibility',
      headers: { cookie: aliceCookie, 'X-Requested-With': 'fetch' },
      payload: { path: rel, public: true },
    })
    expect(pub.statusCode).toBe(200)

    const r = await app.inject({
      method: 'GET',
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      headers: { accept: '*/*' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('# Public OK')
  })

  it('browser nav (Accept: text/html) is NOT intercepted — falls through to SPA/404', async () => {
    const rel = await uploadAsAlice(
      `barepath-html-${Date.now()}.md`,
      'browser route',
    )
    // Auth, file exists, but Accept asks for HTML. We should NOT get
    // raw bytes back — let the SPA handle it.
    const r = await app.inject({
      method: 'GET',
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      headers: {
        cookie: aliceCookie,
        accept: 'text/html,application/xhtml+xml',
      },
    })
    // No web bundle is registered in the test harness (config.webDir
    // is unset) so the SPA path lands on the dev 404 instead. The
    // key assertion is: NOT 200 with markdown bytes.
    expect(r.statusCode).toBe(404)
    expect(r.headers['content-type']).toMatch(/json/)
  })

  it('reserved prefix /api/* is never byte-served from bare-path handler', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/this-endpoint-does-not-exist',
      headers: { accept: '*/*' },
    })
    expect(r.statusCode).toBe(404)
    expect(r.headers['content-type']).toMatch(/json/)
    expect(r.json().error).toContain('not found')
  })

  it('path traversal (.. in URL) is rejected', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/foo/../../etc/passwd',
      headers: { cookie: aliceCookie, accept: '*/*' },
    })
    // Either 404 from the helper (path normalized + missing) or
    // 404 from the bare-path handler refusing. The crucial assertion
    // is "no file bytes from outside the vault".
    expect([400, 404]).toContain(r.statusCode)
  })

  it('other user without share-grant: 403/404', async () => {
    const rel = await uploadAsAlice(
      `barepath-cross-${Date.now()}.md`,
      'alice-only',
    )
    const r = await app.inject({
      method: 'GET',
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      headers: { cookie: bobCookie, accept: '*/*' },
    })
    // Bob has no access — could be 404 (file not in his vault) or 403.
    expect([403, 404]).toContain(r.statusCode)
  })
})

// ── MCP: CSV + PDF richer tools, upload_text extension matrix ──────
//
// These exercise the new pdf_page_count, pdf_page_text, csv_columns,
// csv_rows tools + the extended upload_text mime detection. All routed
// through /mcp with an API token (skips the OAuth scope plumbing in
// tests; that's covered separately in the oauth + mcp describe block).
describe('integration: mcp richer tools', () => {
  let cookie = ''
  let token = ''

  beforeAll(async () => {
    let login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    if (login.statusCode !== 200) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
      login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
    }
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    expect(cookie).not.toBe('')
    const tokRes = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'richer-tools-test' },
    })
    expect(tokRes.statusCode).toBe(200)
    token = tokRes.json().secret
    expect(token).toMatch(/^rkn_/)
  })

  async function callTool(name: string, args: unknown): Promise<{ status: number; body: any }> {
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    })
    return { status: r.statusCode, body: r.json() }
  }

  // ── upload_text accepts text-y mimes, rejects binary ─────────────
  it('upload_text writes a .csv with text/csv mime', async () => {
    const r = await callTool('upload_text', {
      path: `richer-tools/sample-${Date.now()}.csv`,
      content: 'name,age,city\nalice,30,NYC\nbob,25,SF\ncarol,35,LA\n',
    })
    expect(r.status).toBe(200)
    expect(r.body.result.isError).not.toBe(true)
    expect(r.body.result.structuredContent.document.mime).toContain('text/csv')
  })

  it('upload_text writes a .json with application/json mime', async () => {
    const r = await callTool('upload_text', {
      path: `richer-tools/config-${Date.now()}.json`,
      content: '{"hello":"world"}\n',
    })
    expect(r.status).toBe(200)
    expect(r.body.result.structuredContent.document.mime).toContain('application/json')
  })

  it('upload_text rejects binary extension with a clear error', async () => {
    const r = await callTool('upload_text', {
      path: `richer-tools/should-fail-${Date.now()}.pdf`,
      content: '%PDF-1.4 fake',
    })
    expect(r.status).toBe(200)
    expect(r.body.result.isError).toBe(true)
    expect(r.body.result.content[0].text).toMatch(/upload_file/i)
  })

  // ── csv_columns + csv_rows ───────────────────────────────────────
  it('csv_columns returns schema + sample rows', async () => {
    const path = `richer-tools/people-${Date.now()}.csv`
    const upload = await callTool('upload_text', {
      path,
      content:
        'name,age,city\nalice,30,NYC\nbob,25,SF\ncarol,35,LA\ndave,40,Austin\n',
    })
    const docId = upload.body.result.structuredContent.document.id

    const cols = await callTool('csv_columns', { id: docId, sampleCount: 2 })
    expect(cols.status).toBe(200)
    expect(cols.body.result.structuredContent.columns).toEqual(['name', 'age', 'city'])
    expect(cols.body.result.structuredContent.rowCount).toBe(4)
    expect(cols.body.result.structuredContent.samples).toHaveLength(2)
    expect(cols.body.result.structuredContent.samples[0]).toMatchObject({ name: 'alice' })
  })

  it('csv_rows pages + projects columns', async () => {
    const path = `richer-tools/rows-${Date.now()}.csv`
    const upload = await callTool('upload_text', {
      path,
      content:
        'name,age,city\nalice,30,NYC\nbob,25,SF\ncarol,35,LA\ndave,40,Austin\neve,45,Boston\n',
    })
    const docId = upload.body.result.structuredContent.document.id

    // Full read
    const all = await callTool('csv_rows', { id: docId })
    expect(all.body.result.structuredContent.totalRows).toBe(5)
    expect(all.body.result.structuredContent.rows).toHaveLength(5)
    expect(all.body.result.structuredContent.hasMore).toBe(false)

    // Page
    const page = await callTool('csv_rows', { id: docId, limit: 2, offset: 1 })
    expect(page.body.result.structuredContent.rows).toHaveLength(2)
    expect(page.body.result.structuredContent.rows[0]).toMatchObject({ name: 'bob' })
    expect(page.body.result.structuredContent.hasMore).toBe(true)

    // Projection
    const proj = await callTool('csv_rows', {
      id: docId,
      limit: 3,
      columns: ['name', 'city'],
    })
    expect(Object.keys(proj.body.result.structuredContent.rows[0])).toEqual(['name', 'city'])
  })

  it('csv_columns refuses non-CSV docs', async () => {
    const upload = await callTool('upload_text', {
      path: `richer-tools/not-a-csv-${Date.now()}.md`,
      content: '# I am markdown',
    })
    const docId = upload.body.result.structuredContent.document.id
    const r = await callTool('csv_columns', { id: docId })
    expect(r.body.result.isError).toBe(true)
    expect(r.body.result.content[0].text).toMatch(/not a CSV/i)
  })

  // ── pdf_page_count + pdf_page_text ───────────────────────────────
  //
  // Generates a tiny single-page PDF on the fly so we don't ship a
  // binary fixture in the repo. PDF.js parses this minimal structure.
  it('pdf_page_count + pdf_page_text on a minimal one-page PDF', async () => {
    const pdfBuf = makeMinimalPdf('Hello PDF page text.')
    const path = `richer-tools/mini-${Date.now()}.pdf`
    const up = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'X-Requested-With': 'fetch' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'upload_file',
          arguments: {
            path,
            content: pdfBuf.toString('base64'),
            mime: 'application/pdf',
          },
        },
      },
    })
    expect(up.statusCode).toBe(200)
    const docId = up.json().result.structuredContent.document.id

    const count = await callTool('pdf_page_count', { id: docId })
    expect(count.status).toBe(200)
    expect(count.body.result.structuredContent.pageCount).toBe(1)

    const page = await callTool('pdf_page_text', { id: docId, page: 1 })
    expect(page.status).toBe(200)
    expect(page.body.result.structuredContent.text).toContain('Hello PDF page text.')

    // Out-of-range page
    const bad = await callTool('pdf_page_text', { id: docId, page: 99 })
    expect(bad.body.result.isError).toBe(true)
    expect(bad.body.result.content[0].text).toMatch(/out of range/i)
  })

  it('pdf_page_count refuses non-PDF docs', async () => {
    const upload = await callTool('upload_text', {
      path: `richer-tools/not-a-pdf-${Date.now()}.md`,
      content: 'still markdown',
    })
    const docId = upload.body.result.structuredContent.document.id
    const r = await callTool('pdf_page_count', { id: docId })
    expect(r.body.result.isError).toBe(true)
    expect(r.body.result.content[0].text).toMatch(/not a PDF/i)
  })
})

/**
 * Smallest valid PDF that exposes one page with a single text string.
 * Hand-rolled rather than pulled from a dep — the binary fixture is
 * ~400 bytes inline and pdfjs-dist parses it without complaint.
 *
 * Adapted from https://gist.github.com/joelthelion (PDF spec §7.3).
 */
function makeMinimalPdf(text: string): Buffer {
  // Escape a few characters that have meaning inside a PDF string literal.
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const content = `BT /F1 24 Tf 50 750 Td (${escaped}) Tj ET`
  const stream = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  const objects: string[] = [
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`,
    `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj`,
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
    `4 0 obj ${stream} endobj`,
    `5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`,
  ]
  const header = '%PDF-1.4\n'
  let body = header
  const offsets: number[] = []
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body))
    body += obj + '\n'
  }
  const xrefStart = Buffer.byteLength(body)
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += String(off).padStart(10, '0') + ' 00000 n \n'
  }
  const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'binary')
}

// ── MCP: 12 new tools + advanced cross-tool workflows ──────────────
describe('integration: mcp expanded toolkit', () => {
  let cookie = ''
  let token = ''

  beforeAll(async () => {
    let login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'X-Requested-With': 'fetch' },
      payload: { username: 'alice', password: 'correct-horse-battery' },
    })
    if (login.statusCode !== 200) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
      login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'X-Requested-With': 'fetch' },
        payload: { username: 'alice', password: 'correct-horse-battery' },
      })
    }
    cookie = setCookieValue(login.headers['set-cookie']) ?? ''
    const tokRes = await app.inject({
      method: 'POST',
      url: '/api/account/tokens',
      headers: { cookie, 'X-Requested-With': 'fetch' },
      payload: { name: 'expanded-toolkit-test' },
    })
    token = tokRes.json().secret
  })

  async function call(name: string, args: unknown): Promise<any> {
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    })
    return r.json()
  }

  it('mcp tools/list exposes all 35 tools', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'X-Requested-With': 'fetch' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(r.statusCode).toBe(200)
    const names = (r.json().result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names.length).toBe(35)
    // Sample-check a few of the new entries to catch typos
    for (const n of ['delete_document', 'unpin', 'resolve_path', 'move_file', 'mkdir', 'rmdir', 'csv_query', 'set_visibility', 'list_pins', 'list_tags', 'list_versions', 'get_pdf_outline', 'restore_version']) {
      expect(names).toContain(n)
    }
  })

  // ── resolve_path: path → meta bridge ─────────────────────────────
  it('resolve_path returns null for missing, meta for present', async () => {
    const path = `expanded/resolve-${Date.now()}.md`
    const missing = await call('resolve_path', { path })
    expect(missing.result.structuredContent.document).toBeNull()
    await call('upload_text', { path, content: 'hello' })
    const found = await call('resolve_path', { path })
    expect(found.result.structuredContent.document).toBeTruthy()
    expect(found.result.structuredContent.document.storageKey).toBe(path)
  })

  // ── mkdir + move_file + delete_document — folder/file lifecycle ──
  it('mkdir → upload_text into it → move_file → delete_document', async () => {
    const folder = `expanded/lifecycle-${Date.now()}`
    const fileA = `${folder}/note.md`
    const fileB = `${folder}/renamed.md`

    const mk = await call('mkdir', { path: folder })
    expect(mk.result.structuredContent.path).toBe(folder)

    const up = await call('upload_text', { path: fileA, content: '# Lifecycle' })
    const docId = up.result.structuredContent.document.id

    const moved = await call('move_file', { id: docId, to: fileB })
    expect(moved.result.structuredContent.from).toBe(fileA)
    expect(moved.result.structuredContent.to).toBe(fileB)
    expect(moved.result.structuredContent.document.storageKey).toBe(fileB)

    // Old path: gone. New path: present.
    const oldLookup = await call('resolve_path', { path: fileA })
    expect(oldLookup.result.structuredContent.document).toBeNull()
    const newLookup = await call('resolve_path', { path: fileB })
    expect(newLookup.result.structuredContent.document.id).toBe(docId)

    // Delete it (move to trash).
    const del = await call('delete_document', { id: docId })
    expect(del.result.structuredContent.trashed).toBe(true)

    // Trashed file should disappear from resolve_path.
    const afterDel = await call('resolve_path', { path: fileB })
    expect(afterDel.result.structuredContent.document).toBeNull()
  })

  // ── move_file rejects destination collision ──────────────────────
  it('move_file refuses to clobber existing destination', async () => {
    const a = `expanded/collide-${Date.now()}-a.md`
    const b = `expanded/collide-${Date.now()}-b.md`
    const upA = await call('upload_text', { path: a, content: 'A' })
    await call('upload_text', { path: b, content: 'B' })
    const r = await call('move_file', { id: upA.result.structuredContent.document.id, to: b })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/already exists/)
  })

  // ── pin / unpin / list_pins cycle ────────────────────────────────
  it('pin → list_pins → unpin → list_pins', async () => {
    const path = `expanded/pin-${Date.now()}.md`
    await call('upload_text', { path, content: 'pin me' })
    await call('pin', { path })
    const after = await call('list_pins', {})
    const pinSet = after.result.structuredContent.pins as Array<{ storageKey: string }>
    expect(pinSet.some((p) => p.storageKey === path)).toBe(true)
    await call('unpin', { path })
    const cleared = await call('list_pins', {})
    const clearedSet = cleared.result.structuredContent.pins as Array<{ storageKey: string }>
    expect(clearedSet.some((p) => p.storageKey === path)).toBe(false)
  })

  // ── set_tags + list_tags consistency ─────────────────────────────
  it('set_tags → list_tags includes new tag with count', async () => {
    const path = `expanded/tag-${Date.now()}.md`
    const tag = `expanded-tag-${Date.now()}`
    const up = await call('upload_text', { path, content: 'x' })
    const docId = up.result.structuredContent.document.id
    await call('set_tags', { id: docId, tags: [tag] })
    const tags = await call('list_tags', {})
    const arr = tags.result.structuredContent.tags as Array<{ tag: string; count: number }>
    const hit = arr.find((t) => t.tag === tag)
    expect(hit).toBeTruthy()
    expect(hit!.count).toBeGreaterThanOrEqual(1)
  })

  // ── set_visibility round-trip via the bare-path bytes handler ────
  it('set_visibility makes a doc reachable anonymously via bare URL', async () => {
    const path = `expanded/visible-${Date.now()}.md`
    const up = await call('upload_text', { path, content: '# Visible content marker.' })
    const docId = up.result.structuredContent.document.id

    // Anon before publish: 401
    const before = await app.inject({
      method: 'GET',
      url: '/' + path.split('/').map(encodeURIComponent).join('/'),
      headers: { accept: '*/*' },
    })
    expect(before.statusCode).toBe(401)

    await call('set_visibility', { id: docId, public: true })

    // Anon after publish: 200 + bytes
    const after = await app.inject({
      method: 'GET',
      url: '/' + path.split('/').map(encodeURIComponent).join('/'),
      headers: { accept: '*/*' },
    })
    expect(after.statusCode).toBe(200)
    expect(after.body).toContain('Visible content marker.')

    // Revoke
    await call('set_visibility', { id: docId, public: false })
    const revoked = await app.inject({
      method: 'GET',
      url: '/' + path.split('/').map(encodeURIComponent).join('/'),
      headers: { accept: '*/*' },
    })
    expect(revoked.statusCode).toBe(401)
  })

  // ── set_visibility with password gates anon w/o it ──────────────
  it('set_visibility with password requires `?p=` to fetch', async () => {
    const path = `expanded/gated-${Date.now()}.md`
    const up = await call('upload_text', { path, content: 'gated content' })
    const docId = up.result.structuredContent.document.id
    await call('set_visibility', { id: docId, public: true, password: 'sesame123' })

    const noPwd = await app.inject({
      method: 'GET',
      url: '/' + path.split('/').map(encodeURIComponent).join('/'),
      headers: { accept: '*/*' },
    })
    expect(noPwd.statusCode).toBe(401)
    expect(noPwd.json().passwordRequired).toBe(true)

    const withPwd = await app.inject({
      method: 'GET',
      url:
        '/' + path.split('/').map(encodeURIComponent).join('/') + '?p=sesame123',
      headers: { accept: '*/*' },
    })
    expect(withPwd.statusCode).toBe(200)
    expect(withPwd.body).toContain('gated content')
  })

  // ── csv_query: WHERE column = value, AND across multiple ─────────
  it('csv_query filters by single + multiple predicates with projection', async () => {
    const path = `expanded/people-${Date.now()}.csv`
    const up = await call('upload_text', {
      path,
      content:
        'name,team,city\nalice,platform,NYC\nbob,growth,SF\ncarol,platform,LA\ndave,infra,Austin\neve,platform,NYC\n',
    })
    const id = up.result.structuredContent.document.id

    const platform = await call('csv_query', {
      id,
      where: [{ column: 'team', equals: 'platform' }],
    })
    expect(platform.result.structuredContent.matched).toBe(3)

    const platformNYC = await call('csv_query', {
      id,
      where: [
        { column: 'team', equals: 'platform' },
        { column: 'city', equals: 'NYC' },
      ],
      columns: ['name'],
    })
    expect(platformNYC.result.structuredContent.matched).toBe(2)
    const rows = platformNYC.result.structuredContent.rows as Array<{ name: string }>
    expect(rows.map((r) => r.name).sort()).toEqual(['alice', 'eve'])
    // Projection should drop other columns.
    expect(Object.keys(rows[0])).toEqual(['name'])
  })

  // ── list_versions + restore_version cycle ────────────────────────
  it('append → list_versions has prior snapshot → restore_version rolls back', async () => {
    const path = `expanded/versioned-${Date.now()}.md`
    const up = await call('upload_text', { path, content: '# Original\n\nOriginal body.\n' })
    const id = up.result.structuredContent.document.id
    // Mutate so a snapshot lands BEFORE the new write.
    await call('append_text', { id, content: '\n\n## Added later\n\nLater content.\n' })
    const versions = await call('list_versions', { id })
    const arr = versions.result.structuredContent.versions as Array<{ ts: number; hasText: boolean }>
    expect(arr.length).toBeGreaterThanOrEqual(1)
    const oldTs = arr[arr.length - 1].ts // oldest snapshot is the pre-append state
    expect(arr[arr.length - 1].hasText).toBe(true)

    const restored = await call('restore_version', { id, ts: oldTs })
    expect(restored.result.isError).not.toBe(true)
    const after = await call('get_document', { id })
    expect(after.result.structuredContent.text).toContain('Original')
    expect(after.result.structuredContent.text).not.toContain('Added later')
  })

  // ── get_pdf_outline: returns empty array for minimal PDF ─────────
  it('get_pdf_outline returns an array (empty for minimal PDF, non-empty for a real one)', async () => {
    const pdfBuf = makeMinimalPdf('No outline here.')
    const path = `expanded/no-outline-${Date.now()}.pdf`
    const up = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'X-Requested-With': 'fetch' },
      payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'upload_file',
          arguments: { path, content: pdfBuf.toString('base64'), mime: 'application/pdf' },
        },
      },
    })
    const docId = up.json().result.structuredContent.document.id
    const r = await call('get_pdf_outline', { id: docId })
    expect(r.result.isError).not.toBe(true)
    expect(Array.isArray(r.result.structuredContent.outline)).toBe(true)
  })

  // ── delete_document trashes the file (not purges) ────────────────
  it('delete_document moves to trash, recoverable via listTrash store', async () => {
    const path = `expanded/trash-me-${Date.now()}.md`
    const up = await call('upload_text', { path, content: 'farewell' })
    const docId = up.result.structuredContent.document.id
    const del = await call('delete_document', { id: docId })
    expect(del.result.structuredContent.trashed).toBe(true)
    const { listTrash } = await import('./stores/trash.js')
    const trash = await listTrash()
    expect(trash.some((e) => e.docId === docId)).toBe(true)
  })

  // ── Negative paths for new tools ────────────────────────────────
  it('csv_query refuses non-CSV', async () => {
    const up = await call('upload_text', {
      path: `expanded/not-csv-${Date.now()}.md`,
      content: '# md',
    })
    const id = up.result.structuredContent.document.id
    const r = await call('csv_query', { id })
    expect(r.result.isError).toBe(true)
  })

  it('get_pdf_outline refuses non-PDF', async () => {
    const up = await call('upload_text', {
      path: `expanded/not-pdf-${Date.now()}.md`,
      content: '# md',
    })
    const id = up.result.structuredContent.document.id
    const r = await call('get_pdf_outline', { id })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/not a PDF/)
  })

  it('restore_version with bogus ts errors cleanly', async () => {
    const up = await call('upload_text', {
      path: `expanded/bad-restore-${Date.now()}.md`,
      content: 'x',
    })
    const id = up.result.structuredContent.document.id
    const r = await call('restore_version', { id, ts: 0 })
    expect(r.result.isError).toBe(true)
  })

  // ── rmdir: empty + refused-non-empty + recursive ─────────────────
  it('rmdir on empty folder removes it', async () => {
    const folder = `expanded/empty-rmdir-${Date.now()}`
    await call('mkdir', { path: folder })
    const r = await call('rmdir', { path: folder })
    expect(r.result.isError).not.toBe(true)
    const parent = folder.split('/').slice(0, -1).join('/')
    const ls = await call('list_folder', { path: parent })
    const items = ls.result.structuredContent.items as Array<{ name: string }>
    expect(items.some((i) => i.name === folder.split('/').pop())).toBe(false)
  })

  it('rmdir refuses non-empty folder without recursive flag', async () => {
    const folder = `expanded/non-empty-rmdir-${Date.now()}`
    await call('mkdir', { path: folder })
    await call('upload_text', { path: `${folder}/blocker.md`, content: 'x' })
    const r = await call('rmdir', { path: folder })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/not empty/i)
    expect(r.result.content[0].text).toMatch(/recursive/i)
  })

  it('rmdir recursive trashes files + removes folder', async () => {
    const folder = `expanded/recursive-rmdir-${Date.now()}`
    await call('mkdir', { path: folder })
    const sub = `${folder}/sub`
    await call('mkdir', { path: sub })
    const a = await call('upload_text', { path: `${folder}/a.md`, content: 'a' })
    const b = await call('upload_text', { path: `${sub}/b.md`, content: 'b' })
    const r = await call('rmdir', { path: folder, recursive: true })
    expect(r.result.isError).not.toBe(true)
    expect(r.result.structuredContent.trashedFiles).toHaveLength(2)

    const lookA = await call('resolve_path', { path: `${folder}/a.md` })
    const lookB = await call('resolve_path', { path: `${sub}/b.md` })
    expect(lookA.result.structuredContent.document).toBeNull()
    expect(lookB.result.structuredContent.document).toBeNull()

    const { listTrash } = await import('./stores/trash.js')
    const trash = await listTrash()
    expect(trash.some((e) => e.docId === a.result.structuredContent.document.id)).toBe(true)
    expect(trash.some((e) => e.docId === b.result.structuredContent.document.id)).toBe(true)
  })
})
