import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderOpen, Search, Sun, Moon, ChevronRight, RefreshCw, Home } from 'lucide-react'
import clsx from 'clsx'
import { api } from './lib/api'
import { useTheme } from './hooks/useTheme'
import type { TreeNode, Heading } from './types'
import { TreeBranch } from './components/TreeBranch'
import { DocView } from './components/DocView'
import { TOC } from './components/TOC'
import { SearchOverlay } from './components/SearchOverlay'
import { RootPicker } from './components/RootPicker'

const ROOT_KEY = 'mdr.root'
const FILE_KEY = 'mdr.lastFile'
const SIDEBAR_KEY = 'mdr.sidebar'

export default function App() {
  const { theme, toggle } = useTheme()
  const [root, setRoot] = useState<string | null>(() => localStorage.getItem(ROOT_KEY))
  const [tree, setTree] = useState<TreeNode[]>([])
  const [openFile, setOpenFile] = useState<string | null>(() => localStorage.getItem(FILE_KEY))
  const [content, setContent] = useState<string>('')
  const [contentError, setContentError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [activeHeading, setActiveHeading] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(SIDEBAR_KEY))
    return Number.isFinite(v) && v >= 200 ? v : 280
  })
  const [refreshKey, setRefreshKey] = useState(0)

  // Load tree when root changes
  useEffect(() => {
    if (!root) return
    api
      .list(root, root)
      .then((r) => setTree(r.items))
      .catch((e) => console.error('list failed', e))
  }, [root, refreshKey])

  // Load file when openFile changes
  useEffect(() => {
    if (!openFile || !root) {
      setContent('')
      return
    }
    api
      .file(openFile, root)
      .then((r) => {
        setContent(r.content)
        setContentError(null)
        localStorage.setItem(FILE_KEY, openFile)
      })
      .catch((e) => {
        setContent('')
        setContentError(e.message || String(e))
      })
  }, [openFile, root])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (meta && e.key === 'b') {
        e.preventDefault()
        setSidebarWidth((w) => (w === 0 ? 280 : 0))
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Persist sidebar width
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  const breadcrumbs = useMemo(() => {
    if (!openFile || !root) return []
    if (!openFile.startsWith(root)) return [openFile]
    const rel = openFile.slice(root.length).replace(/^\/+/, '')
    return rel.split('/')
  }, [openFile, root])

  const handleSelectRoot = (newRoot: string) => {
    setRoot(newRoot)
    localStorage.setItem(ROOT_KEY, newRoot)
    setOpenFile(null)
    localStorage.removeItem(FILE_KEY)
  }

  const handleSelectFile = (path: string) => {
    setOpenFile(path)
    setSearchOpen(false)
  }

  // Drag-to-resize sidebar
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (m: MouseEvent) => {
      if (!dragRef.current) return
      const w = Math.max(0, Math.min(560, dragRef.current.startW + (m.clientX - dragRef.current.startX)))
      setSidebarWidth(w < 160 ? 0 : w)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!root) {
    return <RootPicker onSelect={handleSelectRoot} />
  }

  return (
    <div className="h-full flex flex-col surface">
      {/* Top bar */}
      <header
        className="h-12 flex items-center gap-2 px-3 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <div className="flex items-center gap-2 pl-1 pr-3 mr-1 border-r border-soft" style={{ borderColor: 'var(--border-soft)' }}>
          <FileText size={16} className="text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-fg">Reader</span>
        </div>

        <button
          className="btn-ghost"
          title="Change root folder"
          onClick={() => {
            localStorage.removeItem(ROOT_KEY)
            setRoot(null)
          }}
        >
          <Home size={14} />
          <span className="truncate max-w-[260px]">{root.replace(/^.*\//, '') || root}</span>
        </button>

        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-1 text-[12.5px] text-muted overflow-hidden">
            <ChevronRight size={12} className="shrink-0" />
            {breadcrumbs.map((p, i) => (
              <span key={i} className="flex items-center gap-1 min-w-0">
                <span className={clsx('truncate', i === breadcrumbs.length - 1 && 'text-fg font-medium')}>{p}</span>
                {i < breadcrumbs.length - 1 && <ChevronRight size={12} className="shrink-0 text-subtle" />}
              </span>
            ))}
          </div>
        )}

        <div className="flex-1" />

        <button className="btn-ghost" onClick={() => setSearchOpen(true)} title="Search (⌘K)">
          <Search size={14} />
          Search
          <span className="kbd ml-1">⌘K</span>
        </button>

        <button className="btn-ghost" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh tree">
          <RefreshCw size={14} />
        </button>

        <button className="btn-ghost" onClick={toggle} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
          {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        {sidebarWidth > 0 && (
          <>
            <aside
              className="panel border-r border-app overflow-y-auto shrink-0"
              style={{ width: sidebarWidth }}
            >
              <div className="px-3 pt-3 pb-1.5 text-[11px] uppercase tracking-wider text-subtle font-semibold flex items-center justify-between">
                <span>Files</span>
                <span className="text-subtle font-normal normal-case tracking-normal">{tree.length} item{tree.length === 1 ? '' : 's'}</span>
              </div>
              <div className="px-1 pb-3">
                {tree.length === 0 ? (
                  <div className="px-3 py-2 text-[12.5px] text-muted">No markdown files in this folder.</div>
                ) : (
                  tree.map((node) => (
                    <TreeBranch
                      key={node.path}
                      node={node}
                      depth={0}
                      root={root}
                      selectedPath={openFile}
                      onSelectFile={handleSelectFile}
                    />
                  ))
                )}
              </div>
            </aside>
            <div
              className="w-px hover:w-1 transition-all cursor-col-resize shrink-0"
              style={{ background: 'var(--border)' }}
              onMouseDown={onDragStart}
            />
          </>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          {!openFile ? (
            <EmptyState />
          ) : contentError ? (
            <div className="px-10 py-10 text-muted">
              <div className="text-fg font-semibold mb-1">Couldn't open this file</div>
              <div className="text-[13px]">{contentError}</div>
            </div>
          ) : (
            <DocView
              content={content}
              onHeadings={setHeadings}
              onActiveHeading={setActiveHeading}
            />
          )}
        </main>

        {/* TOC */}
        {openFile && headings.length > 0 && (
          <aside
            className="hidden xl:block w-60 shrink-0 border-l border-app overflow-y-auto"
            style={{ background: 'var(--bg)' }}
          >
            <TOC headings={headings} active={activeHeading} />
          </aside>
        )}
      </div>

      {searchOpen && (
        <SearchOverlay
          root={root}
          onClose={() => setSearchOpen(false)}
          onPick={(p) => handleSelectFile(p)}
        />
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3" style={{ background: 'var(--panel)' }}>
          <FolderOpen size={22} className="text-accent" />
        </div>
        <div className="text-fg font-semibold">No document open</div>
        <div className="text-[13px] text-muted mt-1">Pick a file from the sidebar, or press <span className="kbd">⌘K</span> to search.</div>
      </div>
    </div>
  )
}

