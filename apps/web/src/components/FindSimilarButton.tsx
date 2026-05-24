import { useEffect, useRef, useState } from 'react'
import { Telescope, Loader2, AlertCircle, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../lib/api'
import { alignStyle, useAnchoredAlign } from '../lib/anchoredAlign'

type Hit = {
  docId: string
  title: string
  path: string
  owner: string
  score: number
  snippet: string
}

/** Strip enough markdown noise from a snippet to make it readable
 *  as plain prose inside a tiny popover row. We don't try to be
 *  comprehensive — just remove the worst offenders (headings,
 *  emphasis, table separators, link syntax, code fences) and
 *  collapse whitespace so a multi-line excerpt fits on one line. */
function cleanSnippet(raw: string): string {
  return raw
    // YAML frontmatter delimiters
    .replace(/^---[\s\S]*?---/m, '')
    // Markdown table separator rows: | --- | --- |
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
    // Heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Code fences
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold / italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\s][^*]*?)\*(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/(^|\s)_([^_\s][^_]*?)_(?=\s|$|[.,;:!?])/g, '$1$2')
    // Markdown links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Blockquote markers
    .replace(/^>\s?/gm, '')
    // List bullets
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Table column pipes → space (after separator rows are gone)
    .replace(/\s*\|\s*/g, ' ')
    // Collapse all whitespace runs (incl. newlines) into single spaces
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * "Find similar" toolbar button. Clicking opens a small anchored
 * popover that calls `GET /api/search/similar/:docId` and lists
 * the top-N matches by chunk-centroid cosine. Each row links to
 * the matched doc; the popover closes on outside-click or Esc.
 *
 * Lazy fetch — we only hit the endpoint when the user actually
 * opens the popover so we don't pay the cosine scan on every
 * doc view.
 */
export function FindSimilarButton({
  docId,
  path,
  ownerHint,
}: {
  docId: string
  /** Storage key for the same doc — sent as a fallback so a stale
   *  docId still resolves on the server via owner+path lookup. */
  path?: string
  ownerHint?: string
}) {
  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const align = useAnchoredAlign({
    triggerRef: rootRef,
    popoverWidth: 360,
    open,
  })

  useEffect(() => {
    if (!open) return
    setHits(null)
    setErr(null)
    api
      .findSimilarDocs(docId, 10, path ? { path } : undefined)
      .then((r) => setHits(r.hits))
      .catch((e) => setErr(e instanceof ApiError ? e.message : String(e)))
  }, [open, docId, path])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Find similar documents"
        aria-label="Find similar documents"
        aria-expanded={open}
        style={open ? { background: 'var(--selected)', color: 'var(--accent)' } : undefined}
      >
        <Telescope size={13} />
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 w-[360px] rounded-md shadow-card overflow-hidden flex flex-col"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            maxHeight: 460,
            ...alignStyle(align),
          }}
        >
          <div
            className="flex items-center gap-2 px-3 h-8 shrink-0"
            style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)' }}
          >
            <Telescope size={13} className="text-accent" />
            <span className="text-[12px] font-semibold text-fg flex-1">Similar documents</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {hits == null && !err && (
              <div className="text-[12px] text-subtle flex items-center gap-1.5 px-2 py-1.5">
                <Loader2 size={12} className="animate-spin" /> Computing similarity…
              </div>
            )}
            {err && (
              <div
                className="px-2 py-1.5 rounded text-[12px] flex items-start gap-1.5"
                style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
              >
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                {prettySimilarError(err)}
              </div>
            )}
            {hits && hits.length === 0 && (
              <div className="text-[12px] text-subtle px-2 py-2 leading-snug">
                No similar documents yet. Either this doc has no embeddings (still ingesting) or nothing in the vault scores above the similarity floor.
              </div>
            )}
            {hits && hits.length > 0 && (
              <ul className="space-y-0.5">
                {hits.map((h) => {
                  const cleanPath = h.path.replace(/^\/+/, '')
                  const ownerQS =
                    ownerHint || (h.owner ? `?owner=${encodeURIComponent(h.owner)}` : '')
                  // Same-owner docs don't need ?owner=.
                  const to = `/${cleanPath}${ownerHint && h.owner !== ownerHint ? `?owner=${encodeURIComponent(h.owner)}` : ''}`
                  void ownerQS
                  return (
                    <li key={h.docId}>
                      <Link
                        to={to}
                        onClick={() => setOpen(false)}
                        className="block px-2 py-1.5 rounded transition-colors hover:bg-hover"
                      >
                        <div className="text-[12.5px] font-medium text-fg flex items-center gap-1.5">
                          <FileText size={11} className="text-accent shrink-0" />
                          <span className="truncate flex-1 min-w-0">{h.title || h.path}</span>
                          <span
                            className="text-[10px] tabular-nums shrink-0 text-subtle"
                            title={`Cosine similarity ${h.score.toFixed(3)}`}
                          >
                            {Math.round(h.score * 100)}%
                          </span>
                        </div>
                        {(() => {
                          const cleaned = cleanSnippet(h.snippet || '')
                          if (!cleaned) return null
                          return (
                            <div className="text-[11px] text-subtle mt-0.5 truncate">
                              {cleaned}
                            </div>
                          )
                        })()}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Translate the raw server error text into something a user can
 *  act on. The dispatcher's terse phrases ("source document not
 *  found", "forbidden") leak implementation jargon otherwise. */
function prettySimilarError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('source document not found')) {
    return "This document isn't indexed yet, or it was deleted. Try refreshing the page."
  }
  if (m === 'forbidden' || m.includes('permission')) {
    return "You don't have access to find similar documents for this file."
  }
  return msg
}
