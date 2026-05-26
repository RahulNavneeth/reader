/**
 * CSV "table" view for MCP tools. The ingest pipeline already extracts
 * the raw text of a CSV (one row per line) and feeds it to search.
 * These helpers parse the file into a structured row/column form so
 * agents can:
 *   - discover the schema (`getCsvColumns`)
 *   - read a window of rows with optional column projection
 *     (`getCsvRows`)
 *
 * Built on `papaparse` — actively maintained, no known CVEs, and the
 * standard JS CSV parser. Handles quoted fields, escaped quotes,
 * auto-detects the delimiter (`comma | tab | semicolon | pipe`), and
 * surfaces missing cells as `null` so they survive the round-trip
 * instead of getting dropped silently.
 *
 * Previously used SheetJS (`xlsx`) for the same job; swapped after
 * the prototype-pollution + ReDoS CVE — no npm fix available.
 */
import { readFile } from 'node:fs/promises'

type Row = Record<string, unknown>

async function parseCsv(absPath: string): Promise<{ columns: string[]; rows: Row[] }> {
  const buf = await readFile(absPath)
  const Papa = (await import('papaparse')).default
  const text = buf.toString('utf8')
  const result = Papa.parse<Row>(text, {
    // First row is the header; downstream code keys on column names.
    header: true,
    // Don't choke on a stray trailing newline / empty row at the
    // end of the file — common from spreadsheet exports.
    skipEmptyLines: true,
    // Auto-detect delimiter from the first 10 lines; matches the
    // tolerance the old xlsx path gave us for free.
    delimiter: '',
    // Strip whitespace around quoted values + cell content.
    transformHeader: (h) => h.trim(),
  })
  const rows = (result.data ?? []).map((r) => {
    // Papa returns `undefined` for missing cells; convert to `null`
    // so MCP clients get a stable JSON shape (xlsx behavior).
    const out: Row = {}
    for (const k of Object.keys(r)) {
      const v = (r as Row)[k]
      out[k] = v === undefined || v === '' ? null : v
    }
    return out
  })
  // Header order from Papa — preserves the original CSV column order.
  const columns = (result.meta?.fields ?? (rows.length > 0 ? Object.keys(rows[0]) : [])) as string[]
  return { columns, rows }
}

export async function getCsvColumns(
  absPath: string,
  sampleCount = 3,
): Promise<{ columns: string[]; rowCount: number; samples: Row[] }> {
  const { columns, rows } = await parseCsv(absPath)
  return {
    columns,
    rowCount: rows.length,
    samples: rows.slice(0, Math.max(0, sampleCount)),
  }
}

export async function getCsvRows(
  absPath: string,
  opts: {
    limit?: number
    offset?: number
    /** When non-empty, return only these columns in each row. Unknown
     *  column names are silently skipped — the alternative (throwing)
     *  is worse UX for an agent that mistyped a header. */
    columns?: string[]
  } = {},
): Promise<{ rows: Row[]; totalRows: number; hasMore: boolean }> {
  const { rows } = await parseCsv(absPath)
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500)
  const slice = rows.slice(offset, offset + limit)
  const projected =
    opts.columns && opts.columns.length > 0
      ? slice.map((r) => {
          const out: Row = {}
          for (const c of opts.columns!) {
            if (c in r) out[c] = r[c]
          }
          return out
        })
      : slice
  return {
    rows: projected,
    totalRows: rows.length,
    hasMore: offset + slice.length < rows.length,
  }
}
