import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

    // Audit entry should have landed.
    const { listAudit } = await import('./stores/audit.js')
    const events = await listAudit({ target: token.id, limit: 10 })
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

  it('apply-op rejects unknown opIndex (400)', async () => {
    const r = await apply('asst-preview', 99)
    expect(r.statusCode).toBe(400)
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

describe('integration: security headers', () => {
  it('returns the standard security header bundle on every response', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' })
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['referrer-policy']).toMatch(/strict-origin/i)
    expect(r.headers['permissions-policy']).toContain('camera=()')
  })
})
