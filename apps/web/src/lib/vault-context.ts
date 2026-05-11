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
  /** Latest known status of an upload-in-progress, or null. */
  uploadingName: string | null
  /** Latest error from upload/mkdir, cleared by refresh(). */
  vaultError: string | null
  /** Clear `vaultError`. */
  clearError: () => void
  /** Vault-relative folder the user is currently viewing (used as upload default). "" = root. */
  currentFolder: string
  /** Set the active folder context (called by FolderGrid + PathViewer). */
  setCurrentFolder: (dir: string) => void
}

export const VaultContext = createContext<VaultContextValue | null>(null)

export function useVault(): VaultContextValue {
  const v = useContext(VaultContext)
  if (!v) throw new Error('useVault: missing VaultContext provider')
  return v
}
