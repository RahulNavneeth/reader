import { useMemo } from 'react'
import { parseCsv } from '../lib/csv'

const MAX_ROWS = 2000

export function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text])
  if (rows.length === 0) {
    return <div className="text-[13px] text-muted">empty file</div>
  }
  const header = rows.length > 1 ? rows[0] : null
  const body = rows.length > 1 ? rows.slice(1) : rows
  const visible = body.slice(0, MAX_ROWS)
  const truncated = body.length > MAX_ROWS
  const cols = (header ?? rows[0]).length
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-2">
        {rows.length} row{rows.length === 1 ? '' : 's'} · {cols} col{cols === 1 ? '' : 's'}
      </div>
      <div
        className="overflow-x-auto rounded border"
        style={{ borderColor: 'var(--border)' }}
      >
        <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
          {header && (
            <thead style={{ background: 'var(--table-header-bg)' }}>
              <tr>
                {header.map((h, i) => (
                  <th
                    key={i}
                    className="px-2.5 py-1.5 text-left font-semibold text-fg whitespace-nowrap"
                    style={{ borderBottom: '1px solid color-mix(in srgb, var(--fg) 18%, var(--viewer))' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {visible.map((r, ri) => (
              <tr
                key={ri}
                style={{
                  borderTop: ri === 0 ? 'none' : '1px solid var(--border)',
                  background: ri % 2 === 1 ? 'var(--table-stripe-bg)' : 'transparent',
                }}
              >
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className="px-2.5 py-1 text-fg align-top"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <div className="text-[11.5px] text-subtle mt-2">
          Showing first {MAX_ROWS.toLocaleString()} of {body.length.toLocaleString()} rows.
        </div>
      )}
    </div>
  )
}
