import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Sun, Moon, Loader2, Search as SearchIcon, Menu } from 'lucide-react'
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
import { MapPage } from './components/MapPage'
import { TimelinePage } from './components/TimelinePage'
import { CollectionsPage } from './components/CollectionsPage'
import { CollectionDetailPage } from './components/CollectionDetailPage'
import { PublicCollectionPage } from './components/PublicCollectionPage'
import { NewFolderButton } from './components/NewFolderButton'
import { TrashPage } from './components/TrashPage'
import { SearchPalette } from './components/SearchPalette'
import { UploadButton } from './components/UploadButton'
import { PublicResolver } from './components/PublicResolver'
import { VaultContext } from './lib/vault-context'
import { useReaderEvents } from './lib/events'
import { useOnlineStatus } from './hooks/useOnlineStatus'

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'anonymous-locked' }
  | { status: 'authed'; user: PublicUser }

export default function App() {
  const { theme, toggle } = useTheme()
  const isOnline = useOnlineStatus()
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [uploadProgress, setUploadProgress] = useState<{
    done: number
    total: number
    current: string | null
    failed: Array<{ name: string; reason: string }>
  } | null>(null)
  // Live ref to upload state so the SSE handler can check it without
  // becoming a dep of the listener (which would rebind the
  // EventSource each upload tick).
  const uploadingRef = useRef(false)
  useEffect(() => {
    uploadingRef.current = uploadProgress != null
  }, [uploadProgress])

  // Coalesced refresh. Without this, an upload batch of 1000 files
  // publishes ~4× that many SSE events (upload + thumbnail + preview
  // + ingest each); each one triggered the sidebar to refetch 6 API
  // endpoints → continuous flicker AND racing against the upload
  // itself. Two layers:
  //   (a) While an upload is active we skip SSE bumps entirely. The
  //       batch-end explicit refresh is what the user sees.
  //   (b) Otherwise debounce to once per 750ms — fast enough for
  //       another tab's mutation to feel live, slow enough to never
  //       thrash.
  const bumpTimerRef = useRef<number | null>(null)
  const bumpRefresh = useCallback(() => {
    if (uploadingRef.current) return
    if (bumpTimerRef.current != null) return
    bumpTimerRef.current = window.setTimeout(() => {
      bumpTimerRef.current = null
      setRefreshNonce((n) => n + 1)
    }, 750)
  }, [])
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null)
  const [currentFolder, setCurrentFolder] = useState<string>('')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const location = useLocation()
  // Auto-close the mobile drawer whenever the route changes — otherwise
  // tapping a file in the sidebar leaves it covering the content.
  useEffect(() => {
    setMobileSidebarOpen(false)
  }, [location.pathname])

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

  // Auth just transitioned to authed → clear any "auth required"
  // toast left over from the brief restore window. Without this
  // guard, the 401 the sidebar caught moments earlier sticks in
  // state and the user sees a red banner even though they're now
  // signed in.
  useEffect(() => {
    if (auth.status === 'authed') setVaultError(null)
  }, [auth.status])

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
  // Routes through bumpRefresh so a flood of events compresses to one
  // refresh per frame instead of one re-render per event.
  useReaderEvents(bumpRefresh, auth.status === 'authed')

  const doUpload = useCallback(async (arr: File[], dir: string) => {
    // Don't abort the whole batch on one bad file — log it and move on.
    // Common cause is `file too large` (server cap, default 100MB) or
    // a server-side write error; the user wants the other 999 files
    // to still go through.
    const failed: Array<{ name: string; reason: string }> = []
    setUploadProgress({ done: 0, total: arr.length, current: arr[0]?.name ?? null, failed })
    for (let i = 0; i < arr.length; i++) {
      const file = arr[i]
      setUploadProgress({ done: i, total: arr.length, current: file.name, failed: [...failed] })
      try {
        await api.upload(file, { dir })
      } catch (e) {
        const reason = e instanceof ApiError ? e.message : String(e)
        failed.push({ name: file.name, reason })
      }
    }
    if (failed.length > 0) {
      const summary =
        failed.length === 1
          ? `Couldn't upload ${failed[0].name}: ${failed[0].reason}`
          : `${failed.length} of ${arr.length} files failed to upload. First error: ${failed[0].name} — ${failed[0].reason}`
      setVaultError(summary)
    }
    setUploadProgress(null)
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

  // Controlled open-state for the inline NewFolderButton popover.
  // The ⌘K palette (and anyone else with the vault context) calls
  // `triggerNewFolder` to flip this on, which pops the popover under
  // the header's FolderPlus icon — no modal dialog.
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const triggerNewFolder = useCallback(async () => {
    setNewFolderOpen(true)
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
    const RESERVED = new Set(['settings', 'account', 'library', 'trash', 'map', 'timeline', 'collections', 'c', 'pc'])
    const rawPath = decodeURIComponent(location.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
    const firstSeg = rawPath.split('/')[0] ?? ''
    const isReserved = RESERVED.has(firstSeg) || firstSeg === 'tags'
    // Public collections viewable while signed out — bypass the auth
    // screen entirely. The page itself negotiates password gating.
    if (firstSeg === 'pc') {
      return (
        <Routes>
          <Route path="/pc/:slug" element={<PublicCollectionPage />} />
          <Route path="*" element={<AuthScreen onAuthed={(user) => setAuth({ status: 'authed', user })} />} />
        </Routes>
      )
    }
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
        uploadProgress,
        vaultError,
        setVaultError,
        clearError: () => setVaultError(null),
        currentFolder,
        setCurrentFolder,
        currentUsername: auth.user.username,
        mobileSidebarOpen,
        setMobileSidebarOpen,
      }}
    >
      <div className="h-full flex flex-col surface">
        {!isOnline && (
          // Persistent offline banner. The service worker is still
          // serving cached doc reads (text/meta/raw) and the SPA
          // shell, so the user can browse cached content — but new
          // uploads / edits / chat won't reach the server. We keep
          // the message brief and non-modal: don't block, just warn.
          <div
            className="h-7 px-3 flex items-center justify-center gap-2 text-[11.5px] font-medium shrink-0"
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-fg)',
              borderBottom: '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
            }}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden>●</span>
            Offline — showing cached content. Edits and new uploads will fail until the server is reachable.
          </div>
        )}
        <header
          className="h-12 flex items-center px-3 border-b border-app shrink-0"
          style={{ background: 'var(--panel-2)' }}
        >
          {/* Three sections: logo + (mobile-only) hamburger on the
              left, search in the middle, actions on the right.
              md+: equal thirds keep the search anchored to the
              viewport center. Below md: search flexes to fill, logo
              loses its label, hamburger appears. */}
          <div className="flex items-center md:w-1/3 shrink-0">
            <button
              className="md:hidden inline-flex items-center justify-center w-8 h-8 rounded hover:bg-hover text-fg mr-1"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={16} />
            </button>
            <Link
              to="/"
              className="flex items-center gap-2 pl-1 pr-2 hover:bg-hover rounded transition-colors h-8"
            >
              <FileText size={16} className="text-accent" />
              <span className="hidden sm:inline text-[13px] font-semibold tracking-tight text-fg">
                Reader
              </span>
            </Link>
          </div>

          <div className="flex-1 md:w-1/3 flex items-center justify-center px-2">
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
                className="w-full h-8 pl-8 pr-[96px] rounded text-[12.5px] text-fg placeholder:text-subtle outline-none"
                style={{
                  background: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                }}
              />
              {/* Right-side actions sit inside the input border, before
                  the ⌘K hint. Quick access to the two most common
                  vault mutations without having to open the palette
                  first. Mousedown is on the icon itself so focus
                  doesn't shift onto the button mid-click. */}
              <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                {/* Both icon buttons render their own popover anchored
                    to themselves — Share/Tags-style — instead of
                    opening a centered modal. Controlled-open for the
                    new-folder one so the ⌘K palette's "New folder"
                    action can pop it open without the user re-clicking
                    the icon. Upload's popover opens automatically when
                    pendingFiles is set (either from clicking the icon
                    OR from drag-and-drop). */}
                <NewFolderButton
                  open={newFolderOpen}
                  onOpenChange={setNewFolderOpen}
                  currentDir={currentFolder}
                  onCreated={() => setRefreshNonce((n) => n + 1)}
                />
                <UploadButton
                  pendingFiles={pendingFiles}
                  setPendingFiles={setPendingFiles}
                  defaultDir={currentFolder}
                  onConfirm={async (files, dir) => {
                    await doUpload(files, dir)
                  }}
                />
                <span
                  className="mx-1 h-3 w-px"
                  style={{ background: 'var(--input-border)' }}
                  aria-hidden
                />
                <kbd
                  className="text-[10px] px-1 py-0.5 rounded shrink-0 pointer-events-none"
                  style={{
                    background: 'var(--panel)',
                    color: 'var(--fg-subtle)',
                    border: '1px solid var(--border)',
                  }}
                >
                  ⌘K
                </kbd>
              </div>
              <SearchPalette
                open={paletteOpen}
                query={searchQuery}
                onClose={() => setPaletteOpen(false)}
                inputRef={searchInputRef}
              />
            </div>
          </div>

          <div className="shrink-0 md:w-1/3 flex items-center justify-end gap-2">

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
          <Route path="/map" element={<MapPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/c/:id" element={<CollectionDetailPage />} />
          <Route path="/pc/:slug" element={<PublicCollectionPage />} />
          <Route path="/library/:mountId/*" element={<MountBrowser />} />
          <Route path="/library/:mountId" element={<MountBrowser />} />
          {auth.user.role === 'admin' && <Route path="/settings" element={<AdminPanel />} />}
          <Route path="*" element={<VaultView />} />
        </Routes>

        {paletteOpen && (
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'var(--scrim)' }}
            onClick={() => setPaletteOpen(false)}
          />
        )}

        {/* Centered upload progress card. Floats above content but
            doesn't block interaction — the user can still click around
            while a long batch uploads. Lives at the App root so it
            sits above any route, including /settings and /map. */}
        {uploadProgress && (
          <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[150] pointer-events-none"
          >
            <div
              className="rounded-xl px-5 py-4 w-[360px] max-w-[90vw] pointer-events-auto"
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                boxShadow: '0 10px 30px -10px rgba(9,30,66,0.35)',
              }}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-2.5 mb-3">
                <Loader2 size={15} className="animate-spin text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold text-fg">
                    {uploadProgress.total === 1
                      ? 'Uploading…'
                      : `Uploading ${uploadProgress.total} files`}
                  </div>
                  {uploadProgress.total > 1 && (
                    <div className="text-[11.5px] text-subtle tabular-nums mt-0.5">
                      {uploadProgress.done} of {uploadProgress.total}
                      {uploadProgress.failed.length > 0 && (
                        <span style={{ color: '#BF2600' }}>
                          {' '}· {uploadProgress.failed.length} failed
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {uploadProgress.total > 1 && (
                  <div className="text-[13.5px] font-semibold text-accent tabular-nums shrink-0">
                    {Math.round((uploadProgress.done / uploadProgress.total) * 100)}%
                  </div>
                )}
              </div>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: 'var(--border)' }}
              >
                <div
                  className="h-full transition-[width]"
                  style={{
                    width: `${
                      uploadProgress.total === 0
                        ? 0
                        : Math.round((uploadProgress.done / uploadProgress.total) * 100)
                    }%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
              {uploadProgress.current && (
                <div className="text-[11.5px] text-subtle mt-2 truncate" title={uploadProgress.current}>
                  {uploadProgress.current}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </VaultContext.Provider>
  )
}

