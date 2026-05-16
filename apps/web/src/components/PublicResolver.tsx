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

type State =
  | { status: 'loading' }
  | { status: 'file' }
  | { status: 'folder' }
  | { status: 'gone' }

/**
 * Anonymous entry point for bare-path URLs. Resolves whether `<path>` is a
 * file or a folder via `/api/resolve`, then hands off to the matching
 * viewer. Carries forward `?p=<password>` from the URL so a single
 * password-protected link works for the whole subtree.
 *
 * For 401 (password required) the server tells us the kind so we
 * route to the matching viewer for the password prompt. There is no
 * "expired" state — the server's expiry sweep flips expired publics
 * back to private, so expired links just behave like any other
 * private path.
 */
export function PublicResolver({ path, onNotPublic }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const url = new URL(window.location.href)
    const password = url.searchParams.get('p') ?? undefined
    setState({ status: 'loading' })
    api
      .resolve(path, password ? { password } : undefined)
      .then((r) => {
        if (cancelled) return
        setState({ status: r.kind })
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 401) {
          const kind = e.body?.kind === 'folder' ? 'folder' : 'file'
          setState({ status: kind })
          return
        }
        onNotPublic()
        setState({ status: 'gone' })
      })
    return () => {
      cancelled = true
    }
  }, [path, onNotPublic])

  if (state.status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-[13px] text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    )
  }
  if (state.status === 'file') {
    return <PublicFileView path={path} onNotPublic={onNotPublic} />
  }
  if (state.status === 'folder') {
    return <PublicFolderView path={path} onNotPublic={onNotPublic} />
  }
  return null
}
