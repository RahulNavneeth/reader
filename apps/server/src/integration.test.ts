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

describe('integration: security headers', () => {
  it('returns the standard security header bundle on every response', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' })
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['referrer-policy']).toMatch(/strict-origin/i)
    expect(r.headers['permissions-policy']).toContain('camera=()')
  })
})
