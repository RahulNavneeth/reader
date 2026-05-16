import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { PublicFileView } from './PublicFileView'
import { PublicFolderView } from './PublicFolderView'

type Props = {
  /** Bare vault path (no `/docs` or `/folder` prefix). "" = root vault. */
  path: string
  /** Caller's fallback when the path isn't accessible anonymously. */
  onNotPublic: () => void
}

/**
 * Anonymous entry point for bare-path URLs. Resolves whether `<path>` is a
 * file or a folder via `/api/resolve`, then hands off to the matching
 * viewer. Carries forward `?p=<password>` from the URL so a single
 * password-protected link works for the whole subtree.
 */
export function PublicResolver({ path, onNotPublic }: Props) {
  const [kind, setKind] = useState<'loading' | 'file' | 'folder' | 'auth'>('loading')

  useEffect(() => {
    let cancelled = false
    const url = new URL(window.location.href)
    const password = url.searchParams.get('p') ?? undefined
    setKind('loading')
    api
      .resolve(path, password ? { password } : undefined)
      .then((r) => {
        if (cancelled) return
        setKind(r.kind)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && (e.status === 401 || e.status === 410)) {
          // Let the underlying viewer handle the prompt / expired UI —
          // it'll re-issue the same resolve call. Default to folder if
          // path could plausibly be either; the viewers themselves can
          // recover with their own error states.
          setKind('folder')
          return
        }
        onNotPublic()
        setKind('auth')
      })
    return () => {
      cancelled = true
    }
  }, [path, onNotPublic])

  if (kind === 'loading') {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-[13px] text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    )
  }
  if (kind === 'file') {
    return <PublicFileView path={path} onNotPublic={onNotPublic} />
  }
  if (kind === 'folder') {
    return <PublicFolderView path={path} onNotPublic={onNotPublic} />
  }
  return null
}
