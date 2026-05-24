/**
 * CSV "table" view for MCP tools. The ingest pipeline already extracts
 * the raw text of a CSV (one row per line) and feeds it to search.
 * These helpers parse the file into a structured row/column form so
 * agents can:
 *   - discover the schema (`getCsvColumns`)
 *   - read a window of rows with optional column projection
 *     (`getCsvRows`)
 *
 * Reuses the existing `xlsx` dependency — it handles delimiter
 * detection (comma vs tab vs semicolon) and quoted fields without us
 * hand-rolling a parser. For very large CSVs we cap at the lib's
 * default streaming behavior; the MCP rate limiter bounds abuse.
 */
import { readFile } from 'node:fs/promises'

type Row = Record<string, unknown>

async function parseCsv(absPath: string): Promise<{ columns: string[]; rows: Row[] }> {
  const buf = await readFile(absPath)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buf, { type: 'buffer', raw: false })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return { columns: [], rows: [] }
  const sheet = wb.Sheets[sheetName]
  if (!sheet) return { columns: [], rows: [] }
  // `sheet_to_json` with no header opt uses the first row as keys.
  // `defval: null` ensures missing cells survive the round-trip
  // instead of being dropped from the object.
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null }) as Row[]
  // Column order from the FIRST row's keys — xlsx preserves the
  // original CSV column order in object-iteration order.
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
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
