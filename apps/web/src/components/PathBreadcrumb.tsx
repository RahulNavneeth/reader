import {
  ChevronLeft,
  Folder,
  Library,
  FileText,
  FileType,
  FileImage,
  FileSpreadsheet,
  FileCode,
} from 'lucide-react'

type Props = {
  /** Folder path (vault-relative) used to render breadcrumb chain. "" = root. */
  dir: string
  /** When rendering a file's location, pass the filename — shown as the active non-clickable crumb. */
  currentName?: string
  /** Click on a crumb or the Vault link. */
  onNavigate: (dir: string) => void
  /** Click on the back chevron. Disabled if omitted. */
  onBack?: () => void
}

export function PathBreadcrumb({ dir, currentName, onNavigate, onBack }: Props) {
  const parts = dir
    ? dir.split('/').filter(Boolean).map((name, idx, arr) => ({
        name,
        path: arr.slice(0, idx + 1).join('/'),
      }))
    : []

  const canGoBack = !!onBack && (dir.length > 0 || !!currentName)

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <button
        className="btn-ghost h-7 w-7 px-0 shrink-0"
        disabled={!canGoBack}
        style={{ opacity: canGoBack ? 1 : 0.35 }}
        onClick={() => onBack?.()}
        title="Up one level"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        className="text-[12.5px] font-medium hover:underline text-fg inline-flex items-center gap-1.5"
        onClick={() => onNavigate('')}
      >
        <Library size={13} className="text-accent" />
        Vault
      </button>
      {parts.map((p) => (
        <span key={p.path} className="flex items-center gap-1.5 min-w-0">
          <span className="text-subtle">/</span>
          <button
            className="text-[12.5px] font-medium text-fg hover:underline truncate max-w-[200px] inline-flex items-center gap-1.5"
            onClick={() => onNavigate(p.path)}
          >
            <Folder size={13} className="text-accent shrink-0" />
            <span className="truncate">{p.name}</span>
          </button>
        </span>
      ))}
      {currentName && (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-subtle">/</span>
          <span className="text-[12.5px] font-semibold text-fg truncate inline-flex items-center gap-1.5">
            <FileIcon name={currentName} />
            <span className="truncate">{currentName}</span>
          </span>
        </span>
      )}
    </div>
  )
}

function FileIcon({ name }: { name: string }) {
  const i = name.lastIndexOf('.')
  const ext = i >= 0 ? name.slice(i).toLowerCase() : ''
  const props = { size: 13, className: 'shrink-0' } as const
  if (ext === '.pdf') return <FileType {...props} style={{ color: '#BF2600' }} />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext))
    return <FileImage {...props} className="shrink-0 text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(ext))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(ext))
    return <FileCode {...props} className="shrink-0 text-subtle" />
  return <FileText {...props} className="shrink-0 text-accent" />
}
