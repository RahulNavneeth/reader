/**
 * Mustache-ish template engine for `_templates/*.md`.
 *
 * Surface:
 *   {{ var }}                        — flat substitution; unknown names left literal
 *   {{#if name}} … {{/if}}           — render when vars[name] is truthy
 *   {{#if !name}} … {{/if}}          — render when vars[name] is falsy
 *   {{#if name}} … {{else}} … {{/if}}
 *   {{#each list}} … {{/each}}       — iterate a comma-or-newline-separated string
 *     • {{this}}   — current item value (trimmed)
 *     • {{@index}} — 0-based loop counter
 *     • {{@index1}} — 1-based loop counter
 *
 * Truthiness rule for `#if`: present + non-empty, AND not in
 * { '0', 'false', 'no', 'off' } (case-insensitive). Matches what
 * a non-technical author intuitively expects from a checkbox-ish
 * placeholder.
 *
 * Vars stay `Record<string, string>` — the engine never accepts a
 * nested object — so the substitution surface area for an MCP /
 * agent caller can't be abused to inject structured data we don't
 * sanitise.
 */

export type Vars = Record<string, string>

type Token = { kind: 'text'; value: string } | { kind: 'tag'; body: string }

type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string }
  | { type: 'if'; name: string; negate: boolean; then: Node[]; else: Node[] }
  | { type: 'each'; name: string; body: Node[] }
  | { type: 'include'; path: string; section?: string }
  | { type: 'fetch'; url: string }

const TAG_RE = /\{\{\s*([^}]+?)\s*\}\}/g

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(src)) !== null) {
    if (m.index > i) tokens.push({ kind: 'text', value: src.slice(i, m.index) })
    tokens.push({ kind: 'tag', body: m[1].trim() })
    i = m.index + m[0].length
  }
  if (i < src.length) tokens.push({ kind: 'text', value: src.slice(i) })
  return tokens
}

function parseBlock(
  tokens: Token[],
  start: number,
): { nodes: Node[]; end: number; closer: string | null } {
  const nodes: Node[] = []
  let i = start
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.kind === 'text') {
      nodes.push({ type: 'text', value: t.value })
      i++
      continue
    }
    const body = t.body
    // Close / branch markers — return up so the caller can decide
    // whether they're appropriate here.
    if (body === '/if' || body === '/each' || body === 'else') {
      return { nodes, end: i, closer: body }
    }
    const ifMatch = body.match(/^#if\s+(.+)$/)
    if (ifMatch) {
      let cond = ifMatch[1].trim()
      let negate = false
      if (cond.startsWith('!')) {
        negate = true
        cond = cond.slice(1).trim()
      }
      const first = parseBlock(tokens, i + 1)
      let thenNodes = first.nodes
      let elseNodes: Node[] = []
      let after = first.end
      if (first.closer === 'else') {
        const second = parseBlock(tokens, first.end + 1)
        elseNodes = second.nodes
        if (second.closer !== '/if') throw new Error('Unterminated {{#if}} block')
        after = second.end
      } else if (first.closer !== '/if') {
        throw new Error('Unterminated {{#if}} block')
      }
      nodes.push({ type: 'if', name: cond, negate, then: thenNodes, else: elseNodes })
      i = after + 1
      continue
    }
    const eachMatch = body.match(/^#each\s+(.+)$/)
    if (eachMatch) {
      const name = eachMatch[1].trim()
      const inner = parseBlock(tokens, i + 1)
      if (inner.closer !== '/each') throw new Error('Unterminated {{#each}} block')
      nodes.push({ type: 'each', name, body: inner.nodes })
      i = inner.end + 1
      continue
    }
    // {{> path}} or {{> path section="X"}} — vault-fetch partial.
    // The path must stay inside the user's vault; resolution is up
    // to the async renderer, so the parser just captures the path
    // and optional section name. Quotes in section can be single
    // or double; we strip them when extracting the value.
    if (body.startsWith('>')) {
      const inner = body.slice(1).trim()
      const sectionMatch = inner.match(/^(\S+)\s+section\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/)
      if (sectionMatch) {
        nodes.push({
          type: 'include',
          path: sectionMatch[1],
          section: sectionMatch[2] ?? sectionMatch[3],
        })
      } else {
        const pathOnly = inner.match(/^(\S+)\s*$/)
        if (!pathOnly) throw new Error(`Malformed include: {{${body}}}`)
        nodes.push({ type: 'include', path: pathOnly[1] })
      }
      i++
      continue
    }
    // {{fetch url="https://…"}} — opt-in network fetch. Single
    // quotes also accepted for consistency with the include form.
    const fetchMatch = body.match(/^fetch\s+url\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/)
    if (fetchMatch) {
      nodes.push({ type: 'fetch', url: fetchMatch[1] ?? fetchMatch[2] })
      i++
      continue
    }
    // Plain {{ var }}. Reject internal whitespace / unexpected
    // chars so a template author who typo'd a block marker gets a
    // helpful error instead of silent fall-through.
    if (!/^[a-zA-Z0-9_-]+$/.test(body) && body !== 'this' && !body.startsWith('@')) {
      // Treat as literal text — matches the "leave unknown
      // placeholders alone" rule of the flat substituter.
      nodes.push({ type: 'text', value: `{{${body}}}` })
      i++
      continue
    }
    nodes.push({ type: 'var', name: body })
    i++
  }
  return { nodes, end: i, closer: null }
}

