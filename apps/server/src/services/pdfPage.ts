/**
 * Per-page PDF extraction. The ingest pipeline already extracts the
 * full text up-front for search (see services/extract.ts) but flattens
 * it across page boundaries. These helpers re-open the source file
 * on demand when an MCP tool needs a SINGLE page — e.g. an agent
 * paging through a long PDF chunk-by-chunk without dumping the whole
 * extracted blob.
 *
 * Implementation reuses the same pdfjs-dist legacy build the ingest
 * path uses; no new deps.
 */
import { readFile } from 'node:fs/promises'

/** PDF.js load options pinned to "safe for Node.js" (no worker, no
 *  system fonts, no eval). Same defaults as services/extract.ts. */
async function loadPdf(absPath: string) {
  const buf = await readFile(absPath)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
  } as any).promise
}

export async function getPdfPageCount(absPath: string): Promise<number> {
  const pdf = await loadPdf(absPath)
  const n = pdf.numPages
  await pdf.cleanup()
  await pdf.destroy()
  return n
}

/** Return one page's text. Pages are 1-indexed (matches the PDF
 *  spec + every PDF reader UI). Throws on out-of-range page. */
export async function getPdfPageText(
  absPath: string,
  pageNum: number,
): Promise<{ page: number; pageCount: number; text: string }> {
  const pdf = await loadPdf(absPath)
  try {
    const pageCount = pdf.numPages
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pageCount) {
      throw Object.assign(
        new Error(`page ${pageNum} out of range (1..${pageCount})`),
        { statusCode: 400 },
      )
    }
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const text = (content.items as Array<{ str?: string }>)
      .map((item) => item.str ?? '')
      .join(' ')
      .trim()
    page.cleanup()
    return { page: pageNum, pageCount, text }
  } finally {
    await pdf.cleanup()
    await pdf.destroy()
  }
}
