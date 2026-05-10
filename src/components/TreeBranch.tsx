import { useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../lib/api'
import type { TreeNode } from '../types'

type Props = {
  node: TreeNode
  depth: number
  root: string
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

export function TreeBranch({ node, depth, root, selectedPath, onSelectFile }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<TreeNode[] | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = async () => {
    if (node.type !== 'dir') return
    const next = !expanded
    setExpanded(next)
    if (next && children === null) {
      setLoading(true)
      try {
        const r = await api.list(node.path, root)
        setChildren(r.items)
      } catch (e) {
        console.error(e)
        setChildren([])
      } finally {
        setLoading(false)
      }
    }
  }

  const isSelected = node.type === 'file' && selectedPath === node.path

  return (
    <div>
      <div
        className={clsx('tree-item', isSelected && 'selected')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={node.type === 'dir' ? toggle : () => onSelectFile(node.path)}
      >
        {node.type === 'dir' ? (
          <>
            {expanded ? <ChevronDown size={13} className="text-subtle" /> : <ChevronRight size={13} className="text-subtle" />}
            {expanded ? <FolderOpen size={14} className="text-accent" /> : <Folder size={14} className="text-muted" />}
          </>
        ) : (
          <>
            <span className="w-[13px] inline-block" />
            <FileText size={14} className={clsx(isSelected ? 'text-accent' : 'text-subtle')} />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {expanded && (
        <div>
          {loading && <div className="text-[12px] text-subtle px-2 py-1" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>Loading…</div>}
          {children && children.length === 0 && !loading && (
            <div className="text-[12px] text-subtle px-2 py-1" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>Empty</div>
          )}
          {children?.map((c) => (
            <TreeBranch
              key={c.path}
              node={c}
              depth={depth + 1}
              root={root}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