function isTruthy(v: string | undefined): boolean {
  if (v == null) return false
  const s = String(v).trim()
  if (!s) return false
  return !['0', 'false', 'no', 'off'].includes(s.toLowerCase())
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return []
  // Newline beats comma — common case for a multi-line var the
  // user pasted from a list. Falls back to comma split for the
  // common API-passes-csv case.
  const sep = raw.includes('\n') ? /\r?\n/ : /,/
  return raw
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function render(nodes: Node[], vars: Vars): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.value
    } else if (n.type === 'var') {
      if (Object.prototype.hasOwnProperty.call(vars, n.name)) {
        out += String(vars[n.name])
      } else {
        // Preserve `{{unknown}}` so the doc still shows the
        // intended placeholder rather than silently swallowing it.
        out += `{{${n.name}}}`
      }
    } else if (n.type === 'if') {
      const truthy = isTruthy(vars[n.name])
      const take = n.negate ? !truthy : truthy
      out += render(take ? n.then : n.else, vars)
    } else if (n.type === 'each') {
      const items = splitList(vars[n.name])
      items.forEach((item, idx) => {
        out += render(n.body, {
          ...vars,
          this: item,
          '@index': String(idx),
          '@index1': String(idx + 1),
        })
      })
    }
  }
  return out
}

function nodesContainFetch(nodes: Node[]): boolean {
  for (const n of nodes) {
    if (n.type === 'include' || n.type === 'fetch') return true
    if (n.type === 'if') {
      if (nodesContainFetch(n.then) || nodesContainFetch(n.else)) return true
    } else if (n.type === 'each') {
      if (nodesContainFetch(n.body)) return true
    }
  }
  return false
}

/** Render `src` with `vars`. Throws on malformed block syntax; the
 *  caller turns that into a 400 so the template author sees a
 *  clear error instead of a half-substituted file landing on disk.
 *
 *  This sync path REJECTS templates that use `{{> path}}` or
 *  `{{fetch url}}` — those need IO and the caller must use the
 *  async variant. Throwing here (rather than silently leaving the
 *  tag literal) keeps the failure obvious during development. */
export function applyTemplate(src: string, vars: Vars): string {
  const tokens = tokenize(src)
  const parsed = parseBlock(tokens, 0)
  if (parsed.closer !== null) {
    throw new Error(`Stray {{${parsed.closer}}} with no matching opener`)
  }
  if (nodesContainFetch(parsed.nodes)) {
    throw new Error(
      'Template uses {{> include}} or {{fetch}} — use applyTemplateAsync to render it.',
    )
  }
  return render(parsed.nodes, vars)
}

/** Resolution callbacks for the async renderer. Both are optional —
 *  if a template references an include / fetch that has no
 *  resolver, we throw so the failure is loud. */
export interface TemplateResolvers {
  /** Read a file out of the user's vault. The path is whatever
   *  the template author wrote after `{{>`; the resolver is
   *  responsible for path-safety (no escape via `../`). If
   *  `section` is set, return only that markdown section's body. */
  loadInclude?: (path: string, section: string | undefined) => Promise<string>
  /** Perform an HTTP GET. The resolver is responsible for SSRF
   *  blocking, timeouts, and size limits. Return the body as
   *  text. */
  loadFetch?: (url: string) => Promise<string>
  /** Max recursion depth for nested includes — guards against a
   *  template that includes itself (`a.md -> b.md -> a.md`).
   *  Default 5. */
  maxDepth?: number
}

async function expandIncludes(
  nodes: Node[],
  resolvers: TemplateResolvers,
  depth: number,
): Promise<Node[]> {
  const max = resolvers.maxDepth ?? 5
  const out: Node[] = []
  for (const n of nodes) {
    if (n.type === 'include') {
      if (!resolvers.loadInclude) {
        throw new Error('Template uses {{> include}} but no resolver was provided')
      }
      if (depth >= max) {
        throw new Error(`Include depth exceeded ${max} — recursive partial?`)
      }
      const content = await resolvers.loadInclude(n.path, n.section)
      const inner = parseBlock(tokenize(content), 0)
      if (inner.closer !== null) {
        throw new Error(`Stray {{${inner.closer}}} in included ${n.path}`)
      }
      const expanded = await expandIncludes(inner.nodes, resolvers, depth + 1)
      out.push(...expanded)
    } else if (n.type === 'fetch') {
      if (!resolvers.loadFetch) {
        throw new Error('Template uses {{fetch}} but no resolver was provided')
      }
      const text = await resolvers.loadFetch(n.url)
      // Fetched content is NOT re-parsed as a template — that would
      // let an external response inject `{{secret}}` substitutions.
      out.push({ type: 'text', value: text })
    } else if (n.type === 'if') {
      out.push({
        ...n,
        then: await expandIncludes(n.then, resolvers, depth),
        else: await expandIncludes(n.else, resolvers, depth),
      })
    } else if (n.type === 'each') {
      out.push({ ...n, body: await expandIncludes(n.body, resolvers, depth) })
    } else {
      out.push(n)
    }
  }
  return out
}

/** Async render. Resolves all `{{> include}}` and `{{fetch}}`
 *  before running the regular substitution + control-flow engine.
 *  Includes are expanded recursively up to `maxDepth`. */
export async function applyTemplateAsync(
  src: string,
  vars: Vars,
  resolvers: TemplateResolvers = {},
): Promise<string> {
  const parsed = parseBlock(tokenize(src), 0)
  if (parsed.closer !== null) {
    throw new Error(`Stray {{${parsed.closer}}} with no matching opener`)
  }
  const expanded = await expandIncludes(parsed.nodes, resolvers, 0)
  return render(expanded, vars)
}
