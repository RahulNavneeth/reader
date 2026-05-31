import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, X, AlertCircle, ExternalLink, Sparkles, RefreshCw, Shield, Info, Copy as CopyIcon, Trash2, Loader2, Check, MessageCircle, ArrowUp, Pencil, Braces } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import 'highlight.js/styles/github.css'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api, type DocumentMeta } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { useConfirm } from '../lib/confirm'
import { copyText } from '../lib/clipboard'
import {
  parseImageSize,
  resolveImageSrc,
  resolveLinkHref,
} from '../lib/markdownAssetResolver'
import { setFaviconForFile } from '../lib/favicon'
import { PathBreadcrumb } from './PathBreadcrumb'
import { TagsButton } from './TagsButton'
import { ActivityButton } from './ActivityButton'
import { FindSimilarButton } from './FindSimilarButton'
import { CollectionsToolbarButton } from './CollectionsToolbarButton'
import { DocRail } from './DocRail'
import { VersionDiffView } from './VersionDiffView'
import { ProposedEditPreview, type PreviewData } from './ProposedEditPreview'
import { PublicButton } from './PublicButton'
import { ShareWithUserButton } from './ShareWithUserButton'
import { CsvTable } from './CsvTable'
import { JsonView } from './JsonView'
import { MetadataPanel } from './MetadataPanel'
import { ChatDock } from './ChatDock'
import { SelectionPopover } from './SelectionPopover'
import { PinButton } from './PinButton'
import { LockButton } from './LockButton'
import { ArchiveButton } from './ArchiveButton'
import { DuplicateButton } from './DuplicateButton'
import { SaveAsTemplateButton } from './SaveAsTemplateButton'
import { RefreshTemplateButton } from './RefreshTemplateButton'
import { MediaPlayer } from './MediaPlayer'
import { useReaderEvents } from '../lib/events'
import { useCrdtBody } from '../lib/crdt/useCrdtBody'
import { CrdtEditor } from './CrdtEditor'
import { PasteMediaDialog } from './PasteMediaDialog'
import { CommentHighlights } from './CommentHighlights'
import type { EditorView } from '@codemirror/view'

type Props = {
  path: string
  /** True for own-vault files, or shared paths where the recipient has
   *  canEdit. Drives which toolbar affordances render in shared
   *  views — read-only recipients see only navigation + Download. */
  canEdit?: boolean
}

/** Split a markdown source on its leading YAML frontmatter block.
 *  Returns `{ yaml, body }` where yaml is the raw YAML text (without
 *  the `---` fences) or null when no block is present. We don't
 *  parse the YAML — the doc viewer only needs the raw string to
 *  render in the info chip, and only needs the body to render the
 *  markdown. The closer must sit on its own line so a literal
 *  `---` somewhere mid-doc isn't mis-detected as a closer. */
function splitFrontmatter(src: string): { yaml: string | null; body: string } {
  // BOM tolerance — some editors prepend U+FEFF.
  const trimmed = src.startsWith('﻿') ? src.slice(1) : src
  const openMatch = trimmed.match(/^---\s*\r?\n/)
  if (!openMatch) return { yaml: null, body: src }
  const after = trimmed.slice(openMatch[0].length)
  const closer = after.match(/\r?\n---\s*(\r?\n|$)/)
  if (!closer) return { yaml: null, body: src }
  const yaml = after.slice(0, closer.index!)
  const body = after.slice(closer.index! + closer[0].length)
  return { yaml, body }
}

/** Compact one-line summary of frontmatter YAML for the info chip.
 *  Counts top-level recognised keys (vars, schedules / schedule)
 *  with a regex scan so we don't pull in a YAML parser on the
 *  client. Falls back to "Frontmatter" when nothing recognisable
 *  shows up. */
function summariseFrontmatter(yaml: string): string {
  const bits: string[] = []
  // `vars:` followed by indented `- name:` entries. Count the
  // entries so the chip reads "3 vars" not "vars: present".
  const varsHeader = yaml.match(/^vars:\s*$/m)
  if (varsHeader) {
    const after = yaml.slice(varsHeader.index! + varsHeader[0].length)
    const varCount = (after.match(/^\s+-\s+name:/gm) ?? []).length
    if (varCount > 0) bits.push(`${varCount} var${varCount === 1 ? '' : 's'}`)
  }
  // `schedules:` array. Same shape.
  const schedHeader = yaml.match(/^schedules:\s*$/m)
  if (schedHeader) {
    const after = yaml.slice(schedHeader.index! + schedHeader[0].length)
    const count = (after.match(/^\s+-\s+cron:/gm) ?? []).length
    if (count > 0) bits.push(`${count} schedule${count === 1 ? '' : 's'}`)
  }
  // Legacy single `schedule: "..."` line.
  if (/^schedule:\s*['"]?\S/m.test(yaml) && !schedHeader) {
    bits.push('1 schedule')
  }
  return bits.length > 0 ? bits.join(' · ') : 'Frontmatter'
}

/** Per-document caret position keyed by vault path. Survives
 *  navigation within a session: open `a.md`, scroll/edit, open
 *  `b.md`, come back to `a.md` — caret lands where it was. */
const docCursorMap = new Map<string, { anchor: number; head: number }>()

/**
 * Rehype plugin: walks text nodes in the HAST tree and wraps
 * `{{…}}` tokens in styled `<span>`s so the rendered preview
 * highlights template-engine syntax the same way the editor
 * used to. Two categories:
 *
 *   - `{{#if …}}` / `{{else}}` / `{{/if}}` etc. — `md-tmpl-control`
 *   - `{{varname}}` (anything else) — `md-tmpl-var`
 *
 * Skips text inside `<code>` / `<pre>` so a literal `{{x}}` in
 * a code sample reads as code, not as a template token.
 */
function rehypeTemplateSyntax() {
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g
  type Node = {
    type: string
    tagName?: string
    value?: string
    properties?: Record<string, unknown>
    children?: Node[]
  }
  const inCode = (parents: Node[]) =>
    parents.some(
      (p) => p.tagName === 'code' || p.tagName === 'pre',
    )
  const walk = (node: Node, parents: Node[]) => {
    if (!node.children) return
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (child.type === 'text' && !inCode(parents.concat(node))) {
        const text = child.value ?? ''
        re.lastIndex = 0
        if (!re.test(text)) continue
        re.lastIndex = 0
        const out: Node[] = []
        let lastIdx = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          if (m.index > lastIdx) {
            out.push({ type: 'text', value: text.slice(lastIdx, m.index) })
          }
          const inner = m[1].trim()
          const isControl =
            inner.startsWith('#') ||
            inner.startsWith('/') ||
            inner === 'else'
          // Three-part chip: opening braces, inner expression,
          // closing braces. CSS dims the braces so the body
          // reads as the meaningful part of the token.
          const inner_text = m[0].slice(2, -2)
          out.push({
            type: 'element',
            tagName: 'span',
            properties: {
              className: [
                'md-tmpl-token',
                isControl ? 'md-tmpl-control' : 'md-tmpl-var',
              ],
            },
            children: [
              {
                type: 'element',
                tagName: 'span',
                properties: { className: ['md-tmpl-brace'] },
                children: [{ type: 'text', value: '{{' }],
              },
              {
                type: 'element',
                tagName: 'span',
                properties: { className: ['md-tmpl-body'] },
                children: [{ type: 'text', value: inner_text }],
              },
              {
                type: 'element',
                tagName: 'span',
                properties: { className: ['md-tmpl-brace'] },
                children: [{ type: 'text', value: '}}' }],
              },
            ],
          })
          lastIdx = m.index + m[0].length
        }
        if (lastIdx < text.length) {
          out.push({ type: 'text', value: text.slice(lastIdx) })
        }
        node.children.splice(i, 1, ...out)
        i += out.length - 1
      } else if (child.type === 'element') {
        walk(child, parents.concat(node))
      }
    }
  }
  return (tree: Node) => walk(tree, [])
}

/**
 * Stamps every block-level element produced by remark with a
 * `data-source-line` attribute carrying its 1-based start line
 * in the markdown source. Reader's edit ↔ preview scroll sync
 * uses this to land the editor on the exact line the user was
 * reading in the preview, not just the nearest heading. The
 * position data comes from remark-parse and survives the
 * remark-rehype hop via `node.position`.
 */
function rehypeSourceLine() {
  type Node = {
    type: string
    tagName?: string
    properties?: Record<string, unknown>
    children?: Node[]
    position?: { start?: { line?: number } }
  }
  const walk = (node: Node) => {
    if (node.type === 'element' && node.tagName && node.position?.start?.line) {
      const props = (node.properties ??= {}) as Record<string, unknown>
      if (props['data-source-line'] == null) {
        props['data-source-line'] = String(node.position.start.line)
      }
    }
    for (const child of node.children ?? []) {
      if (child.type === 'element' || child.type === 'root') walk(child)
    }
  }
  return (tree: Node) => walk(tree)
}

/**
 * After `rehypeTemplateSyntax` has wrapped `{{…}}` tokens, this
 * second pass pairs balanced `{{#if}}` / `{{/if}}` (and similar
 * `#each` / `#unless`) paragraphs at the document root and
 * wraps everything between an opener and its matching closer in
 * a `<div class="md-tmpl-block">`. CSS adds the indent + a
 * subtle left rule so the block structure of a template doc
 * reads at a glance.
 *
 * Properly handles nested blocks via a stack — outer `#if`
 * doesn't get its content double-indented just because an inner
 * `#if` happens before its closer.
 */
