import { useEffect, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import 'highlight.js/styles/github.css'
import type { Heading } from '../types'

type Props = {
  content: string
  onHeadings: (h: Heading[]) => void
  onActiveHeading: (id: string | null) => void
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

export function DocView({ content, onHeadings, onActiveHeading }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Pre-extract headings from markdown for the TOC (cheap regex pass)
  const headings = useMemo(() => {
    const out: Heading[] = []
    const lines = content.split(/\r?\n/)
    let inCodeFence = false
    for (const line of lines) {
      if (/^```/.test(line)) {
        inCodeFence = !inCodeFence
        continue
      }
      if (inCodeFence) continue
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (m) {
        const text = m[2].replace(/`/g, '').trim()
        out.push({ level: m[1].length, text, id: slugify(text) })
      }
    }
    return out
  }, [content])

  useEffect(() => {
    onHeadings(headings)
  }, [headings, onHeadings])

  // Active heading via IntersectionObserver
  useEffect(() => {
    if (!ref.current) return
    const root = ref.current.closest('main') || undefined
    const els = ref.current.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
    if (els.length === 0) {
      onActiveHeading(null)
      return
    }
    const visible = new Map<string, number>()
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).id
          if (e.isIntersecting) visible.set(id, e.intersectionRatio)
          else visible.delete(id)
        }
        let bestId: string | null = null
        let bestY = Infinity
        for (const id of visible.keys()) {
          const el = ref.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
          if (!el) continue
          const top = el.getBoundingClientRect().top
          if (top < bestY) {
            bestY = top
            bestId = id
          }
        }
        onActiveHeading(bestId)
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: [0, 1] },
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [content, onActiveHeading])

  // Reset scroll on content change
  useEffect(() => {
    const m = ref.current?.closest('main')
    if (m) m.scrollTop = 0
  }, [content])

  return (
    <div ref={ref} className="px-10 py-10">
      <article className="md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[
            rehypeSlug,
            [
              rehypeAutolinkHeadings,
              {
                behavior: 'append',
                properties: { className: ['anchor'], 'aria-hidden': 'true', tabIndex: -1 },
                content: { type: 'text', value: '#' },
              },
            ],
            rehypeHighlight,
          ]}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  )
}
