import { useEffect, useRef, useState } from 'react'
import { Info, Globe, Lock, Sparkles, X } from 'lucide-react'
import type { DocumentMeta } from '../lib/api'

type Props = {
  path: string
  meta: DocumentMeta | null
}

export function FileInfoButton({ path, meta }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  const filename = meta?.originalFilename ?? path.split('/').pop() ?? path

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        className="btn-ghost h-6 w-6 px-0 shrink-0"
        onClick={() => setOpen((v) => !v)}
        title="File details"
        aria-label="File details"
      >
        <Info size={13} />
      </button>
      {open && (
        <div
          className="absolute top-full mt-1.5 z-30 w-[340px] rounded-md shadow-card overflow-hidden"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border-soft)',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <div
            className="flex items-center gap-2 px-3 h-8 border-b"
            style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
          >
            <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle flex-1">
              File details
            </div>
            <button className="btn-ghost h-5 w-5 px-0" onClick={() => setOpen(false)}>
              <X size={10} />
            </button>
          </div>

          <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <InfoRow label="Name" value={<span className="font-medium break-all">{filename}</span>} />
              <InfoRow label="Path" value={<span className="break-all">/{path}</span>} />
              {meta && (
                <>
                  <InfoRow label="Size" value={formatBytes(meta.bytes)} />
                  <InfoRow label="Type" value={meta.mime} />
                  <InfoRow label="Owner" value={meta.owner} />
                  <InfoRow label="Created" value={formatDate(meta.createdAt)} />
                  <InfoRow label="Updated" value={formatDate(meta.updatedAt)} />
                  <InfoRow
                    label="Visibility"
                    value={
                      meta.public ? (
                        <span className="inline-flex items-center gap-1 font-medium" style={{ color: '#00875A' }}>
                          <Globe size={11} /> Public
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted">
                          <Lock size={11} /> Private
                        </span>
                      )
                    }
                  />
                  <InfoRow label="Indexed" value={<IngestStatus meta={meta} />} />
                  {meta.tags?.length > 0 && (
                    <InfoRow label="Tags" value={meta.tags.join(', ')} />
                  )}
                  {meta.sha256 && (
                    <InfoRow
                      label="sha256"
                      value={<span className="text-subtle break-all" style={{ fontVariantNumeric: 'tabular-nums' }}>{meta.sha256}</span>}
                    />
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr style={{ borderTop: '1px solid var(--border-soft)' }}>
      <td
        className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle align-top py-1.5 pl-3 pr-2 whitespace-nowrap"
        style={{ width: 84 }}
      >
        {label}
      </td>
      <td className="text-fg align-top py-1.5 pr-3 leading-snug">{value}</td>
    </tr>
  )
}

function IngestStatus({ meta }: { meta: DocumentMeta }) {
  if (meta.ingest.embedded) {
    return (
      <span className="inline-flex items-center gap-1 font-medium" style={{ color: '#00875A' }}>
        <Sparkles size={11} /> indexed · {meta.ingest.chunkCount ?? 0}
      </span>
    )
  }
  if (meta.ingest.status === 'ready' && (meta.ingest.chunkCount ?? 0) > 0) {
    return <span className="text-muted">text-only · {meta.ingest.chunkCount}</span>
  }
  return <span className="text-muted">{meta.ingest.status}</span>
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