function rehypeTemplateIndent() {
  type Node = {
    type: string
    tagName?: string
    properties?: Record<string, unknown>
    children?: Node[]
  }
  /** Returns 'open' / 'close' if this root child is a paragraph
   *  whose only meaningful content is a single template control
   *  token (`{{#…}}` or `{{/…}}`). */
  const classify = (n: Node): 'open' | 'close' | null => {
    if (n.type !== 'element' || n.tagName !== 'p') return null
    const meaningful = (n.children || []).filter(
      (c) =>
        !(c.type === 'text' && /^\s*$/.test(((c as { value?: string }).value) || '')),
    )
    if (meaningful.length !== 1) return null
    const sole = meaningful[0]
    if (sole.type !== 'element' || sole.tagName !== 'span') return null
    const cls = (sole.properties?.className as string[] | undefined) ?? []
    if (!cls.includes('md-tmpl-control')) return null
    const body = (sole.children || []).find(
      (c) =>
        c.type === 'element' &&
        c.tagName === 'span' &&
        (
          ((c.properties?.className as string[] | undefined) ?? []) as string[]
        ).includes('md-tmpl-body'),
    )
    const txt =
      (body?.children?.[0] as { value?: string } | undefined)?.value ?? ''
    const trimmed = txt.trim()
    if (trimmed.startsWith('/')) return 'close'
    if (trimmed.startsWith('#')) return 'open'
    return null
  }

  return (tree: Node) => {
    if (!tree.children) return
    const children = tree.children
    // Stack of opener indices at the root level. Each entry is
    // the index of an `{{#…}}` paragraph waiting for its match.
    const stack: number[] = []
    // Pairs of [openerIdx, closerIdx] — collected first, then
    // applied in reverse so wrapping doesn't perturb earlier
    // indices.
    const pairs: Array<[number, number]> = []
    for (let i = 0; i < children.length; i++) {
      const kind = classify(children[i])
      if (kind === 'open') {
        stack.push(i)
      } else if (kind === 'close') {
        const opener = stack.pop()
        if (opener != null) pairs.push([opener, i])
      }
    }
    // Apply outer-most first when working bottom-up (innermost
    // pairs come first in `pairs` since they're pushed earlier).
    // Sort by opener index descending so each wrap operation
    // works on still-valid indices.
    pairs.sort((a, b) => b[0] - a[0])
    for (const [opener, closer] of pairs) {
      if (closer - opener <= 1) continue // empty block, nothing to wrap
      const inside = children.splice(opener + 1, closer - opener - 1)
      const wrapper: Node = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['md-tmpl-block'] },
        children: inside,
      }
      children.splice(opener + 1, 0, wrapper)
    }
  }
}

