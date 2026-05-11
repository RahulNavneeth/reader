import { useEffect, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileType,
  FileImage,
  FileSpreadsheet,
  FileCode,
  Sparkles,
} from 'lucide-react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import { api, type VaultNode } from '../lib/api'
import { useVault } from '../lib/vault-context'

type Props = {
  node: VaultNode
  depth: number
  selectedPath: string | null
}

export function VaultTree({ node, depth, selectedPath }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<VaultNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { refreshNonce } = useVault()

  const isSelected = node.type === 'file' && selectedPath === node.path

  const loadChildren = async () => {
    setLoading(true)
    try {
      const r = await api.list(node.path)
      setChildren(r.items)
    } catch (e) {
      console.error(e)
      setChildren([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (node.type !== 'dir' || !expanded) return
    loadChildren()
    // refetch whenever the global refreshNonce bumps (after uploads, mkdir, etc.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce, expanded])

  const onClick = async () => {
    if (node.type === 'dir') {
      const next = !expanded
      setExpanded(next)
      if (next && children === null) {
        await loadChildren()
      }
    } else {
      navigate(`/docs/${node.path.split('/').map(encodeURIComponent).join('/')}`)
    }
  }

  return (
    <div>
      <div
        className={clsx('tree-item', isSelected && 'selected')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
      >
        {node.type === 'dir' ? (
          <>
            {expanded ? (
              <ChevronDown size={13} className="text-subtle" />
            ) : (
              <ChevronRight size={13} className="text-subtle" />
            )}
            {expanded ? (
              <FolderOpen size={14} className="text-accent" />
            ) : (
              <Folder size={14} className="text-muted" />
            )}
          </>
        ) : (
          <>
            <span className="w-[13px] inline-block" />
            <TypeIcon ext={node.ext} selected={isSelected} />
          </>
        )}
        <span className="truncate flex-1">{node.name}</span>
        {node.type === 'file' && node.embedded && (
          <Sparkles size={11} className="text-accent shrink-0" aria-label="indexed for AI search" />
        )}
      </div>
      {expanded && (
        <div>
          {loading && (
            <div
              className="text-[12px] text-subtle px-2 py-1"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              Loading…
            </div>
          )}
          {children && children.length === 0 && !loading && (
            <div
              className="text-[12px] text-subtle px-2 py-1 italic"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              empty
            </div>
          )}
          {children?.map((c) => (
            <VaultTree key={c.path} node={c} depth={depth + 1} selectedPath={selectedPath} />
          ))}
        </div>
      )}
    </div>
  )
}

function TypeIcon({ ext, selected }: { ext?: string; selected: boolean }) {
  const cls = clsx('shrink-0', selected ? 'text-accent' : 'text-subtle')
  const e = (ext || '').toLowerCase()
  if (e === '.pdf') return <FileType size={14} className={clsx('shrink-0', selected ? 'text-accent' : 'text-muted')} />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(e))
    return <FileImage size={14} className={clsx('shrink-0', selected ? 'text-accent' : 'text-muted')} />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet size={14} className={clsx('shrink-0', selected ? 'text-accent' : 'text-muted')} style={{ color: selected ? undefined : '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(e))
    return <FileCode size={14} className={cls} />
  return <FileText size={14} className={cls} />
}
