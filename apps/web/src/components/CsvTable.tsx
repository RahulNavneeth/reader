import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Filter, X } from 'lucide-react'
import { parseCsv } from '../lib/csv'

const MAX_ROWS = 2000

type SortDir = 'asc' | 'desc' | null

export function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text])
  const header = rows.length > 1 ? rows[0] : null
  const body = useMemo(() => (rows.length > 1 ? rows.slice(1) : rows), [rows])
  const cols = (header ?? rows[0] ?? []).length

  // ── Sort + filter state. Per-column filter (string substring) and
  // a single sorted column. Header click cycles none → asc → desc →
  // none. Try numeric / date sort first, fall back to string.
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState<string[]>(() => Array(cols).fill(''))

  // Keep the filters array sized to match the current column count
  // even if the source CSV was re-parsed.
  if (filters.length !== cols) setFilters(Array(cols).fill(''))

  const filtered = useMemo(() => {
    const active = filters
      .map((f, i) => ({ i, v: f.trim().toLowerCase() }))
      .filter((x) => x.v.length > 0)
    if (active.length === 0) return body
    return body.filter((row) =>
      active.every((f) => (row[f.i] ?? '').toLowerCase().includes(f.v)),
    )
  }, [body, filters])

  const sorted = useMemo(() => {
    if (sortCol == null || sortDir == null) return filtered
    const dirMul = sortDir === 'asc' ? 1 : -1
    // Detect a column-wide type so 9 < 10 doesn't end up as "10" <
    // "9". A column is numeric only if every non-empty cell parses
    // as a finite number; otherwise fall back to localeCompare.
    const colVals = filtered.map((r) => (r[sortCol] ?? '').trim())
    const allNumeric =
      colVals.length > 0 &&
      colVals.every((v) => v === '' || Number.isFinite(Number(v)))
    const next = filtered.slice()
    next.sort((ra, rb) => {
      const a = (ra[sortCol] ?? '').trim()
      const b = (rb[sortCol] ?? '').trim()
      // Empties sort last regardless of direction.
      if (a === '' && b === '') return 0
      if (a === '') return 1
      if (b === '') return -1
      if (allNumeric) return dirMul * (Number(a) - Number(b))
      return dirMul * a.localeCompare(b, undefined, { numeric: true })
    })
    return next
  }, [filtered, sortCol, sortDir])

  const visible = sorted.slice(0, MAX_ROWS)
  const truncated = sorted.length > MAX_ROWS

  if (rows.length === 0) {
    return <div className="text-[13px] text-muted">empty file</div>
  }

  const onHeaderClick = (i: number) => {
    if (sortCol !== i) {
      setSortCol(i)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') setSortDir('desc')
    else if (sortDir === 'desc') {
      setSortCol(null)
      setSortDir(null)
    } else setSortDir('asc')
  }

  const updateFilter = (i: number, v: string) => {
    setFilters((cur) => {
      const next = cur.slice()
      next[i] = v
      return next
    })
  }

  const clearFilters = () => setFilters(Array(cols).fill(''))
  const anyFilter = filters.some((f) => f.trim().length > 0)

  const headerBorder = 'color-mix(in srgb, var(--fg) 30%, var(--table-cell-bg))'

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle">
          {sorted.length.toLocaleString()} row{sorted.length === 1 ? '' : 's'}
          {sorted.length !== body.length && (
            <span className="ml-1 opacity-70">
              of {body.length.toLocaleString()}
            </span>
          )}
          {' · '}
          {cols} col{cols === 1 ? '' : 's'}
        </div>
        <div className="flex-1" />
        {anyFilter && (
          <button
            type="button"
            onClick={clearFilters}
            className="btn-ghost h-7 px-2 text-[11.5px]"
            title="Clear all column filters"
          >
            <X size={11} />
            Clear filters
          </button>
        )}
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          className="btn-ghost h-7 px-2 text-[11.5px]"
          title={filterOpen ? 'Hide filter row' : 'Show filter row'}
          style={
            filterOpen
              ? { background: 'var(--selected)', color: 'var(--accent)' }
              : undefined
          }
        >
          <Filter size={11} />
          Filter
        </button>
      </div>
      <div className="overflow-x-auto">
        <table
          className="text-[13.5px]"
          style={{ borderCollapse: 'collapse', width: '100%' }}
        >
          {header && (
            <thead>
              <tr>
                {header.map((h, i) => {
                  const isSorted = sortCol === i
                  const Icon =
                    isSorted && sortDir === 'asc'
                      ? ArrowUp
                      : isSorted && sortDir === 'desc'
                        ? ArrowDown
                        : ChevronsUpDown
                  return (
                    <th
                      key={i}
                      onClick={() => onHeaderClick(i)}
                      className="text-left font-semibold text-fg whitespace-nowrap cursor-pointer select-none group"
                      style={{
                        background: 'var(--table-header-bg)',
                        border: '1px solid var(--table-border)',
                        borderColor: headerBorder,
                        padding: '7px 12px',
                      }}
                      title={
                        isSorted
                          ? sortDir === 'asc'
                            ? 'Sorted ascending — click for descending'
                            : 'Sorted descending — click to clear'
                          : 'Click to sort'
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {h}
                        <Icon
                          size={11}
                          className={
                            isSorted
                              ? 'text-accent'
                              : 'text-subtle opacity-0 group-hover:opacity-60 transition-opacity'
                          }
                        />
                      </span>
                    </th>
                  )
                })}
              </tr>
              {filterOpen && (
                <tr>
                  {Array.from({ length: cols }).map((_, i) => (
                    <th
                      key={i}
                      style={{
                        background: 'var(--table-header-bg)',
                        border: '1px solid var(--table-border)',
                        borderColor: headerBorder,
                        padding: '4px 6px',
                      }}
                    >
                      <input
                        className="input h-6 text-[12px]"
                        placeholder="filter…"
                        value={filters[i] ?? ''}
                        onChange={(e) => updateFilter(i, e.target.value)}
                        style={{ background: 'var(--surface-2)' }}
                      />
                    </th>
                  ))}
                </tr>
              )}
            </thead>
          )}
          <tbody>
            {visible.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className="text-fg align-top"
                    style={{
                      background:
                        ri % 2 === 1
                          ? 'var(--table-stripe-bg)'
                          : 'var(--table-cell-bg)',
                      border: '1px solid var(--table-border)',
                      padding: '7px 12px',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={cols}
                  className="text-[12.5px] text-subtle text-center"
                  style={{
                    background: 'var(--table-cell-bg)',
                    border: '1px solid var(--table-border)',
                    padding: '16px 12px',
                  }}
                >
                  No rows match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {truncated && (
        <div className="text-[11.5px] text-subtle mt-2">
          Showing first {MAX_ROWS.toLocaleString()} of {sorted.length.toLocaleString()} rows.
        </div>
      )}
    </div>
  )
}
