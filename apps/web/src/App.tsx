import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Sun, Moon, Loader2, Search as SearchIcon } from 'lucide-react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { ApiError, api, type PublicUser } from './lib/api'
import { useTheme } from './hooks/useTheme'
import { AuthScreen } from './components/AuthScreen'
import { UserMenu } from './components/UserMenu'
import { VaultView } from './components/VaultView'
import { AdminPanel } from './components/AdminPanel'
import { SearchPalette } from './components/SearchPalette'
import { UploadDialog } from './components/UploadDialog'
import { PublicFileView } from './components/PublicFileView'
import { VaultContext } from './lib/vault-context'

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'anonymous-locked' }
  | { status: 'authed'; user: PublicUser }

export default function App() {
  const { theme, toggle } = useTheme()
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null)
  const [currentFolder, setCurrentFolder] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const location = useLocation()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    api
      .me()
      .then((r) => setAuth({ status: 'authed', user: r.user }))
      .catch(() => setAuth({ status: 'anonymous' }))
  }, [])

  const handleLogout = async () => {
    try {
      await api.logout()
    } catch {
      /* swallow */
    }
    setAuth({ status: 'anonymous' })
  }

  const refresh = useCallback(() => {
    setVaultError(null)
    setRefreshNonce((n) => n + 1)
  }, [])

  const doUpload = useCallback(async (arr: File[], dir: string) => {
    for (const file of arr) {
      setUploadingName(file.name)
      try {
        await api.upload(file, { dir })
      } catch (e) {
        setVaultError(e instanceof ApiError ? e.message : String(e))
        break
      }
    }
    setUploadingName(null)
    setRefreshNonce((n) => n + 1)
  }, [])

  const uploadFiles = useCallback(
    async (files: FileList | File[], dir?: string) => {
      const arr = Array.from(files)
      if (arr.length === 0) return
      if (dir != null) {
        await doUpload(arr, dir)
        return
      }
      setPendingFiles(arr)
    },
    [doUpload],
  )

  const triggerUpload = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const triggerNewFolder = useCallback(async () => {
    const name = window.prompt('Folder name (use "/" for nesting, e.g. "notes/2026"):')
    if (!name) return
    const clean = name.trim().replace(/^\/+|\/+$/g, '')
    if (!clean) return
    try {
      await api.mkdir(clean)
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      setVaultError(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  if (auth.status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-[13px] text-muted">Loading…</div>
      </div>
    )
  }

  if (auth.status === 'anonymous') {
    // If the user is hitting a /docs/... URL, attempt to render it as a public file
    // before falling back to the auth wall.
    const publicPath =
      location.pathname.startsWith('/docs/')
        ? decodeURIComponent(location.pathname.slice('/docs/'.length))
        : null
    if (publicPath) {
      return (
        <PublicFileView
          key={publicPath}
          path={publicPath}
          onNotPublic={() => setAuth({ status: 'anonymous-locked' })}
        />
      )
    }
    return <AuthScreen onAuthed={(user) => setAuth({ status: 'authed', user })} />
  }

  if (auth.status === 'anonymous-locked') {
    return <AuthScreen onAuthed={(user) => setAuth({ status: 'authed', user })} />
  }

  return (
    <VaultContext.Provider
      value={{
        triggerUpload,
        uploadFiles,
        triggerNewFolder,
        refresh,
        refreshNonce,
        uploadingName,
        vaultError,
        clearError: () => setVaultError(null),
        currentFolder,
        setCurrentFolder,
      }}
    >
      <div className="h-full flex flex-col surface">
        <header
          className="h-12 flex items-center gap-3 px-3 border-b border-app shrink-0"
          style={{ background: 'var(--panel-2)' }}
        >
          <Link to="/" className="flex items-center gap-2 pl-1 pr-2 hover:bg-hover rounded transition-colors h-8">
            <FileText size={16} className="text-accent" />
            <span className="text-[13px] font-semibold tracking-tight text-fg">Reader</span>
          </Link>

          <div className="flex-1" />

          {uploadingName && (
            <span className="text-[12px] text-muted inline-flex items-center gap-1.5 mr-1">
              <Loader2 size={12} className="animate-spin text-accent" />
              <span className="truncate max-w-[180px]">{uploadingName}</span>
            </span>
          )}

          <button
            className="btn-ghost inline-flex items-center gap-1.5 pr-2"
            onClick={() => setPaletteOpen(true)}
            title="Open command palette (⌘K)"
          >
            <SearchIcon size={13} />
            <kbd
              className="text-[10px] px-1 py-0.5 rounded font-mono"
              style={{ background: 'var(--panel)', color: 'var(--fg-subtle)', border: '1px solid var(--border-soft)' }}
            >
              ⌘K
            </kbd>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files)
              e.target.value = ''
            }}
          />

          <button className="btn-ghost" onClick={toggle} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
            {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
          </button>

          <UserMenu user={auth.user} onLogout={handleLogout} />
        </header>

        <Routes>
          <Route path="/" element={<VaultView />} />
          <Route path="/docs/*" element={<VaultView />} />
          {auth.user.role === 'admin' && <Route path="/settings" element={<AdminPanel />} />}
          <Route path="*" element={<VaultView />} />
        </Routes>

        <SearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        {pendingFiles && (
          <UploadDialog
            files={pendingFiles}
            defaultDir={currentFolder}
            onCancel={() => setPendingFiles(null)}
            onConfirm={async (dir) => {
              const files = pendingFiles
              setPendingFiles(null)
              await doUpload(files, dir)
            }}
          />
        )}
      </div>
    </VaultContext.Provider>
  )
}