export function PathViewer({ path, canEdit = true }: Props) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // When opened from a "Shared with me" entry the URL carries ?owner=<other
  // user>. All read API calls in this component thread it through so we
  // resolve under the right namespace instead of the requester's.
  const ownerOpt = searchParams.get('owner') || undefined
  const callerOpts = ownerOpt ? { owner: ownerOpt } : undefined
  const { setCurrentFolder, refresh, chatEnabled, currentUsername } = useVault()
  const confirm = useConfirm()
  const [copyBusy, setCopyBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  // Edit mode: when true, the viewer renders <CrdtEditor> instead
  // of the read-only markdown render. Local typing flows into the
  // Y.Text via useCrdtBody.replace, which broadcasts to every
  // other connected viewer of this docId.
  const [editing, setEditing] = useState(false)
  // Latest editor caret/selection — backed by the module-level
  // map so it persists across file switches in the session.
  const editorSelectionRef = useRef<{ anchor: number; head: number } | null>(
    null,
  )
  // Scroll-sync target line, captured at toggle time. The next
  // mounted view (CrdtEditor or the rendered preview) reads it
  // to align its viewport.
  const scrollAnchorLineRef = useRef<number | null>(null)
  // Viewer scrollTop right AFTER the Edit→Preview anchor scroll
  // lands. Used at the next Preview→Edit toggle to decide whether
  // the user scrolled inside the viewer:
  //   - unchanged → snap editor back to the cursor (smooth round-trip)
  //   - changed   → follow the new scroll position via the topmost
  //                 heading in view
  const viewerLandingScrollRef = useRef<number | null>(null)
  // Top-of-viewport line in the editor at the moment we leave Edit
  // mode. When the user round-trips back without scrolling the
  // viewer, we restore THIS line at the viewport top instead of
  // re-centering on the cursor (which can push the heading off
  // screen) or using raw scrollTop (which gets clamped by CM's
  // virtual-viewport measurement on remount).
  const editorTopLineRef = useRef<number | null>(null)
  // Imperative handle to the live CodeMirror view, populated
  // by CrdtEditor on mount. Lets us read the top viewport line
  // at toggle time without prop-drilling.
  const crdtViewRef = useRef<EditorView | null>(null)
  /** When the user pastes a file blob in edit mode, CrdtEditor
   *  prevents the default text-paste and bubbles the file up
   *  here. We then render the PasteMediaDialog so the user can
   *  pick destination + filename before upload. */
  const [pastedMediaFile, setPastedMediaFile] = useState<File | null>(null)
  // Save/restore the caret as we navigate between files. Cleanup
  // runs JUST BEFORE the new path replaces the current one.
  useEffect(() => {
    editorSelectionRef.current = docCursorMap.get(path) ?? null
    scrollAnchorLineRef.current = null
    editorTopLineRef.current = null
    viewerLandingScrollRef.current = null
    return () => {
      const sel = editorSelectionRef.current
      if (sel) docCursorMap.set(path, sel)
    }
  }, [path])
  const [frontmatterOpen, setFrontmatterOpen] = useState(false)
  const [frontmatterError, setFrontmatterError] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  /** Outline section state inside the rail. When both this AND
   *  versionsOpen are false, the rail itself shrinks to 32 px
   *  with two stacked icons (outline + versions). Otherwise the
   *  rail is 240 px and shows headers for both sections, with
   *  each section's body visible only when its own flag is true. */
  const [outlineOpen, setOutlineOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:outlineOpen') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('reader:outlineOpen', outlineOpen ? '1' : '0') } catch { /* ignore */ }
  }, [outlineOpen])
  const [versionsOpen, setVersionsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:versionsRailOpen') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('reader:versionsRailOpen', versionsOpen ? '1' : '0') } catch { /* ignore */ }
  }, [versionsOpen])
  // Peers rail section — sits below Versions in the right rail.
  // Visible only when peers are present (DocRail hides itself
  // when none).
  const [peersOpen, setPeersOpen] = useState<boolean>(false)
  // Comments rail section — sits below Peers. Available for any
  // markdown doc the viewer can read. Storage + RBAC happen in
  // /api/comments; we cache the list here so the floating "+"
  // button can push new rows without re-fetching.
  const [commentsOpen, setCommentsOpen] = useState<boolean>(false)
  const [comments, setComments] = useState<import('../lib/api').CommentDTO[] | null>(null)
  const viewerBodyRef = useRef<HTMLDivElement | null>(null)
  // Platform-aware shortcut hint shown on the Edit button + the
  // aria-keyshortcuts attribute. `⌘E` on macOS, `Ctrl+E` else.
  const editShortcutHint = useMemo(() => {
    if (typeof navigator === 'undefined') return 'Ctrl+E'
    return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘E' : 'Ctrl+E'
  }, [])
  /** Active diff state. When non-null, the main content area
   *  swaps from rendered markdown to an inline line-by-line diff
   *  between this version's snapshot and the current text. */
  const [diffTs, setDiffTs] = useState<number | null>(null)
  /** Active proposed-edit preview. When set, the main content area
   *  swaps from rendered markdown to an inline diff between the
   *  current doc and what it would look like after applying this
   *  message's pending edit. */
  const [previewMessageId, setPreviewMessageId] = useState<string | null>(null)
  /** Cache of fetched preview payloads, keyed by messageId. Lets
   *  the user toggle preview ↔ back without re-fetching (and
   *  without showing the loading flicker on the second open). */
  const previewCacheRef = useRef<Map<string, PreviewData>>(new Map())
  // Tick state so React re-renders when cache fills. The ref is
  // the source of truth — we just need to nudge a render.
  const [, setPreviewCacheTick] = useState(0)
  /** Bumped on per-op apply / discard so ChatDock reloads its
   *  history and the proposed-edit card reflects the shrunken
   *  pendingEdit array (or flips to Applied if empty). */
  const [chatHistoryReloadKey, setChatHistoryReloadKey] = useState(0)
  /** Bumped when the user restores a version — DocRail re-fetches
   *  /api/file/versions so the new pre-restore snapshot row appears
   *  at the top of the list without a page reload. */
  const [versionsReloadKey, setVersionsReloadKey] = useState(0)
  // Load comments whenever the open doc changes. Re-fires on
  // ownerOpt too because shared-with-me edits share the same docId
  // but we want to refetch when the active vault flips. We DON'T
  // re-fetch on every text change — comments only mutate via the
  // explicit POST/DELETE/resolve actions, and those update local
  // state inline.
  useEffect(() => {
    if (!meta?.id) {
      setComments(null)
      return
    }
    const docId = meta.id
    let cancelled = false
    api
      .listComments(docId)
      .then((r) => {
        if (!cancelled) setComments(r.comments)
      })
      .catch(() => {
        if (!cancelled) setComments([])
      })
    return () => {
      cancelled = true
    }
  }, [meta?.id, ownerOpt])
  const handleCommentCreated = useCallback(
    (c: import('../lib/api').CommentDTO) => {
      setComments((prev) => (prev ? [...prev, c] : [c]))
      setCommentsOpen(true)
    },
    [],
  )
  /** Click on an in-doc highlight → open the rail + flash the
   *  matching row. The rail already supports scroll-to-anchor for
   *  the inverse direction. */
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null)
  const handleHighlightClick = useCallback(
    (c: import('../lib/api').CommentDTO) => {
      setCommentsOpen(true)
      setFocusedCommentId(c.id)
      // Auto-clear the focus flash so the next interaction starts
      // clean. 1.5s is enough for the user to spot it.
      window.setTimeout(() => {
        setFocusedCommentId((cur) => (cur === c.id ? null : cur))
      }, 1500)
    },
    [],
  )
  const handleCommentResolve = useCallback(
    async (c: import('../lib/api').CommentDTO, resolved: boolean) => {
      if (!meta?.id) return
      try {
        const { comment } = await api.resolveComment(c.id, meta.id, resolved)
        setComments((prev) =>
          prev ? prev.map((x) => (x.id === comment.id ? comment : x)) : prev,
        )
      } catch {
        /* swallow — the optimistic state will reconcile on next fetch */
      }
    },
    [meta?.id],
  )
  const handleCommentDelete = useCallback(
    async (c: import('../lib/api').CommentDTO) => {
      if (!meta?.id) return
      try {
        await api.deleteComment(c.id, meta.id)
        setComments((prev) => (prev ? prev.filter((x) => x.id !== c.id) : prev))
      } catch {
        /* swallow */
      }
    },
    [meta?.id],
  )
  /** Pending scroll target — populated when the user clicks a
   *  rail row while the doc is in edit mode. We flip back to
   *  preview, then an effect re-runs the scroll once viewerBodyRef
   *  is mounted again. */
  const pendingScrollCommentRef = useRef<import('../lib/api').CommentDTO | null>(null)
  const handleScrollToComment = useCallback(
    (c: import('../lib/api').CommentDTO) => {
      // Preview-mode only — we walk the rendered body's text
      // nodes to locate the range, and those nodes only exist
      // when viewerBodyRef is mounted. If the user is in edit /
      // diff / chat-preview view, stash the target and trigger
      // a return to preview; the drain effect below retries.
      if (!viewerBodyRef.current) {
        pendingScrollCommentRef.current = c
        if (editing) setEditing(false)
        if (diffTs !== null) setDiffTs(null)
        if (previewMessageId !== null) setPreviewMessageId(null)
        return
      }
      const root = viewerBodyRef.current
      const scroller = contentRef.current
      if (!root || !scroller) return
      // Try the stored offsets first, but verify the resulting
      // range's text matches the saved quote — old comments may
      // have been written with the pre-fix offset bug, in which
      // case the range covers way too much. Fall back to a
      // textContent substring search.
      const findHit = (): { node: Text; offset: number } | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let consumed = 0
        let cur: Node | null = walker.nextNode()
        while (cur) {
          const t = cur as Text
          const len = t.data.length
          if (consumed + len >= c.rangeStart) {
            return { node: t, offset: c.rangeStart - consumed }
          }
          consumed += len
          cur = walker.nextNode()
        }
        return null
      }
      let hit = findHit()
      const fallbackToQuote = () => {
        const txt = root.textContent ?? ''
        const idx = txt.indexOf(c.quote)
        if (idx < 0) return null
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let s = 0
        let cur: Node | null = walker.nextNode()
        while (cur) {
          const t = cur as Text
          if (s + t.data.length >= idx) {
            return { node: t, offset: Math.max(0, idx - s) }
          }
          s += t.data.length
          cur = walker.nextNode()
        }
        return null
      }
      if (!hit) hit = fallbackToQuote()
      if (!hit) return
      // Range build can throw if findHit lands the offset at the
      // exact end of a text node — setEnd at offset+1 then
      // exceeds data.length and the API throws IndexSizeError.
      // Cap end to the node's own length so the range is always
      // valid; on any other error bail silently rather than
      // killing the rest of the handler.
      let range: Range
      try {
        range = document.createRange()
        const safeStart = Math.min(hit.offset, hit.node.data.length)
        range.setStart(hit.node, safeStart)
        const remaining = hit.node.data.length - safeStart
        const tailLen = Math.min(
          Math.max(remaining, 0),
          Math.max(1, c.quote.length),
        )
        range.setEnd(hit.node, safeStart + tailLen)
      } catch {
        return
      }

      // Drive the doc scroller (contentRef) directly. We compute
      // target scrollTop using the RANGE's bounding rect (precise
      // text position) rather than hit.node.parentElement — the
      // latter could be `<article>` (whole body wrapper) when the
      // text is a direct child, which clamped every scroll to 0
      // and made every click "scroll up only" feel.
      const docScroller = contentRef.current
      if (!docScroller) return
      let rangeRect: DOMRect
      try {
        rangeRect = range.getBoundingClientRect()
      } catch {
        return
      }
      // If the range yielded a zero rect (collapsed / hidden),
      // walk up looking for an element with a real layout box.
      let useRect: DOMRect = rangeRect
      if (rangeRect.width === 0 && rangeRect.height === 0) {
        let el: HTMLElement | null = hit.node.parentElement
        while (el) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 || r.height > 0) {
            useRect = r
            break
          }
          el = el.parentElement
        }
      }
      // Brute-force scroll EVERY overflow-y:auto/scroll ancestor
      // that has scrollHeight > clientHeight, including contentRef.
      // We can't rely on one named scroller — if a wrapper between
      // contentRef and the article ended up being the real scroller
      // due to some flex/height interaction, this catches it. Each
      // attempt no-ops harmlessly if the element doesn't need to
      // move.
      const candidates: HTMLElement[] = []
      const knownScroller = contentRef.current
      if (knownScroller) candidates.push(knownScroller)
      let walker: HTMLElement | null = hit.node.parentElement
      while (walker && walker !== document.body) {
        if (
          !candidates.includes(walker) &&
          walker.scrollHeight > walker.clientHeight + 1
        ) {
          const cs = getComputedStyle(walker)
          if (
            cs.overflowY === 'auto' ||
            cs.overflowY === 'scroll' ||
            cs.overflowY === 'overlay'
          ) {
            candidates.push(walker)
          }
        }
        walker = walker.parentElement
      }
      for (const sc of candidates) {
        const sr = sc.getBoundingClientRect()
        const delta = useRect.top - sr.top
        const maxScroll = sc.scrollHeight - sc.clientHeight
        const tgt = Math.max(0, Math.min(maxScroll, sc.scrollTop + delta - 120))
        sc.scrollTo({ top: tgt, behavior: 'smooth' })
      }
      // Don't programmatically select the range — that would
      // re-trigger SelectionPopover's "Explain | Reply | Comment"
      // chip, popping up unwanted action buttons on every click.
      // The in-doc comment highlight already provides visible
      // confirmation of where the scroll landed.
    },
    [],
  )
  // Drain the pending-scroll queue once we're back in the
  // preview render path AND the body has mounted. Triggered by
  // every state change that controls whether viewerBodyRef gets
  // rendered (editing, diffTs, previewMessageId). Two rAFs to
  // wait for layout + paint so getBoundingClientRect is accurate.
  useEffect(() => {
    if (editing || diffTs !== null || previewMessageId !== null) return
    const pending = pendingScrollCommentRef.current
    if (!pending) return
    // Only drain once the body ref is actually live.
    if (!viewerBodyRef.current) return
    pendingScrollCommentRef.current = null
    const r1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => handleScrollToComment(pending))
    })
    return () => cancelAnimationFrame(r1)
  }, [editing, diffTs, previewMessageId, handleScrollToComment])
  // Deep-link: if the URL carries ?comment=<id>, scroll to that
  // comment as soon as the comments list (and the doc body) are
  // available. Lets users share a comment by copying the link
  // and have the recipient land on the same paragraph. Fires
  // once per (doc, comment-id) so a normal interaction doesn't
  // re-trigger.
  const handledDeepLinkRef = useRef<string | null>(null)
  useEffect(() => {
    const commentId = searchParams.get('comment')
    if (!commentId) return
    if (!comments || comments.length === 0) return
    const key = `${meta?.id ?? ''}::${commentId}`
    if (handledDeepLinkRef.current === key) return
    const target = comments.find((c) => c.id === commentId)
    if (!target) return
    handledDeepLinkRef.current = key
    setCommentsOpen(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        handleScrollToComment(target)
        // Set the focus flash AFTER the doc scroll has started.
        // Doing it before makes the rail's focusedRow scrollIntoView
        // race with the doc scroll — and on shorter rails the rail
        // scroll is the only one the user sees ("the sidebar is
        // scrolling, not the viewer"). Order: doc first, then rail
        // flash.
        setFocusedCommentId(commentId)
      })
    })
    window.setTimeout(() => {
      setFocusedCommentId((cur) => (cur === commentId ? null : cur))
    }, 2500)
  }, [searchParams, comments, meta?.id, handleScrollToComment])
  const handleCopyCommentLink = useCallback(
    async (c: import('../lib/api').CommentDTO) => {
      const url = new URL(window.location.href)
      url.searchParams.set('comment', c.id)
      const prevTitle = document.title
      try {
        await navigator.clipboard.writeText(url.toString())
        document.title = '✓ Link copied'
        window.setTimeout(() => {
          if (document.title === '✓ Link copied') {
            document.title = prevTitle
          }
        }, 1200)
      } catch {
        /* clipboard denied — best-effort */
      }
    },
    [],
  )
  // Clear diff view whenever the doc changes.
  useEffect(() => {
    setDiffTs(null)
    setPreviewMessageId(null)
    setEditing(false)
    previewCacheRef.current.clear()
  }, [path])
  // PathViewer is no longer keyed on path (so the chat sidebar
  // inside stays mounted across file switches without flicker), so
  // we now have to explicitly drop the things `key` used to wipe:
  // pending selection-driven chat triggers, scroll position. The
  // text / meta / error reset happens in their own fetch effect.
  useEffect(() => {
    setPendingChatMessage(null)
    setPendingChatQuote(null)
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [path])
  // Chat-open is global: opening Reader AI on one doc keeps it
  // open as the user navigates to others. PathViewer remounts per
  // path (it's keyed on `path` in VaultView) so component-local
  // state would reset; localStorage survives the remount.
  const [chatOpen, setChatOpenState] = useState<boolean>(() => {
    try { return localStorage.getItem('reader:chatOpen') === '1' } catch { return false }
  })
  const setChatOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setChatOpenState((prev) => {
      const next = typeof v === 'function' ? (v as (p: boolean) => boolean)(prev) : v
      try { localStorage.setItem('reader:chatOpen', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])
  // Pending chat message coming from outside ChatDock (e.g. the
  // selection-popover "Explain with Reader AI" button). Consumed
  // by ChatDock via prop + useEffect, then cleared by the
  // onPendingConsumed callback.
  const [pendingChatMessage, setPendingChatMessage] = useState<string | null>(null)
  // Pending quote from the "Reply with Reader AI" button. Unlike
  // pendingChatMessage this is NOT auto-sent — it lands as a chip
  // above the composer so the user can type any follow-up against
  // the quoted selection.
  const [pendingChatQuote, setPendingChatQuote] = useState<string | null>(null)
  // Sticky copy of `meta` for ChatDock. The main fetch effect
  // resets `meta` to null between path changes (clears stale
  // toolbar state). ChatDock is rendered as `{chatOpen && meta &&
  // …}` so that null transition would unmount it for one frame
  // and flash the sidebar. Holding the previous meta until a new
  // one arrives keeps ChatDock continuously mounted across
  // navigation — it sees old → new without going through null.
  const [chatMeta, setChatMeta] = useState<DocumentMeta | null>(null)
  useEffect(() => {
    if (meta) setChatMeta(meta)
  }, [meta])

  useEffect(() => {
    const i = path.lastIndexOf('/')
    setCurrentFolder(i < 0 ? '' : path.slice(0, i))
  }, [path, setCurrentFolder])

  // Poll meta while ingestion is mid-flight. When the file flips to embedded,
  // bump the global refresh nonce so the sidebar updates its sparkle indicator
  // without a manual refresh.
  useEffect(() => {
    if (!meta) return
    if (meta.ingest.embedded) return
    // Any terminal status (incl. `ready` with embedded=false when
    // the embed backend was down at ingest time) means the
    // pipeline finished — polling further would spam the server
    // until the user clicks Re-index manually.
    const terminal =
      meta.ingest.status === 'ready' ||
      meta.ingest.status === 'failed' ||
      meta.ingest.status === 'no-text'
    if (terminal) return
    let cancelled = false
    const t = setInterval(async () => {
      try {
        const r = await api.fileMeta(path, callerOpts)
        if (cancelled || !r.meta) return
        const wasEmbedded = meta.ingest.embedded
        setMeta(r.meta)
        if (r.meta.ingest.embedded && !wasEmbedded) {
          clearInterval(t)
          refresh()
        } else if (
          r.meta.ingest.status === 'failed' ||
          r.meta.ingest.status === 'no-text'
        ) {
          clearInterval(t)
        }
      } catch {
        /* swallow — try again next tick */
      }
    }, 2500)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [path, meta?.ingest.status, meta?.ingest.embedded, refresh])

  useEffect(() => {
    const fname = path.split('/').pop() || path
    const prevTitle = document.title
    document.title = `${fname} — Reader`
    const restoreFavicon = setFaviconForFile(fname)
    return () => {
      document.title = prevTitle
      restoreFavicon()
    }
  }, [path])

  const ext = useMemo(() => {
    const i = path.lastIndexOf('.')
    return i >= 0 ? path.slice(i).toLowerCase() : ''
  }, [path])

  const isMarkdown = ['.md', '.markdown', '.mdx'].includes(ext)
  const isCsv = ext === '.csv'
  const isJson = ext === '.json'
  const isText = ['.txt', '.yaml', '.yml', '.toml'].includes(ext)
  const isHtml = ['.html', '.htm'].includes(ext)
  const isPdf = ext === '.pdf'
  const isImage = [
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
  ].includes(ext)
  const isVideo = [
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
    '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
    '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
  ].includes(ext)
  const isAudio = [
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma',
  ].includes(ext)
  // Server has to transcode these to JPEG — browsers won't render them
  // natively. /api/file/preview returns the JPEG for HEIC/TIFF/JXL, the raw
  // bytes for everything else (so it's safe to use for any image).
  const needsPreview = ['.heic', '.heif', '.tiff', '.tif', '.jxl'].includes(ext)
  const isOfficeDoc = ['.docx', '.xlsx', '.xls'].includes(ext)
  const wantsExtractedText = isOfficeDoc

  useEffect(() => {
    setText(null)
    setMeta(null)
    setError(null)
    api.fileMeta(path, callerOpts).then((r) => setMeta(r.meta)).catch(() => null)
    if (isMarkdown || isText || isCsv || isJson || isHtml || wantsExtractedText) {
      api
        .fileText(path, callerOpts)
        .then((r) => setText(r.content))
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404 && wantsExtractedText) {
            // Office doc not indexed yet — leave text null, show CTA below.
            setText(null)
          } else {
            setError(e instanceof ApiError ? e.message : String(e))
          }
        })
    }
  }, [path, isMarkdown, isText, isCsv, isJson, isHtml, wantsExtractedText, callerOpts?.owner])

  // Path-scoped SSE refetch: when an MCP tool, chat apply-op, or an external
  // editor changes *this* file we want the viewer to update without the user
  // having to re-navigate. We watch for edit/ingest/visibility/tags/archive
  // events whose path matches the one we're rendering.
  const wantsBody = isMarkdown || isText || isCsv || isJson || isHtml || wantsExtractedText
  // Phase 3 CRDT body overlay: open a Y.Doc for markdown files
  // owned by the viewer. The hook handles the y-websocket
  // lifecycle + IndexedDB persistence; when the live text differs
  // from the fetched copy we render the CRDT version so changes
  // from other devices / agents land without a refetch.
  // Enable only for markdown docs the viewer owns. Cross-owner
  // / public viewers stay on the existing HTTP fetch path until
  // the server route grows non-owner ACL support.
  // CRDT WS now accepts share-grant editors too (server route's
  // ACL has the collection / share fallback), so allow shared
  // editors with `canEdit` into the live-collab path. Read-only
  // shared viewers still fall through to the plain fetch render.
  const crdtEnabled = isMarkdown && (!ownerOpt || canEdit) && !!meta
  const crdt = useCrdtBody(meta?.id ?? null, crdtEnabled)

  // ⌘E / Ctrl+E — toggle edit ↔ preview. Mounted on window so
  // the shortcut works whether focus is in the CodeMirror editor
  // or the preview. Default keymap doesn't bind Cmd-E, so
  // there's no command we're stealing.
  useEffect(() => {
    if (!isMarkdown || !crdt) return
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey || e.altKey) return
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'e' && e.key !== 'E') return
      e.preventDefault()
      toggleEditing()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // toggleEditing intentionally not in deps — it captures the
    // latest `editing` via closure on each render; including it
    // here would re-bind the listener every render needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMarkdown, crdt])
  // Prefer CRDT text once it's available AND synced — otherwise
  // a brand-new hook hasn't pulled the IDB cache yet and would
  // briefly overwrite our fetched text with the empty string.
  const displayText = (() => {
    if (!crdt) return text
    if (!crdt.synced && crdt.text === '') return text
    if (!crdt.text) return text
    return crdt.text
  })()
  // Split off any leading YAML frontmatter — `---` … `---` at the
  // top of a markdown file is metadata for the template engine /
  // scheduler, not body content. Without this it renders as a
  // literal bullet list under a horizontal rule. We hold onto the
  // raw YAML so the info chip above the body can show a compact
  // summary + expand-to-view. The edit surface (CodeMirror) still
  // sees the raw text so the author can edit the metadata.
  const { frontmatter, renderedText } = (() => {
    if (!displayText) return { frontmatter: null as string | null, renderedText: displayText }
    const { yaml, body } = splitFrontmatter(displayText)
    return { frontmatter: yaml, renderedText: body }
  })()
  // Validate the YAML server-side whenever the frontmatter block
  // changes. We send the CURRENT in-memory YAML (not the path) so
  // a live edit in CodeMirror updates the chip immediately, not
  // ~2s later after the materialiser writes + we refetch the disk
  // copy. Uses the same strict parser as the scheduler so the
  // error message here matches what the scheduler would log.
  useEffect(() => {
    if (!frontmatter) {
      setFrontmatterError(null)
      return
    }
    let cancelled = false
    api
      .validateFrontmatter(frontmatter)
      .then((r) => {
        if (cancelled) return
        setFrontmatterError(r.ok ? null : r.error)
      })
      .catch(() => {
        if (!cancelled) setFrontmatterError(null)
      })
    return () => {
      cancelled = true
    }
  }, [frontmatter])
  const refetchForEvent = useCallback(
    (e: { type: string; path?: string; status?: string; docId?: string }) => {
      // Comment events arrive whenever any user creates / deletes /
      // resolves a comment on this doc. Refetch the list inline so
      // a second tab sees the new thread without F5. We match on
      // docId (carried in the event) rather than path because
      // comments are doc-scoped and survive a rename.
      if (e.type === 'comment' && meta?.id && e.docId === meta.id) {
        api
          .listComments(meta.id)
          .then((r) => setComments(r.comments))
          .catch(() => null)
        return
      }
      // Exact-path match for most events. Lock events also fire on
      // FOLDER paths, and locking an ancestor changes this file's
      // EFFECTIVE lock state (server ORs ancestor-folder lock into
      // meta.locked). So a folder lock event upstream of `path`
      // needs to trigger a meta refetch here too — otherwise the
      // editor keeps the pencil enabled and CRDT autosave silently
      // drops the user's keystrokes.
      const isExact = e.path === path
      const isAncestorLock =
        e.type === 'lock' &&
        !!e.path &&
        (e.path === '' || path.startsWith(e.path.replace(/\/+$/, '') + '/'))
      if (!isExact && !isAncestorLock) return
      api.fileMeta(path, callerOpts).then((r) => setMeta(r.meta)).catch(() => null)
      if (e.type === 'edit' || e.type === 'restore') {
        setVersionsReloadKey((k) => k + 1)
      }
      if (!wantsBody) return
      const shouldRefetch =
        e.type === 'edit' ||
        e.type === 'restore' ||
        (e.type === 'ingest' && e.status === 'ready')
      if (!shouldRefetch) return
      api
        .fileText(path, callerOpts)
        .then((r) => setText(r.content))
        .catch(() => null)
    },
    [path, callerOpts?.owner, wantsBody, meta?.id],
  )
  useReaderEvents(refetchForEvent)

  const filename = path.split('/').pop() || path
  const parentDir = useMemo(() => {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i)
  }, [path])

  const goToFolder = (dir: string) => {
    // Push the actual folder path to the URL so back / breadcrumb clicks
    // land at the right folder. Preserve `?owner=` so a recipient
    // browsing a shared subtree doesn't fall back into their own vault
    // when they hit the parent crumb.
    setCurrentFolder(dir)
    const segs = dir.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const suffix = ownerOpt ? `?owner=${encodeURIComponent(ownerOpt)}` : ''
    navigate(`${segs ? `/${segs}` : '/'}${suffix}`)
  }

  const indexNow = async () => {
    setIndexing(true)
    try {
      await api.indexFile(path)
      const r = await api.fileText(path, callerOpts).catch(() => null)
      if (r) setText(r.content)
      const m = await api.fileMeta(path, callerOpts).catch(() => null)
      if (m) setMeta(m.meta)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setIndexing(false)
    }
  }

  // Source-line index of every ATX heading in the doc, derived
  // from the raw markdown body. Paired with DOM-extracted slugs
  // (below) to power the edit ↔ preview scroll sync — given a
  // CodeMirror line, find the heading at-or-before it, jump to
  // that slug in the preview (and vice versa).
  const sourceHeadingLines = useMemo(() => {
    if (!text) return [] as number[]
    const out: number[] = []
    const lines = text.split('\n')
    let inFence = false
    let fenceMarker: string | null = null
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const fenceMatch = ln.match(/^\s*(```+|~~~+)/)
      if (fenceMatch) {
        if (!inFence) {
          inFence = true
          fenceMarker = fenceMatch[1][0]
        } else if (fenceMatch[1][0] === fenceMarker) {
          inFence = false
          fenceMarker = null
        }
        continue
      }
      if (inFence) continue
      if (/^#{1,6}\s+\S/.test(ln)) out.push(i + 1)
    }
    return out
  }, [text])

  // Outline is built from the actual rendered DOM after react-markdown +
  // rehype-slug run, so the slug we click matches the heading's real id even
  // for tricky titles (parentheses, slashes, percent signs, etc.).
  const [headings, setHeadings] = useState<Array<{ level: number; text: string; slug: string }>>([])
  useEffect(() => {
    if (!isMarkdown || text == null) {
      setHeadings([])
      return
    }
    let rafId = 0
    const extract = () => {
      const root = contentRef.current
      if (!root) return
      const nodes = root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')
      const out: Array<{ level: number; text: string; slug: string }> = []
      nodes.forEach((n) => {
        const level = Number(n.tagName.slice(1))
        // rehypeAutolinkHeadings appends `<a class="anchor">#</a>` to every
        // heading; clone + strip so the outline label shows just the title.
        const clone = n.cloneNode(true) as HTMLElement
        clone.querySelectorAll('.anchor').forEach((a) => a.remove())
        out.push({ level, text: (clone.textContent ?? '').trim(), slug: n.id })
      })
      // Only update on actual change so toggling something unrelated
      // doesn't fan out a re-render across the rail.
      setHeadings((prev) => {
        if (prev.length === out.length) {
          let same = true
          for (let i = 0; i < prev.length; i++) {
            if (prev[i].slug !== out[i].slug || prev[i].text !== out[i].text) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return out
      })
    }
    // Defer the initial extraction so ReactMarkdown / VersionDiffView
    // has committed the heading nodes.
    rafId = requestAnimationFrame(extract)
    // Re-extract whenever the rendered DOM gains/loses heading
    // elements — happens when the user opens a version snapshot,
    // toggles Snapshot ↔ Diff inside the version view, or navigates
    // between versions. Heading-aware filter keeps this cheap during
    // editor typing (which mutates DOM constantly but doesn't add or
    // remove headings).
    const root = contentRef.current
    let mo: MutationObserver | null = null
    if (root) {
      mo = new MutationObserver((mutations) => {
        const headingChange = mutations.some((m) => {
          for (const node of m.addedNodes) {
            if (!(node instanceof Element)) continue
            if (/^H[1-4]$/i.test(node.tagName)) return true
            if (node.querySelector?.('h1, h2, h3, h4')) return true
          }
          for (const node of m.removedNodes) {
            if (!(node instanceof Element)) continue
            if (/^H[1-4]$/i.test(node.tagName)) return true
            if (node.querySelector?.('h1, h2, h3, h4')) return true
          }
          return false
        })
        if (!headingChange) return
        cancelAnimationFrame(rafId)
        rafId = requestAnimationFrame(extract)
      })
      mo.observe(root, { childList: true, subtree: true })
    }
    return () => {
      cancelAnimationFrame(rafId)
      mo?.disconnect()
    }
  }, [isMarkdown, text])

  // DocRail is shown for any markdown doc so the version-history
  // section is reachable even when the outline list itself is
  // empty / single-heading. The OUTLINE section inside renders
  // conditionally on headings.length > 1; the VERSIONS section
  // hides itself when no snapshots exist.
  const showOutline = isMarkdown
  const hasOutlineList = isMarkdown && headings.length > 1
  const contentRef = useRef<HTMLDivElement>(null)
  /** Show the floating "back to top" button only after the user has
   *  scrolled past ~400px. Same threshold the Timeline uses so the
   *  affordance feels consistent across long-scroll surfaces. */
  const [showScrollTop, setShowScrollTop] = useState(false)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onScroll = () => setShowScrollTop(el.scrollTop > 400)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // Re-bind when the content body or path swaps — the ref points
    // at a new element across route changes inside the same viewer.
  }, [text, path])

  const jumpTo = (slug: string) => {
    const root = contentRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(slug)}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Slug ↔ source-line pairs (zipped from DOM headings and
  // source-line regex scan — both produce headings in document
  // order so the zip is by index). Used by the scroll-sync
  // logic to translate between the rendered preview's heading
  // position and CodeMirror's source line.
  const headingsWithLine = useMemo(() => {
    const n = Math.min(headings.length, sourceHeadingLines.length)
    const out: Array<{ slug: string; line: number }> = []
    for (let i = 0; i < n; i++) {
      out.push({ slug: headings[i].slug, line: sourceHeadingLines[i] })
    }
    return out
  }, [headings, sourceHeadingLines])

  // Capture the current scroll anchor (top viewport line in
  // CodeMirror OR the topmost-passed heading in the rendered
  // preview), then flip mode. The next mounted surface reads
  // `scrollAnchorLineRef` to align its viewport.
  const toggleEditing = useCallback(() => {
    if (editing) {
      // Edit → Preview: anchor to the cursor's line, not the top
      // visible line. With the editor's scroll-margins keeping the
      // cursor in the middle of the viewport, the top visible line
      // can sit several sections behind where the user actually is.
      // Cursor position is the most reliable "where I am" signal.
      // Fall back to the top visible line if there's no selection
      // (rare — CM always has a default cursor at 0).
      const view = crdtViewRef.current
      if (view) {
        try {
          const sel = view.state.selection.main
          const pos = sel.head
          scrollAnchorLineRef.current = view.state.doc.lineAt(pos).number
        } catch {
          scrollAnchorLineRef.current = null
        }
        // Stash the top-of-viewport line for a clean round-trip
        // back to Edit (when the viewer doesn't get scrolled).
        try {
          const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from
          editorTopLineRef.current = view.state.doc.lineAt(topPos).number
        } catch {
          editorTopLineRef.current = null
        }
      }
    } else {
      // Preview → Edit. Two cases:
      //   1. Viewer hasn't been scrolled since landing → snap back
      //      to the saved cursor line. Smooth round-trip — the user
      //      flipped to viewer briefly and is back where they were.
      //   2. Viewer has been scrolled → follow the user's reading
      //      to wherever they ended up, by anchoring on the topmost
      //      heading currently passed in the viewport.
      const root = contentRef.current
      const landing = viewerLandingScrollRef.current
      const currentScroll = root?.scrollTop ?? 0
      // 4px tolerance covers sub-pixel rounding from scrollIntoView.
      const userScrolled =
        landing != null && Math.abs(currentScroll - landing) > 4
      const remembered = editorSelectionRef.current
      if (!userScrolled && editorTopLineRef.current != null) {
        // Round-trip back — anchor on the exact line that was at
        // the top of the editor viewport before leaving. CrdtEditor
        // dispatches scrollIntoView for this line at 'start', so
        // the editor visually lines up with what we left.
        scrollAnchorLineRef.current = editorTopLineRef.current
      } else if (root) {
        // User scrolled in viewer — find the topmost element with a
        // `data-source-line` attribute (stamped by rehypeSourceLine
        // on every block) that's still at or above the viewport top.
        // This gives line-precision rather than just heading-section.
        const rootRect = root.getBoundingClientRect()
        const nodes = root.querySelectorAll<HTMLElement>('[data-source-line]')
        let anchorLine: number | null = null
        let firstBelow: number | null = null
        for (const n of Array.from(nodes)) {
          const rel = n.getBoundingClientRect().top - rootRect.top
          const ln = Number(n.getAttribute('data-source-line'))
          if (!Number.isFinite(ln)) continue
          if (rel <= 8) {
            anchorLine = ln
          } else {
            if (firstBelow == null) firstBelow = ln
            break
          }
        }
        if (anchorLine == null) anchorLine = firstBelow
        scrollAnchorLineRef.current = anchorLine
      } else if (remembered && text) {
        const off = Math.max(0, Math.min(remembered.head, text.length))
        const before = text.slice(0, off)
        scrollAnchorLineRef.current = before.split('\n').length
      }
    }
    setEditing((v) => !v)
  }, [editing, headingsWithLine, text])

  // After flipping back to preview, scroll the rendered markdown
  // so the closest heading to the saved source-line sits at the
  // viewport top. Deferred to rAF so headings have re-extracted
  // from the new DOM.
  useEffect(() => {
    if (editing) {
      // Switched to editor — invalidate the viewer landing baseline
      // so the next round-trip starts fresh.
      viewerLandingScrollRef.current = null
      return
    }
    const target = scrollAnchorLineRef.current
    if (!target) return
    if (headingsWithLine.length === 0) return
    const id = requestAnimationFrame(() => {
      const root = contentRef.current
      if (!root) return
      let pick: { slug: string; line: number } | null = null
      for (const h of headingsWithLine) {
        if (h.line <= target) pick = h
        else break
      }
      if (!pick) pick = headingsWithLine[0]
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(pick.slug)}`)
      if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
      // Stash where the viewer landed. The next Preview → Edit
      // toggle compares against this to know whether the user
      // scrolled inside the viewer.
      viewerLandingScrollRef.current = root.scrollTop
    })
    return () => cancelAnimationFrame(id)
  }, [editing, headingsWithLine])

  const needsReindex = !!meta && !meta.ingest.embedded
  const reindexLabel = meta?.ingest.status === 'ready' ? 'Re-index' : 'Index'

  return (
    <div className="h-full flex flex-col">
      {/* No `overflow-x-auto` here even though buttons can wrap on
          narrow viewports. CSS spec: when one overflow axis is
          non-visible, the other clips too — and that silently chopped
          the Share / Private / Tags popovers off below the header.
          `flex-wrap` already handles narrow layouts by wrapping to a
          new row, so horizontal scroll is not needed. */}
      <header className="min-h-11 px-3 py-1.5 flex items-center gap-2 border-b border-app shrink-0 flex-wrap" style={{ background: 'var(--surface-2)' }}>
        <PathBreadcrumb
          dir={parentDir}
          currentName={filename}
          currentAction={
            <button
              className="btn-ghost h-6 w-6 px-0 shrink-0"
              onClick={() => setPanelOpen(true)}
              title="Details"
              aria-label="Open details panel"
            >
              <Info size={13} />
            </button>
          }
          onNavigate={goToFolder}
          onBack={() => goToFolder(parentDir)}
          ownerLabel={ownerOpt}
        />
        <div className="flex-1" />
        {/* Default rendering: visibility starts as "Private" (the safe
            default — most files are private) and flips to "Public" only
            after meta confirms. Tags/Sparkles render with empty/false state
            until meta arrives. */}
        {meta?.ingest.embedded && (
          <Sparkles size={13} className="text-accent shrink-0 mx-1" aria-label="indexed for AI search" />
        )}
        {/* Access affordances. The owner sees every owner-control
            (Tags / Activity / Versions / Share / Public). A
            share-recipient with edit grant additionally sees Tags +
            Activity (mutating the owner's metadata is what "edit"
            actually means in this app). Read-only recipients see
            only navigation + Download. */}
        {ownerOpt && (
          <span
            className="text-[10.5px] font-medium px-1.5 h-5 rounded inline-flex items-center"
            style={{
              background: canEdit ? 'var(--selected)' : 'var(--bg)',
              color: canEdit ? 'var(--accent)' : 'var(--fg-subtle)',
              border: '1px solid var(--border)',
            }}
            title={canEdit ? 'You have edit access via share' : 'You have read-only access via share'}
          >
            {canEdit ? 'shared · edit' : 'shared · read-only'}
          </span>
        )}
        {!ownerOpt && needsReindex && (
          <button
            className="btn-ghost"
            disabled={indexing}
            onClick={indexNow}
            title={`${reindexLabel} — run extraction + embedding so this file is searchable`}
            aria-label={reindexLabel}
          >
            {indexing ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {/* Label stays visible only while indexing so the user
                gets progress feedback; idle state is icon-only to
                keep the toolbar compact. */}
            {indexing && <span>Indexing…</span>}
          </button>
        )}
        {(!ownerOpt || canEdit) && (
          <>
            <TagsButton
              path={path}
              tags={meta?.tags ?? []}
              owner={ownerOpt}
              onSaved={(next) => meta && setMeta({ ...meta, tags: next })}
            />
            {meta && <CollectionsToolbarButton docId={meta.id} path={meta.storageKey} />}
            {meta && <FindSimilarButton docId={meta.id} path={meta.storageKey} ownerHint={ownerOpt} />}
            <ActivityButton path={path} owner={ownerOpt} />
          </>
        )}
        {!ownerOpt && (
          <>
            {meta && <ShareWithUserButton paths={[path]} />}
            {meta ? (
              <PublicButton
                path={path}
                meta={meta}
                onSaved={(next) =>
                  setMeta((cur) =>
                    cur
                      ? {
                          ...cur,
                          public: next.public,
                          publicExpiresAt: next.publicExpiresAt ?? null,
                          publicPasswordHash: next.publicPasswordHash ?? null,
                        }
                      : cur,
                  )
                }
              />
            ) : (
              <button className="btn-ghost" disabled title="Private" aria-label="Private">
                <Shield size={13} />
              </button>
            )}
          </>
        )}
        <PinButton path={path} owner={ownerOpt} isFolder={false} onChanged={refresh} />
        {/* Lock toggle — owner-only (the route enforces it too;
            hiding here avoids a footgun for share-recipients). */}
        {!ownerOpt && meta && (
          <LockButton
            path={path}
            locked={!!meta.locked}
            onChanged={() => refresh()}
          />
        )}
        {!ownerOpt && meta && (
          <ArchiveButton
            path={path}
            meta={meta}
            onSaved={(next) =>
              setMeta((cur) =>
                cur ? { ...cur, archived: next.archived, archivedAt: next.archivedAt ?? null } : cur,
              )
            }
          />
        )}
        {!ownerOpt && meta && <DuplicateButton path={path} owner={ownerOpt} />}
        {!ownerOpt && isMarkdown && meta && (
          <SaveAsTemplateButton
            path={path}
            defaultTitle={meta.title || filename.replace(/\.[^.]+$/, '')}
          />
        )}
        {!ownerOpt && meta?.templateSource && (
          <RefreshTemplateButton
            meta={meta}
            onRefreshed={(next) => setMeta(next)}
          />
        )}
        {/* Live-collab edit toggle. Markdown + (owner OR shared
            recipient with `canEdit`). PDFs / images / csv don't
            have a sensible editor. Disabled (not hidden) when the
            doc is locked — keeps the layout stable + tells the
            user why they can't edit on hover. */}
        {(!ownerOpt || canEdit) && isMarkdown && meta && crdt && (
          <button
            className={
              meta.locked
                ? 'h-7 px-2 inline-flex items-center justify-center rounded text-[12.5px] font-medium cursor-not-allowed'
                : 'btn-ghost'
            }
            onClick={() => !meta.locked && toggleEditing()}
            disabled={!!meta.locked}
            title={
              meta.locked
                ? meta.lockedBy
                  ? `Locked by ${meta.lockedBy} — unlock to edit`
                  : 'Locked — unlock to edit'
                : editing
                  ? 'Preview'
                  : 'Edit document'
            }
            aria-label={editing ? 'Switch to preview' : 'Switch to edit'}
            aria-keyshortcuts={editShortcutHint.replace('⌘', 'Meta+')}
            style={
              meta.locked
                ? { color: 'var(--danger-fg)', background: 'transparent' }
                : editing
                  ? { color: 'var(--accent)', background: 'var(--selected)' }
                  : undefined
            }
          >
            {editing ? <Check size={13} /> : <Pencil size={13} />}
          </button>
        )}
        {/* Copy the file's actual content to the system clipboard:
            text for markdown/csv/json/txt/html and any file we've
            extracted text for; PNG/JPEG/GIF/WebP go on as image
            blobs (via ClipboardItem) so they paste into chat /
            docs / image editors. Other binary types (PDF, audio,
            video, zips) can't be put on the clipboard meaningfully
            — the button is disabled with a tooltip in that case. */}
        {(() => {
          const isCopyableImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
          const hasCopyableText =
            isMarkdown || isText || isCsv || isJson || isHtml || wantsExtractedText
          const canCopy = isCopyableImage || (hasCopyableText && text != null)
          const titleMsg = canCopy
            ? isCopyableImage
              ? 'Copy image to clipboard'
              : 'Copy file contents to clipboard'
            : copySupportHint(ext)
          return (
            <button
              className="btn-ghost"
              disabled={copyBusy || !canCopy}
              onClick={async () => {
                if (copyBusy || !canCopy) return
                setCopyBusy(true)
                try {
                  if (isCopyableImage) {
                    // Fetch the raw bytes and write the matching MIME
                    // through ClipboardItem. Chrome/Safari accept
                    // PNG/JPEG/WebP/GIF; Firefox is PNG-only and will
                    // throw — we catch + surface the error rather than
                    // silently fall back, so the user knows nothing
                    // landed on the clipboard.
                    const res = await fetch(api.rawUrl(path, callerOpts), { credentials: 'include' })
                    if (!res.ok) throw new Error(`HTTP ${res.status}`)
                    const blob = await res.blob()
                    await navigator.clipboard.write([
                      new ClipboardItem({ [blob.type || 'image/png']: blob }),
                    ])
                  } else if (text != null) {
                    // copyText handles the modern API + a legacy
                    // execCommand fallback for http:// or
                    // Permissions-Policy-locked contexts.
                    const ok = await copyText(text)
                    if (!ok) throw new Error('clipboard write blocked by the browser')
                  }
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setCopyBusy(false)
                }
              }}
              title={titleMsg}
            >
              {copyBusy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : copied ? (
                <Check size={13} className="text-accent" />
              ) : (
                <CopyIcon size={13} />
              )}
            </button>
          )
        })()}
        <a
          className="btn-ghost"
          href={api.rawUrl(path, callerOpts)}
          download={filename}
          title="Download"
          aria-label="Download"
        >
          <Download size={14} />
        </a>
        {/* Move to Trash (30-day retention; user can restore). Hidden
            for share-recipients — they can't delete in the owner's
            vault. */}
        {!ownerOpt && (
          <button
            className="btn-ghost"
            onClick={async () => {
              if (deleteBusy) return
              const ok = await confirm({
                title: 'Move to Trash',
                message: `"${filename}" goes to Trash where it can still be restored. Purges automatically after 30 days.`,
                confirmLabel: 'Move to Trash',
                destructive: true,
              })
              if (!ok) return
              setDeleteBusy(true)
              try {
                await api.deleteFile(path)
                refresh()
                navigate(parentDir ? `/${parentDir.split('/').map(encodeURIComponent).join('/')}` : '/')
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e))
              } finally {
                setDeleteBusy(false)
              }
            }}
            disabled={deleteBusy}
            style={{ color: '#BF2600' }}
            title="Move to Trash"
          >
            {deleteBusy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
          </button>
        )}
        <button className="btn-ghost" onClick={() => navigate('/')} title="Close">
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-hidden flex">
       <div className="flex-1 relative min-w-0">
        <div ref={contentRef} className="h-full overflow-y-auto" style={{ background: 'var(--surface-3)' }}>
        {error && (
          <div className="px-10 py-10 text-muted">
            <div className="flex items-center gap-2 text-fg font-semibold mb-1">
              <AlertCircle size={16} style={{ color: '#BF2600' }} /> Couldn't open this file
            </div>
            <div className="text-[13px]">{prettyError(error)}</div>
          </div>
        )}

        {!error && isPdf && (
          <iframe
            src={api.rawUrl(path, callerOpts)}
            title={filename}
            className="w-full h-full border-0"
            style={{ background: 'var(--surface-3)' }}
          />
        )}

        {!error && isImage && (
          <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--surface-3)' }}>
            <img
              src={needsPreview ? api.previewUrl(path, callerOpts) : api.rawUrl(path, callerOpts)}
              alt={filename}
              className="max-w-full max-h-full rounded shadow-card"
            />
          </div>
        )}

        {!error && isVideo && (
          <MediaPlayer
            kind="video"
            src={api.rawUrl(path, callerOpts)}
            hlsSrc={meta?.hlsReady ? api.hlsUrl(path, callerOpts) : undefined}
            poster={api.previewUrl(path, callerOpts)}
            filename={filename}
          />
        )}

        {!error && isAudio && (
          <MediaPlayer
            kind="audio"
            src={api.rawUrl(path, callerOpts)}
            filename={filename}
          />
        )}

        {!error && isMarkdown && text != null && previewMessageId === null && diffTs !== null && (
          <VersionDiffView
            path={path}
            ts={diffTs}
            currentText={text}
            parentDir={parentDir}
            callerOpts={callerOpts}
            onExit={() => setDiffTs(null)}
            // Restore button always rendered for authed users; the
            // server enforces userCanEdit and returns 403 on a
            // read-only share, which surfaces as the inline error.
            onRestored={async () => {
              try {
                const [r, m] = await Promise.all([
                  api.fileText(path, callerOpts).catch(() => null),
                  api.fileMeta(path, callerOpts).catch(() => null),
                ])
                if (r) setText(r.content)
                if (m) setMeta(m.meta)
                // The restore wrote a fresh pre-restore snapshot;
                // bump the version list so it shows up.
                setVersionsReloadKey((k) => k + 1)
              } catch {
                /* swallow */
              }
            }}
          />
        )}

        {!error && isMarkdown && text != null && previewMessageId !== null && meta && (
          <ProposedEditPreview
            docId={meta.id}
            messageId={previewMessageId}
            parentDir={parentDir}
            callerOpts={callerOpts}
            seedData={previewCacheRef.current.get(previewMessageId) ?? null}
            onLoaded={(data) => {
              previewCacheRef.current.set(previewMessageId, data)
              setPreviewCacheTick((t) => t + 1)
            }}
            onOpMutated={() => {
              // A per-op apply or discard succeeded — the cached
              // preview for this message is stale (its op list
              // shrunk), and the chat card needs to refresh so
              // the stack of <ProposedEditCard>s reflects the
              // server's new pendingEdit.
              previewCacheRef.current.delete(previewMessageId)
              setChatHistoryReloadKey((k) => k + 1)
            }}
            onDocChanged={async () => {
              // The underlying doc just changed (an op was
              // applied). Refetch text + meta so the rest of
              // the doc state stays in sync.
              const [r, m] = await Promise.all([
                api.fileText(path, callerOpts).catch(() => null),
                api.fileMeta(path, callerOpts).catch(() => null),
              ])
              if (r) setText(r.content)
              if (m) setMeta(m.meta)
            }}
            onExit={() => setPreviewMessageId(null)}
            onAllResolved={() => setPreviewMessageId(null)}
          />
        )}

        {!error && isMarkdown && text != null && diffTs === null && previewMessageId === null && editing && crdt && (
          <div className="h-full">
            <CrdtEditor
              crdt={crdt}
              userLabel={currentUsername ?? meta?.owner ?? null}
              onExit={() => toggleEditing()}
              initialSelection={editorSelectionRef.current}
              onSelectionChange={(sel) => {
                editorSelectionRef.current = sel
              }}
              initialScrollLine={scrollAnchorLineRef.current}
              viewRef={crdtViewRef}
              onMediaPaste={(file) => setPastedMediaFile(file)}
            />
          </div>
        )}
        {pastedMediaFile && (
          <PasteMediaDialog
            file={pastedMediaFile}
            docPath={path}
            onCancel={() => setPastedMediaFile(null)}
            onUploaded={({ markdown }) => {
              const view = crdtViewRef.current
              if (view) {
                const pos = view.state.selection.main.head
                view.dispatch({
                  changes: { from: pos, to: pos, insert: markdown },
                  selection: { anchor: pos + markdown.length },
                })
                view.focus()
              }
              setPastedMediaFile(null)
            }}
          />
        )}
        {!error && isMarkdown && text != null && diffTs === null && previewMessageId === null && !editing && (
          <div ref={viewerBodyRef} className="px-10 py-10 relative">
            {frontmatter && (
              <div className="mb-6">
                <button
                  type="button"
                  onClick={() => setFrontmatterOpen((v) => !v)}
                  className="w-full rounded-md px-3 py-2 flex items-center gap-2 text-left transition-colors hover:bg-[var(--hover)]"
                  style={{
                    background: frontmatterError ? 'var(--danger-bg)' : 'var(--viewer)',
                    border: `1px solid ${
                      frontmatterError
                        ? 'color-mix(in srgb, var(--danger-fg) 35%, transparent)'
                        : 'var(--border)'
                    }`,
                  }}
                  title={frontmatterOpen ? 'Hide frontmatter' : 'Show frontmatter'}
                >
                  {frontmatterError ? (
                    <AlertCircle
                      size={12}
                      className="shrink-0"
                      style={{ color: 'var(--danger-fg)' }}
                    />
                  ) : (
                    <Braces size={12} className="text-subtle shrink-0" />
                  )}
                  <span
                    className="text-[12.5px] font-semibold"
                    style={{
                      color: frontmatterError ? 'var(--danger-fg)' : 'var(--fg)',
                    }}
                  >
                    Frontmatter
                  </span>
                  <span className="opacity-60 text-subtle">·</span>
                  <span
                    className="text-[12px] flex-1 truncate"
                    style={{
                      color: frontmatterError ? 'var(--danger-fg)' : 'var(--fg-subtle)',
                    }}
                  >
                    {frontmatterError
                      ? `invalid YAML — ${frontmatterError}`
                      : summariseFrontmatter(frontmatter)}
                  </span>
                  <span
                    className="text-[11.5px] shrink-0"
                    style={{
                      color: frontmatterError ? 'var(--danger-fg)' : 'var(--fg-subtle)',
                    }}
                  >
                    {frontmatterOpen ? 'Hide' : 'Show'}
                  </span>
                </button>
                {frontmatterOpen && (
                  <pre
                    className="mt-2 rounded-md px-3 py-2 text-[12px] whitespace-pre-wrap break-words"
                    style={{
                      background: 'var(--viewer)',
                      border: '1px solid var(--border)',
                      color: 'var(--fg-subtle)',
                    }}
                  >
                    {frontmatter}
                  </pre>
                )}
              </div>
            )}
            <article className="md">
              <ReactMarkdown
                // `remark-breaks` converts a single newline into a
                // hard `<br>`, matching how the editor renders the
                // source. Without it CommonMark collapses
                //   line A
                //   line B
                // into one paragraph (joined by a space), which is
                // why `{{/if}}` was appearing inline next to the
                // bullet above instead of on its own visual row.
                remarkPlugins={[remarkGfm, remarkBreaks]}
                rehypePlugins={[
                  // Stamp source-line attrs BEFORE downstream plugins
                  // rewrite the tree (slugs, anchor links, highlight
                  // spans) so the lines stay attached to the original
                  // remark output.
                  rehypeSourceLine,
                  rehypeSlug,
                  [rehypeAutolinkHeadings, { behavior: 'append', properties: { className: ['anchor'], 'aria-hidden': 'true', tabIndex: -1 }, content: { type: 'text', value: '#' } }],
                  rehypeHighlight,
                  // Style `{{#if …}}` / `{{/if}}` / `{{var}}`
                  // template-engine tokens in the rendered
                  // preview — purple for control flow, accent
                  // for variables.
                  rehypeTemplateSyntax,
                  // After tokens are styled, pair balanced
                  // openers/closers and wrap the content between
                  // them in an indented block so the template
                  // structure reads at a glance.
                  rehypeTemplateIndent,
                ]}
                // Custom renderers that resolve relative URLs against
                // the doc's folder. Without these, `![](./img.jpg)`
                // and `[link](./other.md)` produced broken paths that
                // resolved relative to the SPA URL.
                components={{
                  img: ({ src, alt, ...rest }) => {
                    const resolved = typeof src === 'string'
                      ? resolveImageSrc(parentDir, src, callerOpts)
                      : src
                    // Obsidian-style sizing: `![photo|400](url)`,
                    // `![photo|400x300](url)`, `![photo|50%](url)`.
                    // Apply via inline style so the user's choice
                    // overrides the .md article CSS without needing
                    // a separate stylesheet hook.
                    const { alt: cleanAlt, width, height } = parseImageSize(alt)
                    const sizeStyle: React.CSSProperties = {}
                    if (width) sizeStyle.width = width
                    if (height) sizeStyle.height = height
                    return (
                      <img
                        src={resolved as string}
                        alt={cleanAlt || alt}
                        style={Object.keys(sizeStyle).length ? sizeStyle : undefined}
                        {...rest}
                      />
                    )
                  },
                  a: ({ href, children, ...rest }) => {
                    if (typeof href !== 'string') return <a {...rest}>{children}</a>
                    const resolved = resolveLinkHref(parentDir, href, callerOpts)
                    // External / fragment links keep default behavior.
                    // Internal vault links navigate via the SPA — we
                    // can't return a <Link> because react-markdown
                    // would warn about ref forwarding; setting href
                    // works fine since the SPA's pushState router
                    // intercepts same-origin paths on click.
                    if (resolved.startsWith('/') && !resolved.startsWith('//')) {
                      return (
                        <a
                          href={resolved}
                          onClick={(e) => {
                            // Spare modifier-clicks so cmd-click opens
                            // a new tab as expected.
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                            e.preventDefault()
                            navigate(resolved)
                          }}
                          {...rest}
                        >
                          {children}
                        </a>
                      )
                    }
                    return (
                      <a href={resolved} {...rest}>
                        {children}
                      </a>
                    )
                  },
                }}
              >
                {renderedText}
              </ReactMarkdown>
            </article>
            <CommentHighlights
              bodyRef={viewerBodyRef}
              comments={comments}
              recomputeKey={(text?.length ?? 0) + (comments?.length ?? 0)}
              onClickComment={handleHighlightClick}
            />
          </div>
        )}

        {!error && isHtml && text != null && (
          <pre className="px-10 py-8 text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
        )}

        {!error && isText && text != null && (
          <pre className="px-10 py-8 text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
        )}

        {!error && isCsv && text != null && (
          <div className="px-10 py-8">
            <CsvTable text={text} />
          </div>
        )}

        {!error && isJson && text != null && (
          <div className="px-10 py-8">
            <JsonView text={text} />
          </div>
        )}

        {!error && wantsExtractedText && text != null && (
          <div className="px-10 py-10">
            <div className="text-[12px] uppercase tracking-wider font-semibold text-subtle mb-3">extracted text</div>
            <pre className="text-[13px] whitespace-pre-wrap break-words md">{text}</pre>
          </div>
        )}

        {!error && wantsExtractedText && text == null && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md p-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3" style={{ background: 'var(--viewer)' }}>
                <Sparkles size={22} className="text-accent" />
              </div>
              <div className="text-fg font-semibold">Not indexed yet</div>
              <div className="text-[13px] text-muted mt-1 mb-4">
                Index this file to extract its text and make it searchable for AI agents.
              </div>
              <button className="btn-primary" disabled={indexing} onClick={indexNow}>
                <Sparkles size={14} />
                {indexing ? 'Indexing…' : 'Index for search'}
              </button>
              <div className="mt-4">
                <a className="btn-ghost" href={api.rawUrl(path, callerOpts)} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  Open original
                </a>
              </div>
            </div>
          </div>
        )}

        {!error && !isPdf && !isImage && !isVideo && !isAudio && !isMarkdown && !isText && !isCsv && !isJson && !isHtml && !wantsExtractedText && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-fg font-semibold mb-1">Preview unavailable</div>
              <div className="text-[13px] text-muted">Use Download to open it locally.</div>
            </div>
          </div>
        )}

        </div>
        {/* Floating action stack — back-to-top sits above the chat FAB
            when both are visible, slides into the corner alone when the
            chat panel is open. Single column so the two affordances
            never compete for the same visual slot. */}
        {(showScrollTop || (chatEnabled && !chatOpen && meta)) && (
          <div className="absolute bottom-5 right-5 z-30 flex flex-col items-end gap-2">
            {showScrollTop && (
              <button
                type="button"
                onClick={() => contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                className="h-11 w-11 rounded-full shadow-card inline-flex items-center justify-center transition-opacity hover:opacity-90"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  border: '1px solid var(--accent)',
                }}
                title="Back to top"
                aria-label="Back to top"
              >
                <ArrowUp size={18} />
              </button>
            )}
            {chatEnabled && !chatOpen && meta && (
              <button
                className="h-11 w-11 rounded-full inline-flex items-center justify-center transition-transform hover:scale-105"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  boxShadow: '0 8px 20px rgba(15, 23, 42, 0.18)',
                }}
                onClick={() => setChatOpen(true)}
                title="Ask Reader AI about this document"
                aria-label="Open Reader AI"
              >
                <MessageCircle size={18} />
              </button>
            )}
          </div>
        )}
        {/* Selection-driven "Explain with Reader AI" popover.
            Scoped to the doc content scroller via contentRef so
            selections in the chat sidebar / outline don't trigger
            it. The handler opens the chat and queues the selection
            as a pending message — ChatDock consumes it and auto-
            sends "Explain this: …" once mounted. Hidden alongside
            the chat dock when Reader AI is off. */}
        {meta && (
          <SelectionPopover
            containerRef={contentRef}
            // Explain + Reply only when chat is available. The
            // SelectionPopover collapses to just the Comment action
            // (plus Reply if read-only chat is allowed) when the
            // dock isn't reachable.
            onExplain={
              chatEnabled
                ? (text) => {
                    // Cap to ~3500 chars to leave room for the
                    // prefix inside the server's 4000-char content
                    // limit.
                    const trimmed = text.length > 3500 ? text.slice(0, 3500) + '…' : text
                    setPendingChatMessage(`Explain this: "${trimmed}"`)
                    setChatOpen(true)
                  }
                : undefined
            }
            // Reply affordance is universal — even read-only viewers
            // can ask freeform questions against a quoted selection.
            // The Apply button on any resulting proposed_edit card
            // is the actual edit gate (server enforces write access).
            onReply={
              chatEnabled
                ? (text) => {
                    const trimmed = text.length > 3500 ? text.slice(0, 3500) + '…' : text
                    setPendingChatQuote(trimmed)
                    setChatOpen(true)
                  }
                : undefined
            }
            bodyRef={viewerBodyRef}
            onComment={
              meta?.id
                ? async (anchor, text) => {
                    const docId = meta.id
                    const { comment } = await api.createComment({
                      docId,
                      text,
                      quote: anchor.quote.slice(0, 2000),
                      rangeStart: anchor.rangeStart,
                      rangeEnd: anchor.rangeEnd,
                    })
                    handleCommentCreated(comment)
                  }
                : undefined
            }
          />
        )}
       </div>

       {/* AI chat sidebar — placed BEFORE the outline rail so it sits
           adjacent to the content. The natural reading flow is left
           → right; the active "ask" surface belongs next to the doc,
           not pushed past navigation chrome. */}
       {chatEnabled && chatOpen && chatMeta && (
         <ChatDock
           meta={chatMeta}
           onClose={() => setChatOpen(false)}
           pendingMessage={pendingChatMessage}
           onPendingConsumed={() => setPendingChatMessage(null)}
           pendingQuote={pendingChatQuote}
           onPendingQuoteConsumed={() => setPendingChatQuote(null)}
           onDocEdited={async () => {
             // The chat just applied a proposed edit to this doc.
             // Refetch the body + meta so the viewer reflects the
             // new content without a hard reload. Also drop any
             // active edit preview — it's now stale.
             setPreviewMessageId(null)
             try {
               const [r, m] = await Promise.all([
                 api.fileText(path, callerOpts).catch(() => null),
                 api.fileMeta(path, callerOpts).catch(() => null),
               ])
               if (r) setText(r.content)
               if (m) setMeta(m.meta)
             } catch {
               /* swallow — user can refresh manually */
             }
           }}
           onPreviewEdit={(messageId) =>
             setPreviewMessageId((cur) => (cur === messageId ? null : messageId))
           }
           previewingMessageId={previewMessageId}
           historyReloadKey={chatHistoryReloadKey}
         />
       )}
       {showOutline && (
         <DocRail
           path={path}
           text={text}
           headings={headings}
           hasOutlineList={hasOutlineList}
           outlineOpen={outlineOpen}
           setOutlineOpen={setOutlineOpen}
           versionsOpen={versionsOpen}
           setVersionsOpen={setVersionsOpen}
           jumpTo={jumpTo}
           activeDiffTs={diffTs}
           onPickVersion={(ts) => setDiffTs(ts)}
           versionsReloadKey={versionsReloadKey}
           awareness={crdt?.awareness ?? null}
           peersOpen={peersOpen}
           setPeersOpen={setPeersOpen}
           ownerOpt={ownerOpt}
           comments={comments ?? undefined}
           commentsOpen={commentsOpen}
           setCommentsOpen={setCommentsOpen}
           onScrollToComment={handleScrollToComment}
           onResolveComment={handleCommentResolve}
           onDeleteComment={handleCommentDelete}
           onCopyCommentLink={handleCopyCommentLink}
           currentUsername={currentUsername}
           focusedCommentId={focusedCommentId}
         />
       )}
      </div>
      <MetadataPanel
        path={path}
        meta={meta}
        owner={ownerOpt}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      />
    </div>
  )
}

