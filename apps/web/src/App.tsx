import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Sun, Moon, Loader2, Search as SearchIcon } from 'lucide-react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { ApiError, api, type PublicUser } from './lib/api'
import { useTheme } from './hooks/useTheme'
import { AuthScreen } from './components/AuthScreen'
import { UserMenu } from './components/UserMenu'
import { VaultView } from './components/VaultView'
import { AdminPanel } from './components/AdminPanel'
import { AccountPage } from './components/AccountPage'
import { AccountTokensPage } from './components/AccountTokensPage'
import { AccountWebhooksPage } from './components/AccountWebhooksPage'
import { MountBrowser } from './components/MountBrowser'
import { TrashPage } from './components/TrashPage'
import { SearchPalette } from './components/SearchPalette'
import { UploadDialog } from './components/UploadDialog'
import { PublicResolver } from './components/PublicResolver'
import { VaultContext } from './lib/vault-context'
import { useReaderEvents } from './lib/events'

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'anonymous-locked' }
  | { status: 'authed'; user: PublicUser }

export default function App() {
  const { theme, toggle } = useTheme()
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null)
  const [currentFolder, setCurrentFolder] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const location = useLocation()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen(true)
        // Defer so the input is mounted/visible before we focus it.
        setTimeout(() => searchInputRef.current?.focus(), 0)
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

  // Live updates: refresh the vault tree (and any open grid) whenever the
  // server publishes a corpus mutation. Mounted at the app root so a single
  // EventSource serves every page; only active when the user is signed in.
  const onEvent = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])
  useReaderEvents(onEvent, auth.status === 'authed')

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
    // Bare-path public URLs: `/` for a public vault root, `/<path>` for
    // any public file or folder. Reserved root segments are app routes
    // that can't be vault items.
    const RESERVED = new Set(['settings', 'account', 'library', 'trash'])
    const rawPath = decodeURIComponent(location.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
    const firstSeg = rawPath.split('/')[0] ?? ''
    const isReserved = RESERVED.has(firstSeg) || firstSeg === 'tags'
    if (!isReserved) {
      return (
        <PublicResolver
          key={rawPath}
          path={rawPath}
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
        currentUsername: auth.user.username,
      }}
    >
      <div className="h-full flex flex-col surface">
        <header
          className="h-12 flex items-center px-3 border-b border-app shrink-0"
          style={{ background: 'var(--panel-2)' }}
        >
          {/* Three equal thirds: logo on the left, search dead-center,
              uploads + theme + user on the right. Each section gets
              w-1/3 so the search input stays anchored to the viewport
              center regardless of the side widths. */}
          <div className="w-1/3 flex items-center">
            <Link
              to="/"
              className="flex items-center gap-2 pl-1 pr-2 hover:bg-hover rounded transition-colors h-8"
            >
              <FileText size={16} className="text-accent" />
              <span className="text-[13px] font-semibold tracking-tight text-fg">Reader</span>
            </Link>
          </div>

          <div className="w-1/3 flex items-center justify-center">
            <div className="relative z-50 w-full max-w-[640px]">
              <SearchIcon
                size={13}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
              />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  if (!paletteOpen) setPaletteOpen(true)
                }}
                onFocus={() => setPaletteOpen(true)}
                placeholder="Search vault…"
                className="w-full h-8 pl-8 pr-12 rounded text-[12.5px] text-fg placeholder:text-subtle outline-none transition-colors"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border-soft)',
                }}
              />
              <kbd
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] px-1 py-0.5 rounded shrink-0 pointer-events-none"
                style={{
                  background: 'var(--panel)',
                  color: 'var(--fg-subtle)',
                  border: '1px solid var(--border-soft)',
                }}
              >
                ⌘K
              </kbd>
              <SearchPalette
                open={paletteOpen}
                query={searchQuery}
                onClose={() => setPaletteOpen(false)}
                inputRef={searchInputRef}
              />
            </div>
          </div>

          <div className="w-1/3 flex items-center justify-end gap-2">
            {uploadingName && (
              <span className="text-[12px] text-muted inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin text-accent" />
                <span className="truncate max-w-[180px]">{uploadingName}</span>
              </span>
            )}

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

            <button
              className="btn-ghost"
              onClick={toggle}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            >
              {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
            </button>

            <UserMenu user={auth.user} onLogout={handleLogout} />
          </div>
        </header>

        <Routes>
          <Route path="/" element={<VaultView />} />
          <Route path="/tags/:tag" element={<VaultView />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/account/tokens" element={<AccountTokensPage />} />
          <Route path="/account/webhooks" element={<AccountWebhooksPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/library/:mountId/*" element={<MountBrowser />} />
          <Route path="/library/:mountId" element={<MountBrowser />} />
          {auth.user.role === 'admin' && <Route path="/settings" element={<AdminPanel />} />}
          <Route path="*" element={<VaultView />} />
        </Routes>

        {paletteOpen && (
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(9, 30, 66, 0.42)' }}
            onClick={() => setPaletteOpen(false)}
          />
        )}

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

