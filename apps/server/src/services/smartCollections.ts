/**
 * Smart-collection resolver — turns a `SmartCollectionQuery` into
 * a concrete list of docs by filtering the full owner-scoped
 * corpus at view time.
 *
 * Lives outside `routes/collections.ts` so MCP / agent surfaces can
 * call it directly without re-importing route internals. Pure
 * function: input query + owner, output filtered docs.
 *
 * AND of every set field. The fields themselves use intuitive
 * within-field semantics:
 *
 *   tags        — ANY-of match (doc has at least one of the listed
 *                 tags). Empty array / missing key = no filter.
 *   pathPrefix  — `storageKey.startsWith(prefix)`. Trailing slash
 *                 the caller's choice (we don't enforce one or the
 *                 other, since some users will want a literal
 *                 substring prefix like `journal-2024-`).
 *   mimeKind    — bucketed by extension. `markdown` covers
 *                 `.md/.markdown/.mdx`; the rest are extension-
 *                 sniffed the same way the timeline route does.
 *   dateFromTs  — inclusive lower bound on `createdAt`.
 *   dateToTs    — inclusive upper bound on `createdAt`.
 *   archived    — tri-state: undefined hides archived (default),
 *                 true includes them, false explicitly excludes
 *                 (same as default but unambiguous in the wire
 *                 protocol).
 */
import type { DocumentMeta } from '../types.js'
import type { SmartCollectionQuery } from '../db/collectionsRepo.js'
import { listAllDocuments } from '../stores/documents.js'
import { searchKnowledge } from './search.js'
import { getUser } from '../stores/users.js'

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp|ico|heic|heif|tiff?|jxl)$/
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|webm|avi|3gp|3gpp|mts|m2ts|mpg|mpeg|wmv|flv|ogv)$/
const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/

function kindOf(filename: string): 'image' | 'video' | 'file' | 'markdown' {
  const ext = filename.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ''
  if (IMAGE_EXT_RE.test(ext)) return 'image'
  if (VIDEO_EXT_RE.test(ext)) return 'video'
  if (MARKDOWN_EXT_RE.test(ext)) return 'markdown'
  return 'file'
}

export async function resolveSmartCollection(
  query: SmartCollectionQuery,
  owner: string,
): Promise<DocumentMeta[]> {
  // If the query asks for semantic similarity, lean on the same
  // Ollama-backed search the search bar uses — it returns ranked
  // doc ids. We then layer the structural filters (tags, path,
  // date, mime, archived) as an intersection. Order = search
  // rank when semantic; createdAt-desc otherwise.
  const semantic = query.semanticQuery?.trim()
  let candidateIds: string[] | null = null
  let semanticRank = new Map<string, number>()
  if (semantic) {
    // searchKnowledge needs a `role` to enforce ACL even though
    // the resolver caller is always the owner — load it once.
    const user = await getUser(owner)
    if (user) {
      const hits = await searchKnowledge({
        q: semantic,
        user: { username: owner, role: user.role },
        limit: Math.max(1, Math.min(200, query.semanticLimit ?? 50)),
        filters: {
          archived: query.archived === true ? true : false,
        },
      }).catch(() => [])
      candidateIds = hits.map((h) => h.docId)
      hits.forEach((h, i) => semanticRank.set(h.docId, i))
    }
  }
  const all = await listAllDocuments()
  const out: DocumentMeta[] = []
  for (const d of all) {
    if (d.owner !== owner) continue
    // Archived filter — mirror semantics of the other surfaces.
    if (query.archived === undefined && d.archived) continue
    if (query.archived === false && d.archived) continue
    // `archived === true` is permissive ("include archived"); no
    // filter to apply here.
    if (query.pathPrefix && !d.storageKey.startsWith(query.pathPrefix)) continue
    if (query.dateFromTs != null && d.createdAt < query.dateFromTs) continue
    if (query.dateToTs != null && d.createdAt > query.dateToTs) continue
    if (query.tags && query.tags.length > 0) {
      const docTags = d.tags ?? []
      const anyMatch = query.tags.some((t) => docTags.includes(t))
      if (!anyMatch) continue
    }
    if (query.mimeKind) {
      if (kindOf(d.originalFilename || d.storageKey) !== query.mimeKind) continue
    }
    // Semantic intersection — the doc must rank in searchKnowledge
    // results, AND survive the structural filters above. Ordering
    // by search rank happens after the loop.
    if (candidateIds && !semanticRank.has(d.id)) continue
    out.push(d)
  }
  if (semantic && candidateIds) {
    // Order by Ollama's similarity rank — most semantically
    // relevant first. Docs that survived the filters but aren't
    // in semanticRank shouldn't be here (we filtered above), but
    // guard with a fallback to a large rank for safety.
    out.sort((a, b) => {
      const ra = semanticRank.get(a.id) ?? 1e9
      const rb = semanticRank.get(b.id) ?? 1e9
      return ra - rb
    })
  } else {
    // Newest first — same default as Timeline so the listing feels
    // consistent across surfaces.
    out.sort((a, b) => b.createdAt - a.createdAt)
  }
  return out
}
