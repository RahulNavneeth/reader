/**
 * Tab favicon swaps based on file extension.
 *
 * Icons are SVG copies of the matching `lucide-react` glyphs we already use in
 * `PathBreadcrumb` and `FolderGrid`, so the tab icon visually matches the
 * sidebar/grid icon for the same file type.
 */

type IconDef = { paths: string; circles?: string; color: string }

// Common file frame used by every file-type lucide icon: rectangle with the
// folded corner. The contents (lines, grid, image circle, etc.) are appended.
const FRAME = `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`

const ICONS: Record<string, IconDef> = {
  // FileType (red) — PDF
  pdf: {
    paths: FRAME + `<path d="M9 13v-1h6v1"/><path d="M12 12v6"/><path d="M11 18h2"/>`,
    color: '#BF2600',
  },
  // FileImage (muted) — images
  image: {
    paths: FRAME + `<path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>`,
    circles: `<circle cx="10" cy="12" r="2"/>`,
    color: '#6B778C',
  },
  // FileSpreadsheet (green) — xlsx/xls/csv
  spreadsheet: {
    paths: FRAME + `<path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>`,
    color: '#00875A',
  },
  // FileCode (subtle) — json/yaml/toml/html
  code: {
    paths: FRAME + `<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>`,
    color: '#6B778C',
  },
  // FileText (accent blue) — markdown / txt / fallback
  text: {
    paths: FRAME + `<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
    color: '#0052CC',
  },
}

function iconFor(filename: string): IconDef {
  const i = filename.lastIndexOf('.')
  const ext = i >= 0 ? filename.slice(i).toLowerCase() : ''
  if (ext === '.pdf') return ICONS.pdf
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) return ICONS.image
  if (['.xlsx', '.xls', '.csv'].includes(ext)) return ICONS.spreadsheet
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(ext)) return ICONS.code
  return ICONS.text
}

function svgDataUri({ paths, circles, color }: IconDef): string {
  const inner = (circles ?? '') + paths
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function setFaviconHref(href: string): void {
  const head = document.head
  head.querySelectorAll("link[rel~='icon']").forEach((el) => el.parentElement?.removeChild(el))
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = href
  head.appendChild(link)
}

let defaultFaviconCache: string | null = null
function captureDefaultFavicon(): string {
  if (defaultFaviconCache !== null) return defaultFaviconCache
  const link = document.head.querySelector<HTMLLinkElement>("link[rel~='icon']")
  defaultFaviconCache = link?.href ?? ''
  return defaultFaviconCache
}

/** Set the tab favicon to match `filename`. Returns a restore function. */
export function setFaviconForFile(filename: string): () => void {
  const previous = captureDefaultFavicon()
  setFaviconHref(svgDataUri(iconFor(filename)))
  return () => {
    if (previous) setFaviconHref(previous)
  }
}
