import { useEffect, useMemo, useState } from 'react'
import {
  Folder,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileCode,
  Globe,
  AlertCircle,
  Loader2,
  Lock,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type VaultNode } from '../lib/api'

type Props = {
  path: string
  /** Caller-controlled fallback for "not a public folder" — usually the auth gate. */
  onNotPublic: () => void
}

/**
 * Anonymous browser for a public folder. Mirrors `PublicFileView`'s flow:
 *
 *   - fetches folder meta with an optional password (?p=),
 *   - shows an in-app prompt on 401 + passwordRequired,
 *   - shows an "expired" card on 410,
 *   - renders the folder's children as tiles; clicking a file navigates to
 *     `/<rel>?p=<pwd>` — same bare-path scheme used everywhere else;
 *     the router resolves to the right viewer.
 *
 * Visibility cascades on the server, so every file/sub-folder inside a
 * public folder is itself public with the same expiry/password — the URL
 * just needs to carry the password forward.
 */
export function PublicFolderView({ path, onNotPublic }: Props) {
  const navigate = useNavigate()
  const [folder, setFolder] = useState<{
    owner: string
    storageKey: string
    public?: boolean
    publicExpiresAt?: number | null
    hasPassword: boolean
  } | null>(null)
  const [items, setItems] = useState<VaultNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expired, setExpired] = useState(false)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [passwordWrong, setPasswordWrong] = useState(false)
  const [password, setPassword] = useState('')
  const [submittedPwd, setSubmittedPwd] = useState<string>('')

  const folderName = useMemo(
    () => (path ? path.split('/').filter(Boolean).pop() || path : 'Vault'),
    [path],
  )

  useEffect(() => {
    const prev = document.title
    document.title = `${folderName} — Reader`
    return () => {
      document.title = prev
    }
  }, [folderName])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setExpired(false)
    setPasswordRequired(false)
    setPasswordWrong(false)
    const pwdOpt = submittedPwd ? { password: submittedPwd } : undefined
    api
      .getFolderMeta(path, pwdOpt)
      .then(async (r) => {
        if (cancelled) return
        if (!r.folder.public) {
          onNotPublic()
          return
        }
        setFolder({
          owner: r.folder.owner,
          storageKey: r.folder.storageKey,
          public: r.folder.public,
          publicExpiresAt: r.folder.publicExpiresAt,
          hasPassword: r.folder.hasPassword,
        })
        const list = await api.list(path, {
          owner: r.folder.owner,
          password: submittedPwd || undefined,
        })
        if (!cancelled) setItems(list.items)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError) {
          if (e.status === 401) {
            setPasswordRequired(true)
            if (submittedPwd) setPasswordWrong(true)
            return
          }
          if (e.status === 410) {
            setExpired(true)
            return
          }
          if (e.status === 404 || e.status === 403) {
            onNotPublic()
            return
          }
          setError(e.message)
        } else {
          setError(String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, onNotPublic, submittedPwd])

  if (passwordRequired) {
    return (
      <div className="h-full min-h-screen flex items-center justify-center surface">
        <form
          className="w-[340px] p-6 rounded-lg shadow-card"
          style={{ background: 'var(--panel)' }}
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedPwd(password)
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Lock size={16} className="text-accent" />
            <div className="text-fg font-semibold">Password required</div>
          </div>
          <div className="text-[12.5px] text-muted mb-3">
            This folder is shared with a password.
          </div>
          <input
            type="password"
            className="input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <button className="btn-primary w-full mt-3" type="submit">
            <Lock size={14} /> Open folder
          </button>
          {passwordWrong && (
            <div className="text-[12px] mt-2" style={{ color: '#BF2600' }}>
              Incorrect password. Try again.
            </div>
          )}
        </form>
      </div>
    )
  }

  if (expired) {
    return (
      <div className="h-full min-h-screen flex items-center justify-center surface">
        <div className="text-center max-w-md p-6">
          <AlertCircle size={20} style={{ color: '#BF2600' }} className="mx-auto mb-2" />
          <div className="text-fg font-semibold">This link has expired</div>
          <div className="text-[13px] text-muted mt-1">
            Ask the owner for a fresh public link.
          </div>
        </div>
      </div>
    )
  }

  if (loading || !folder || !items) {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-[13px] text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="text-center max-w-md p-6">
          <AlertCircle size={20} style={{ color: '#BF2600' }} className="mx-auto mb-2" />
          <div className="text-fg font-semibold">Couldn't open this folder</div>
          <div className="text-[13px] text-muted mt-1">{error}</div>
        </div>
      </div>
    )
  }

  const open = (node: VaultNode) => {
    const segs = node.path.split('/').map(encodeURIComponent).join('/')
    const params: string[] = []
    if (submittedPwd) params.push(`p=${encodeURIComponent(submittedPwd)}`)
    // Bare path — the router resolves files vs folders via /api/resolve,
    // so we don't need a `/docs` or `/folder` prefix here.
    const qs = params.length ? `?${params.join('&')}` : ''
    navigate(`/${segs}${qs}`)
  }

  return (
    <div className="h-full flex flex-col surface">
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--panel-2)' }}
      >
        <Folder size={14} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg truncate">{folderName}</div>
        <span className="btn-ghost cursor-default" style={{ color: '#00875A' }}>
          <Globe size={13} /> Public
        </span>
        <div className="flex-1" />
        <span className="text-[12px] text-muted">
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {items.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted text-[12.5px]">
            This folder is empty.
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
          >
            {items.map((n) => (
              <button
                key={n.path}
                onClick={() => open(n)}
                className="flex flex-col items-center justify-start gap-2 p-3 rounded-md transition-colors text-left cursor-pointer hover:bg-hover"
                style={{ background: 'transparent' }}
              >
                <div className="w-full h-20 flex items-center justify-center overflow-hidden rounded">
                  {n.type === 'dir' ? (
                    <Folder size={42} className="text-accent" strokeWidth={1.4} />
                  ) : (
                    <BigTypeIcon ext={n.ext} />
                  )}
                </div>
                <div className="w-full text-[11.5px] text-fg text-center leading-tight">
                  <span className="line-clamp-2 break-words">{n.name}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function BigTypeIcon({ ext }: { ext?: string }) {
  const e = (ext || '').toLowerCase()
  const props = { size: 42, strokeWidth: 1.3 } as const
  if (e === '.pdf') return <FileType {...props} className="text-muted" />
  if ([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
  ].includes(e))
    return <FileImage {...props} className="text-muted" />
  if ([
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
    '.avi', '.3gp', '.3gpp', '.mts', '.m2ts',
    '.mpg', '.mpeg', '.wmv', '.flv', '.ogv',
  ].includes(e))
    return <FileVideo {...props} className="text-muted" />
  if (['.xlsx', '.xls', '.csv'].includes(e))
    return <FileSpreadsheet {...props} style={{ color: '#00875A' }} />
  if (['.json', '.yaml', '.yml', '.toml', '.html', '.htm'].includes(e))
    return <FileCode {...props} className="text-subtle" />
  return <FileText {...props} className="text-subtle" />
}
