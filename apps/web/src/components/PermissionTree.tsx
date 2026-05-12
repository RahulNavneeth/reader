import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  FileType,
  FileImage,
  FileSpreadsheet,
  FileCode,
  Search,
  X,
} from 'lucide-react'
import { api, type Grant } from '../lib/api'

type Props = {
  grants: Grant[]
  onChange: (next: Grant[]) => void
}

type Node = {
  path: string
  name: string
  kind: 'dir' | 'file'
  children: Node[]
}

function buildTree(folders: string[], files: string[]): Node {
  const root: Node = { path: '', name: '(vault root)', kind: 'dir', children: [] }
  const ensureDir = (parts: string[]): Node => {
    let cur = root
    for (let i = 0; i < parts.length; i++) {
      const acc = parts.slice(0, i + 1).join('/')
      let child = cur.children.find((c) => c.path === acc && c.kind === 'dir')
      if (!child) {
        child = { path: acc, name: parts[i], kind: 'dir', children: [] }
        cur.children.push(child)
      }
      cur = child
    }
    return cur
  }
  for (const p of folders) ensureDir(p.split('/').filter(Boolean))
  for (const fp of files) {
    const parts = fp.split('/').filter(Boolean)
    const name = parts.pop()!
    const parent = ensureDir(parts)
    parent.children.push({ path: fp, name, kind: 'file', children: [] })
  }
  const sortNodes = (n: Node) => {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    for (const c of n.children) sortNodes(c)
  }
  sortNodes(root)
  return root
}

export function PermissionTree({ grants, onChange }: Props) {
  const [tree, setTree] = useState<Node | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [query, setQuery] = useState('')

  useEffect(() => {
    api
      .vaultTree()
      .then((r) => setTree(buildTree(r.folders, r.files)))
      .catch((e) => setError(e?.message ?? String(e)))
  }, [])

  // When filtering, auto-expand every dir on a matching path so users can see
  // their target. The expanded set is recomputed (without persisting back so
  // clearing the search restores manual expansion state).
  const { visibleTree, autoExpanded } = useMemo(() => {
    if (!tree) return { visibleTree: null as Node | null, autoExpanded: new Set<string>() }
    const q = query.trim().toLowerCase()
    if (!q) return { visibleTree: tree, autoExpanded: new Set<string>() }
    const auto = new Set<string>([''])
    const filter = (node: Node): Node | null => {
      const selfMatch = node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)
      const filteredChildren: Node[] = []
      for (const c of node.children) {
        const f = filter(c)
        if (f) filteredChildren.push(f)
      }
      if (selfMatch || filteredChildren.length > 0) {
        if (node.kind === 'dir') auto.add(node.path)
        return { ...node, children: selfMatch ? node.children : filteredChildren }
      }
      return null
    }
    const root = filter(tree) ?? { ...tree, children: [] }
    return { visibleTree: root, autoExpanded: auto }
  }, [tree, query])

  const grantFor = (path: string): Grant | null => grants.find((g) => g.path === path) || null

  const setOp = (path: string, op: 'read' | 'write' | 'create', value: boolean) => {
    const idx = grants.findIndex((g) => g.path === path)
    let next: Grant[]
    if (idx === -1) {
      next = [...grants, { path, read: false, write: false, create: false, [op]: value }]
    } else {
      const g = grants[idx]
      const updated = { ...g, [op]: value }
      if (!updated.read && !updated.write && !updated.create) {
        next = grants.filter((_, i) => i !== idx)
      } else {
        next = grants.map((g2, i) => (i === idx ? updated : g2))
      }
    }
    onChange(next)
  }

  const toggle = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (error) return <div className="text-[12.5px]" style={{ color: '#BF2600' }}>{error}</div>
  if (!tree || !visibleTree) return <div className="text-[12.5px] text-muted">Loading…</div>

  const effectiveExpanded = query.trim() ? new Set([...expanded, ...autoExpanded]) : expanded

  return (
    <div>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
        <input
          className="input pl-7 h-7 text-[12px]"
          placeholder="Search folders or files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            className="absolute right-1.5 top-1/2 -translate-y-1/2 btn-ghost h-5 w-5 px-0"
            onClick={() => setQuery('')}
          >
            <X size={10} />
          </button>
        )}
      </div>
      <div
        className="grid grid-cols-[1fr_60px_60px_60px] gap-2 px-2 h-6 items-center text-[10px] uppercase tracking-wider font-semibold text-subtle border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <span>Path</span>
        <span className="text-center">Read</span>
        <span className="text-center">Write</span>
        <span className="text-center">Create</span>
      </div>
      <div className="max-h-[360px] overflow-y-auto py-0.5">
        <Row
          node={visibleTree}
          depth={0}
          isExpanded={effectiveExpanded.has('')}
          onToggle={() => toggle('')}
          grant={grantFor('')}
          setOp={(op, v) => setOp('', op, v)}
        />
        {effectiveExpanded.has('') && (
          <Branch
            node={visibleTree}
            depth={1}
            expanded={effectiveExpanded}
            toggle={toggle}
            grantFor={grantFor}
            setOp={setOp}
          />
        )}
      </div>
    </div>
  )
}

