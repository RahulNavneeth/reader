import { useMemo } from 'react'
import hljs from 'highlight.js/lib/core'
import jsonLang from 'highlight.js/lib/languages/json'

hljs.registerLanguage('json', jsonLang)

/**
 * Pretty-prints JSON with syntax highlighting. Falls back to a plain
 * monospace view (and a warning) when the file isn't valid JSON.
 */
export function JsonView({ text }: { text: string }) {
  const { pretty, valid } = useMemo(() => {
    try {
      const parsed = JSON.parse(text)
      return { pretty: JSON.stringify(parsed, null, 2), valid: true }
    } catch {
      return { pretty: text, valid: false }
    }
  }, [text])

  const highlighted = useMemo(() => {
    if (!valid) return null
    try {
      return hljs.highlight(pretty, { language: 'json' }).value
    } catch {
      return null
    }
  }, [pretty, valid])

  return (
    <div>
      {!valid && (
        <div
          className="mb-3 px-3 py-2 rounded text-[12px]"
          style={{ background: '#FFFAE6', color: '#974F0C', border: '1px solid #FFE0AC' }}
        >
          Not valid JSON — showing raw text.
        </div>
      )}
      <pre
        className="text-[13px] leading-relaxed"
        style={{
          background: 'var(--code-bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '12px 14px',
          overflowX: 'auto',
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {highlighted ? (
          <code className="hljs language-json" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{pretty}</code>
        )}
      </pre>
    </div>
  )
}