/** Translate raw API error messages into something the user can act on. */
function prettyError(raw: string): string {
  const low = raw.toLowerCase()
  if (low === 'forbidden' || low.includes('forbidden')) {
    return "You don't have access to this file. If someone shared a folder with you, you may have lost that grant — ask them to re-share."
  }
  if (low === 'file not found' || low.includes('not found')) {
    return "The file no longer exists at this path. It may have been moved, renamed, or deleted."
  }
  if (low.includes('link expired')) {
    return 'This public link has expired.'
  }
  if (low.includes('password')) {
    return 'A password is required to open this file.'
  }
  return raw
}




/** Tooltip explaining why the Copy button is disabled for a given
 *  file type. The system clipboard only natively understands text
 *  and a handful of image MIMEs; PDFs / audio / video / archives
 *  have no clipboard representation. */
function copySupportHint(ext: string): string {
  if (ext === '.pdf') return 'Copy not supported for PDFs — use Download.'
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) {
    return 'Copy not supported for video — use Download.'
  }
  if (['.mp3', '.m4a', '.wav', '.flac', '.ogg'].includes(ext)) {
    return 'Copy not supported for audio — use Download.'
  }
  if (['.zip', '.tar', '.gz', '.7z'].includes(ext)) {
    return 'Copy not supported for archives — use Download.'
  }
  return 'Copy not supported for this file type — use Download.'
}
