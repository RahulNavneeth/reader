import { useEffect, useMemo, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { computeLineDiff, type DiffOp } from '../lib/lineDiff'

type Props = {
  path: string
  ts: number
  currentText: string
  onClose: () => void
}

/**
 * Inline diff view between an older snapshot and the current
 * on-disk text. Replaces the old "preview pane" that just showed
 * the snapshot's extracted text without any diff context —
 * which is what the user couldn't read.
 *
 * Render shape: unified line-by-line diff (GitHub-style).
 *   - removed lines (in old but not new) → red, "-" gutter
 *   - added   lines (in new but not old) → green, "+" gutter
 *   - context lines (in both)           → muted, " " gutter
 *
 * Computes LCS over lines client-side. For markdown / code docs
 * the typical line count is < 1000 — O(N·M) is fine. Capped at
 * 4000 lines per side so a pathological doc doesn't freeze the
 * tab.
 */
export function VersionDiffModal({ path, ts, currentText, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSnapshot(null)
    setError(null)
    api
      .fileVersionText(path, ts)
      .then((r) => {
        if (!cancelled) setSnapshot(r.text ?? '')
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, ts])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const diff = useMemo(() => {
    if (snapshot === null) return null
    return computeLineDiff(snapshot, currentText)
  }, [snapshot, currentText])

  const stats = useMemo(() => {
    if (!diff) return null
    let added = 0
    let removed = 0
    for (const op of diff) {
      if (op.kind === 'ins') added++
      else if (op.kind === 'del') removed++
    }
    return { added, removed }
  }, [diff])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      style={{ background: 'rgba(15, 23, 42, 0.55)' }}
      onClick={onClose}
    >
      <div
        className="rounded-md overflow-hidden flex flex-col"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          width: 'min(820px, 100%)',
          maxHeight: '80vh',
          boxShadow: '0 12px 36px rgba(15, 23, 42, 0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-3 h-10 flex items-center gap-2 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="text-[12.5px] font-semibold text-fg">
            Changes since {new Date(ts).toLocaleString()}
          </div>
          {stats && (
            <div className="text-[11px] text-subtle">
              <span style={{ color: '#00875A' }}>+{stats.added}</span>
              {' · '}
              <span style={{ color: 'var(--danger-fg)' }}>−{stats.removed}</span>
            </div>
          )}
          <button
            className="ml-auto btn-ghost h-6 w-6 px-0"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={12} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {snapshot === null && !error && (
            <div className="px-3 py-3 text-[12px] text-subtle flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading snapshot…
            </div>
          )}
          {error && (
            <div
              className="m-3 px-3 py-2 rounded text-[12px]"
              style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
            >
              {error}
            </div>
          )}
          {diff && diff.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-subtle">
              No textual differences — the doc body is identical to this snapshot.
            </div>
          )}
          {diff && diff.length > 0 && <DiffBody diff={diff} />}
        </div>
      </div>
    </div>
  )
}

function DiffBody({ diff }: { diff: DiffOp[] }) {
  return (
    <pre
      className="text-[11.5px] leading-snug font-mono m-0"
      style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      {diff.map((op, i) => (
        <DiffLine key={i} op={op} />
      ))}
    </pre>
  )
}

function DiffLine({ op }: { op: DiffOp }) {
  const palette = {
    ins: { bg: '#E3FCEF', fg: '#006644', sign: '+' },
    del: { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', sign: '−' },
    eq: { bg: 'transparent', fg: 'var(--fg-subtle)', sign: ' ' },
  } as const
  const p = palette[op.kind]
  return (
    <div
      className="flex items-start px-3 py-[1px] whitespace-pre-wrap break-words"
      style={{ background: p.bg, color: p.fg }}
    >
      <span
        className="shrink-0 w-4 select-none opacity-70"
        style={{ fontFamily: 'inherit' }}
      >
        {p.sign}
      </span>
      <span className="flex-1 min-w-0">{op.line || ' '}</span>
    </div>
  )
}

