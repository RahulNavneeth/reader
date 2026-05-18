import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { listAllDocuments } from '../stores/documents.js'

/**
 * Atom feed of a user's most recent documents.
 *
 *   /feed.xml?token=<api-token-secret>
 *
 * Token-gated (not cookie) so an RSS reader can poll without a
 * browser session. Use a read-only API token (Settings → API tokens
 * → editor role is enough; the feed only reads).
 *
 * Atom rather than RSS 2.0: the spec is unambiguous about dates and
 * IDs (RSS readers are weirdly forgiving but feeds break when
 * pubDate parsing rolls dice). Atom is the modern choice.
 */
export async function feedRoutes(app: FastifyInstance) {
  app.get('/feed.xml', async (req, reply) => {
    const token = (req.query as { token?: string })?.token?.trim() ?? ''
    if (!token) {
      return reply.code(401).send({ error: 'missing token query param' })
    }
    const { findTokenBySecret } = await import('../stores/tokens.js')
    const t = await findTokenBySecret(token)
    if (!t) return reply.code(401).send({ error: 'invalid token' })

    const username = t.createdBy
    const docs = (await listAllDocuments())
      .filter((d) => d.owner === username)
      .slice(0, 50)

    const base = config.appUrl.replace(/\/+$/, '')
    const updated = new Date(docs[0]?.createdAt ?? Date.now()).toISOString()

    const entries = docs
      .map((d) => {
        const segs = d.storageKey.split('/').map(encodeURIComponent).join('/')
        const link = `${base}/${segs}`
        const created = new Date(d.createdAt).toISOString()
        const summary =
          d.ingest.status === 'ready' || d.ingest.status === 'no-text'
            ? `${d.title} — ${humanBytes(d.bytes)} — ${d.tags?.join(', ') || 'no tags'}`
            : `${d.title} (ingest: ${d.ingest.status})`
        return `  <entry>
    <id>urn:reader:${esc(d.id)}</id>
    <title>${esc(d.title)}</title>
    <link href="${esc(link)}" rel="alternate" type="text/html"/>
    <updated>${created}</updated>
    <published>${created}</published>
    <summary>${esc(summary)}</summary>
  </entry>`
      })
      .join('\n')

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Reader — ${esc(username)}</title>
  <link href="${esc(base)}/" rel="alternate" type="text/html"/>
  <link href="${esc(base)}/feed.xml?token=…" rel="self" type="application/atom+xml"/>
  <id>urn:reader:user:${esc(username)}</id>
  <updated>${updated}</updated>
  <author><name>${esc(username)}</name></author>
${entries}
</feed>`

    reply
      .header('Content-Type', 'application/atom+xml; charset=utf-8')
      // Short cache so multiple readers polling the same URL don't
      // hammer the JSON store; long enough that one new doc shows up
      // within a minute or two.
      .header('Cache-Control', 'private, max-age=60')
      .send(xml)
  })
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
