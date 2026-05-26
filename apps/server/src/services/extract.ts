/**
 * Mime → plain text extractors. All return UTF-8 strings.
 * Returns empty string for media types we can't extract from (e.g., images
 * without OCR, audio/video) — caller stores the file but ingest pipeline
 * marks status=no-text.
 */
import path from 'node:path'
import { extractImageText } from './ocr.js'
import { isHeic } from './heic.js'
import { isImageNeedingTranscode, isVideo, transcodeImageToJpeg } from './media.js'

export async function extractText(buffer: Buffer, mime: string, filename: string): Promise<string> {
  const m = (mime || '').toLowerCase()
  const ext = path.extname(filename).toLowerCase()

  if (m.includes('pdf') || ext === '.pdf') {
    const text = await extractPdf(buffer)
    // Scanned PDFs have no embedded text layer — fall back to OCR'ing each
    // rendered page. extractPdf returns "" in that case; treat very short
    // results (< 8 chars) as effectively empty too.
    if (text.replace(/\s/g, '').length >= 8) return text
    const ocr = await ocrPdf(buffer)
    return ocr || text
  }
  if (
    m.includes('officedocument.wordprocessingml.document') ||
    ext === '.docx'
  )
    return extractDocx(buffer)
  if (m.includes('officedocument.spreadsheetml.sheet') || ext === '.xlsx' || ext === '.xls')
    return extractXlsx(buffer)
  if (m.includes('html') || ext === '.html' || ext === '.htm') return extractHtml(buffer)
  if (m.startsWith('text/') || ['.md', '.markdown', '.mdx', '.txt', '.csv', '.json', '.yaml', '.yml', '.toml'].includes(ext)) {
    return buffer.toString('utf8')
  }
  // Videos: no text payload to extract. Search will rely on filename/tags.
  if (isVideo(filename) || m.startsWith('video/')) return ''
  // HEIC/TIFF/JXL: tesseract can't read these — transcode to JPEG first so
  // iPhone screenshots and scanned TIFFs still get OCR'd.
  if (isHeic(filename) || isImageNeedingTranscode(filename) || m === 'image/heic' || m === 'image/heif') {
    const jpeg = await transcodeImageToJpeg(buffer, filename)
    return jpeg ? extractImageText(jpeg) : ''
  }
  if (m.startsWith('image/')) return extractImageText(buffer)
  return ''
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // pdfjs-dist legacy build is the recommended Node-side import.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
  } as any)
  const pdf = await loadingTask.promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = (content.items as Array<{ str?: string }>)
      .map((item) => item.str ?? '')
      .join(' ')
    pages.push(text)
    page.cleanup()
  }
  await pdf.cleanup()
  await pdf.destroy()
  return pages.join('\n\n')
}

/** Scanned-PDF fallback: render each page to a PNG via @napi-rs/canvas, OCR. */
async function ocrPdf(buffer: Buffer): Promise<string> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { createCanvas } = await import('@napi-rs/canvas')
    const pdf = await getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
    } as any).promise
    const out: string[] = []
    // Cap pages to keep OCR time bounded; a 50-page scanned doc would be 8+ min.
    const maxPages = Math.min(pdf.numPages, 30)
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 2 })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx as any, viewport }).promise
      const png = canvas.toBuffer('image/png')
      out.push(await extractImageText(png))
      page.cleanup()
    }
    await pdf.cleanup()
    await pdf.destroy()
    return out.join('\n\n').trim()
  } catch {
    return ''
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ buffer })
  return (result.value || '').trim()
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  // Swapped off SheetJS (`xlsx`) after the prototype-pollution + ReDoS
  // CVE — no npm fix available since SheetJS pulled itself from the
  // registry. ExcelJS is the maintained drop-in for the spreadsheet-
  // reading slice we use here (we only flatten cells into CSV, no
  // formula evaluation or chart parsing).
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const out: string[] = []
  for (const sheet of wb.worksheets) {
    out.push(`# ${sheet.name}`)
    const lines: string[] = []
    // `eachRow({ includeEmpty: false })` skips blank rows so empty
    // bottom padding (very common in human-edited sheets) doesn't
    // bloat the extracted text or the embedding budget.
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // `row.values` is 1-indexed and starts with `undefined` at [0];
      // slice it off and stringify each cell. ExcelJS hands back
      // rich types (Date, Hyperlink {text,href}, formula objects);
      // collapse to the human-readable form.
      const cells = (row.values as unknown[]).slice(1).map(stringifyCell)
      // Quote any cell that contains a comma / quote / newline so
      // the output is RFC-4180-ish — same as XLSX.utils.sheet_to_csv
      // produced.
      lines.push(cells.map(csvQuote).join(','))
    })
    out.push(lines.join('\n'))
  }
  return out.join('\n\n').trim()
}

function stringifyCell(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }> }
    // Hyperlink cell: { text, hyperlink }
    if (typeof o.text === 'string') return o.text
    // Formula cell: { formula, result }
    if (o.result != null) return stringifyCell(o.result)
    // Rich-text cell: { richText: [{ text, font }, ...] }
    if (Array.isArray(o.richText)) {
      return o.richText.map((r) => r?.text ?? '').join('')
    }
  }
  return String(v)
}

function csvQuote(s: string): string {
  if (s === '') return ''
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function extractHtml(buffer: Buffer): string {
  // Cheap HTML stripper. Handles 90% of clean docs; for snapshot HTML with
  // navigation chrome, callers should pre-clean (e.g., via Readability).
  const html = buffer.toString('utf8')
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}