function Branch({
  node,
  depth,
  expanded,
  toggle,
  grantFor,
  setOp,
}: {
  node: Node
  depth: number
  expanded: Set<string>
  toggle: (p: string) => void
  grantFor: (p: string) => Grant | null
  setOp: (p: string, op: 'read' | 'write' | 'create', v: boolean) => void
}) {
  return (
    <>
      {node.children.map((c) => {
        const isExp = expanded.has(c.path)
        return (
          <div key={c.path}>
            <Row
              node={c}
              depth={depth}
              isExpanded={isExp}
              onToggle={() => toggle(c.path)}
              grant={grantFor(c.path)}
              setOp={(op, v) => setOp(c.path, op, v)}
            />
            {isExp && c.children.length > 0 && (
              <Branch
                node={c}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                grantFor={grantFor}
                setOp={setOp}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

function Row({
  node,
  depth,
  isExpanded,
  onToggle,
  grant,
  setOp,
}: {
  node: Node
  depth: number
  isExpanded: boolean
  onToggle: () => void
  grant: Grant | null
  setOp: (op: 'read' | 'write' | 'create', v: boolean) => void
}) {
  const expandable = node.kind === 'dir' && node.children.length > 0
  const isFile = node.kind === 'file'
  return (
    <div
      className="grid grid-cols-[1fr_60px_60px_60px] gap-2 items-center h-7 text-[12.5px]"
      style={{ paddingLeft: 8 + depth * 14, paddingRight: 12 }}
    >
      <div className="flex items-center gap-1 min-w-0">
        {expandable ? (
          <button onClick={onToggle} className="text-subtle hover:text-fg shrink-0">
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-3" />
        )}
        {isFile ? <FileGlyph name={node.name} /> : <Folder size={12} className="text-accent shrink-0" />}
        <span className="truncate">{node.name}</span>
      </div>
      <Box checked={!!grant?.read} onChange={(v) => setOp('read', v)} />
      <Box checked={!!grant?.write} onChange={(v) => setOp('write', v)} />
      <Box
        checked={!!grant?.create}
        onChange={(v) => setOp('create', v)}
        // "Create" only makes sense for folders.
        disabled={isFile}
      />
    </div>
  )
}

function Box({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex justify-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="cursor-pointer accent-blue-600"
        style={disabled ? { opacity: 0.25, cursor: 'not-allowed' } : undefined}
      />
    </div>
  )
}

function FileGlyph({ name }: { name: string }) {
  const i = name.lastIndexOf('.')
  const ext = i >= 0 ? name.slice(i).toLowerCase() : ''
  const props = { size: 12, className: 'shrink-0' } as const
  if (ext === '.pdf') return <FileType {...props} style={{ color: '#BF2600' }} />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext))
    return <FileImage {...props} className="shrink-0 text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(ext))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(ext))
    return <FileCode {...props} className="shrink-0 text-subtle" />
  return <FileText {...props} className="shrink-0 text-subtle" />
}
