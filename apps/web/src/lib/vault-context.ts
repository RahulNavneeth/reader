import { createContext, useContext } from 'react'

export type VaultContextValue = {
  /** Open the OS file picker. */
  triggerUpload: () => void
  /** Upload an explicit set of files. If `dir` is omitted, the destination dialog is shown. */
  uploadFiles: (files: FileList | File[], dir?: string) => Promise<void>
  /** Prompt for a folder name and create it (relative to vault root). */
  triggerNewFolder: () => Promise<void>
  /** Force the tree to refetch. */
  refresh: () => void
  /** Bumped whenever a refresh is requested — drive useEffect deps with this. */
  refreshNonce: number
  /** Active upload batch progress, or null when nothing is uploading.
   *  `done` is the number of files fully uploaded so far (not counting
   *  the one currently in flight); `current` is the file in flight.
   *  `failed` carries per-file errors so the batch can continue even
   *  when individual files fail. */
  uploadProgress: {
    done: number
    total: number
    current: string | null
    failed: Array<{ name: string; reason: string }>
  } | null
  /** Latest error from upload/mkdir, cleared by refresh(). */
  vaultError: string | null
  /** Push an error into the shared banner — used by descendants
   *  (VaultTree drag-drop, etc.) so they don't dump into console. */
  setVaultError: (msg: string | null) => void
  /** Clear `vaultError`. */
  clearError: () => void
  /** Vault-relative folder the user is currently viewing (used as upload default). "" = root. */
  currentFolder: string
  /** Set the active folder context (called by FolderGrid + PathViewer). */
  setCurrentFolder: (dir: string) => void
  /** Logged-in user's username — used to decide when to thread
   *  `?owner=` through navigation (cross-owner shared content). */
  currentUsername: string
  /** Mobile-only sidebar drawer state. Sidebar is always visible on
   *  desktop (md+); on small screens it slides in over the content. */
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: (open: boolean) => void
}

export const VaultContext = createContext<VaultContextValue | null>(null)

export function useVault(): VaultContextValue {
  const v = useContext(VaultContext)
  if (!v) throw new Error('useVault: missing VaultContext provider')
  return v
}
