import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Loader2,
  HardDrive,
  Users,
  Shield,
  AlertCircle,
  Clock,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileCode,
  Sparkles,
  Globe,
  Files,
  Share2,
  Download,
  Sun,
  Mail,
  RefreshCw,
  KeyRound,
  Send,
  Check,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useConfirm } from '../lib/confirm'

type Stats = Awaited<ReturnType<typeof api.accountStats>>
type Memories = Awaited<ReturnType<typeof api.memories>>

/**
 * Per-user dashboard. Immich-ish layout: warm greeting, KPI cards
 * with colored icon badges, large storage panel, recent-files
 * thumbnail grid, file-type donut, activity timeline. Workspace-wide
 * stats stay in /settings.
 */
export function AccountPage() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<Stats | null>(null)
  const [memories, setMemories] = useState<Memories | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .accountStats()
      .then(setStats)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
    api
      .memories()
      .then(setMemories)
      .catch(() => setMemories(null))
  }, [])

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center surface">
        <div className="text-center max-w-md p-6">
          <AlertCircle size={20} style={{ color: '#BF2600' }} className="mx-auto mb-2" />
          <div className="text-fg font-semibold">Couldn't load account</div>
          <div className="text-[13px] text-muted mt-1">{error}</div>
        </div>
      </div>
    )
  }
  if (!stats) {
    return (
      <div className="flex-1 flex items-center justify-center surface">
        <div className="text-[13px] text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    )
  }

  const u = stats.user
  const s = stats.storage
  const usedPct =
    s.quotaBytes && s.quotaBytes > 0
      ? Math.min(100, Math.round((s.bytesUsed / s.quotaBytes) * 100))
      : null
  const indexedPct = s.fileCount > 0 ? Math.round((s.embeddedCount / s.fileCount) * 100) : 0

  return (
    <div className="flex-1 overflow-y-auto surface">
      <div className="max-w-[1080px] mx-auto px-8 py-10 space-y-8">
        {/* Hero greeting */}
        <header className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="text-[28px] font-semibold text-fg leading-tight">
              {greeting()}, {u.username}
            </div>
            <div className="text-[13.5px] text-muted mt-1.5 inline-flex items-center gap-2">
              {u.role === 'admin' && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[11px] font-medium"
                  style={{ background: 'var(--selected)', color: 'var(--accent)' }}
                >
                  <Shield size={10} /> Admin
                </span>
              )}
              {u.role !== 'admin' && (
                <span className="capitalize text-subtle">{u.role}</span>
              )}
              <span className="text-subtle">·</span>
              <span className="text-subtle">
                Member since {new Date(u.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              className="btn-ghost"
              onClick={() => navigate('/account/tokens')}
              title="Manage your API tokens"
            >
              <KeyRound size={13} />
              API tokens
            </button>
            <button
              className="btn-ghost"
              onClick={() => navigate('/account/webhooks')}
              title="Manage your webhooks"
            >
              <Send size={13} />
              Webhooks
            </button>
            <a
              href={api.exportUrl()}
              className="btn-ghost"
              title="Stream a ZIP of every file plus a manifest with tags, shares, and pins"
            >
              <Download size={13} />
              Export everything
            </a>
          </div>
        </header>

        {/* Email + Re-index strip — compact inline row that lets the user
            set their contact address and trigger a re-index of their
            own files. */}
        <EmailAndReindex user={u} />

        {/* Memories — "On this day" carousel. */}
        {memories && memories.groups.length > 0 && (
          <section
            className="rounded-xl p-5"
            style={{
              background:
                'linear-gradient(135deg, rgba(255,153,31,0.10), rgba(190,75,219,0.10))',
              border: '1px solid var(--border-soft)',
            }}
          >
            <div className="flex items-center gap-2.5 mb-3">
              <div
                className="w-9 h-9 rounded-full inline-flex items-center justify-center shrink-0"
                style={{ background: 'rgba(255,153,31,0.20)', color: '#FF991F' }}
              >
                <Sun size={16} />
              </div>
              <div className="flex-1">
                <div className="text-[15px] font-semibold text-fg">On this day</div>
                <div className="text-[11.5px] text-subtle">
                  Files you added on{' '}
                  {new Date().toLocaleDateString(undefined, {
                    month: 'long',
                    day: 'numeric',
                  })}{' '}
                  in years past
                </div>
              </div>
            </div>
            <div className="space-y-4">
              {memories.groups.map((g) => (
                <div key={g.yearsAgo}>
                  <div className="text-[11.5px] uppercase tracking-wider font-semibold text-subtle mb-2">
                    {g.label}
                  </div>
                  <div
                    className="grid gap-3"
                    style={{
                      gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                    }}
                  >
                    {g.items.map((m) => (
                      <button
                        key={m.path}
                        onClick={() => {
                          const segs = m.path.split('/').map(encodeURIComponent).join('/')
                          navigate(`/${segs}`)
                        }}
                        className="group flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-hover transition-colors"
                      >
                        <div
                          className="w-full aspect-square rounded-md overflow-hidden flex items-center justify-center relative"
                          style={{ background: 'var(--bg)' }}
                        >
                          <img
                            src={api.thumbnailUrl(m.path)}
                            alt=""
                            className="max-w-full max-h-full object-contain"
                            onError={(e) => ((e.currentTarget.style.display = 'none'))}
                          />
                        </div>
                        <div className="w-full text-[11.5px] text-fg truncate" title={m.name}>
                          {m.name}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* KPI cards with colored icon badges */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Kpi
            icon={<Files size={18} />}
            iconBg="rgba(76, 110, 245, 0.15)"
            iconColor="#4C6EF5"
            label="Files"
            value={s.fileCount.toLocaleString()}
          />
          <Kpi
            icon={<HardDrive size={18} />}
            iconBg="rgba(132, 94, 247, 0.15)"
            iconColor="#845EF7"
            label="Storage"
            value={formatBytes(s.bytesUsed)}
            sub={s.quotaBytes ? `of ${formatBytes(s.quotaBytes)}` : 'no quota set'}
          />
          <Kpi
            icon={<Sparkles size={18} />}
            iconBg="rgba(34, 184, 207, 0.15)"
            iconColor="#22B8CF"
            label="Indexed"
            value={`${indexedPct}%`}
            sub={`${s.embeddedCount} of ${s.fileCount} files`}
          />
          <Kpi
            icon={<Globe size={18} />}
            iconBg="rgba(64, 192, 87, 0.15)"
            iconColor="#40C057"
            label="Public"
            value={s.publicCount.toLocaleString()}
            sub={s.publicCount === 1 ? 'shared link' : 'shared links'}
          />
        </div>

        {/* Storage panel with prominent bar */}
        {usedPct != null && (
          <Card padded>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <IconBadge bg="rgba(132, 94, 247, 0.15)" color="#845EF7">
                  <HardDrive size={16} />
                </IconBadge>
                <div>
                  <div className="text-[15px] font-semibold text-fg">Storage</div>
                  <div className="text-[12px] text-subtle">
                    {formatBytes(s.bytesUsed)} used of {formatBytes(s.quotaBytes ?? 0)}
                  </div>
                </div>
              </div>
              <div
                className="text-[22px] font-semibold leading-none tabular-nums"
                style={{
                  color: usedPct > 90 ? '#BF2600' : usedPct > 70 ? '#FF991F' : 'var(--accent)',
                }}
              >
                {usedPct}%
              </div>
            </div>
            <div
              className="h-3 rounded-full overflow-hidden"
              style={{ background: 'var(--border-soft)' }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${usedPct}%`,
                  background:
                    usedPct > 90
                      ? '#BF2600'
                      : usedPct > 70
                      ? '#FF991F'
                      : 'linear-gradient(90deg, #4C6EF5, #845EF7)',
                }}
              />
            </div>
          </Card>
        )}

        {/* Recent files — thumbnail grid */}
        <Card padded>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <IconBadge bg="rgba(76, 110, 245, 0.15)" color="#4C6EF5">
                <Clock size={16} />
              </IconBadge>
              <div className="text-[15px] font-semibold text-fg">Recent files</div>
            </div>
            <button
              className="text-[11.5px] text-accent hover:underline"
              onClick={() => navigate('/')}
            >
              View vault →
            </button>
          </div>
          {stats.recent.length === 0 ? (
            <div className="text-[12.5px] text-subtle py-6 text-center">
              Nothing here yet — upload a file to get started.
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}
            >
              {stats.recent.map((f) => (
                <button
                  key={f.path}
                  onClick={() => {
                    const segs = f.path.split('/').map(encodeURIComponent).join('/')
                    navigate(`/${segs}`)
                  }}
                  className="group flex flex-col items-center gap-1.5 p-2 rounded-lg text-left hover:bg-hover transition-colors"
                >
                  <div
                    className="w-full aspect-square rounded-md overflow-hidden flex items-center justify-center relative"
                    style={{ background: 'var(--bg)' }}
                  >
                    <Thumb path={f.path} name={f.name} />
                    {f.public && (
                      <span
                        className="absolute top-1 right-1 w-4 h-4 rounded-full inline-flex items-center justify-center"
                        style={{ background: 'rgba(0,135,90,0.95)' }}
                      >
                        <Globe size={9} color="white" />
                      </span>
                    )}
                  </div>
                  <div className="w-full text-[11.5px] text-fg leading-tight flex items-center gap-1">
                    <span className="truncate flex-1" title={f.name}>{f.name}</span>
                    {f.embedded && <Sparkles size={9} className="text-accent shrink-0" />}
                  </div>
                  <div className="w-full text-[10px] text-subtle">{formatBytes(f.bytes)}</div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* File-types + Activity side by side */}
        <div className="grid md:grid-cols-[1fr_1.5fr] gap-4">
          <Card padded>
            <div className="flex items-center gap-2.5 mb-3">
              <IconBadge bg="rgba(34, 184, 207, 0.15)" color="#22B8CF">
                <FileText size={16} />
              </IconBadge>
              <div className="text-[15px] font-semibold text-fg">By type</div>
            </div>
            {stats.fileTypes.length === 0 ? (
              <div className="text-[12.5px] text-subtle py-4 text-center">No files yet.</div>
            ) : (
              <div className="space-y-2.5">
                {(() => {
                  const max = Math.max(...stats.fileTypes.map((t) => t.count))
                  return stats.fileTypes.map((t) => (
                    <div key={t.ext} className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="text-fg w-[60px] shrink-0">{t.ext}</span>
                      <div
                        className="flex-1 h-2 rounded-full overflow-hidden"
                        style={{ background: 'var(--border-soft)' }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(t.count / max) * 100}%`,
                            background: 'linear-gradient(90deg, #4C6EF5, #845EF7)',
                          }}
                        />
                      </div>
                      <span className="text-fg font-semibold w-[36px] text-right tabular-nums">
                        {t.count}
                      </span>
                    </div>
                  ))
                })()}
              </div>
            )}
          </Card>

          <Card padded>
            <div className="flex items-center gap-2.5 mb-3">
              <IconBadge bg="rgba(255, 153, 31, 0.18)" color="#FF991F">
                <Clock size={16} />
              </IconBadge>
              <div className="text-[15px] font-semibold text-fg">Recent activity</div>
            </div>
            {stats.activity.length === 0 ? (
              <div className="text-[12.5px] text-subtle py-4 text-center">
                No recorded activity yet.
              </div>
            ) : (
              <ol className="relative space-y-2.5">
                {stats.activity.slice(0, 8).map((e, i) => (
                  <li key={i} className="flex items-baseline gap-3">
                    <span
                      className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                      style={{ background: 'var(--accent)' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] text-fg">{prettyAction(e.action)}</div>
                      {e.target && (
                        <div className="text-[11px] text-subtle truncate">
                          {e.target}
                        </div>
                      )}
                    </div>
                    <span className="text-[10.5px] text-subtle shrink-0">{timeAgo(e.ts)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        {/* Sharing */}
        <Card padded>
          <div className="flex items-center gap-2.5 mb-3">
            <IconBadge bg="rgba(64, 192, 87, 0.15)" color="#40C057">
              <Share2 size={16} />
            </IconBadge>
            <div className="text-[15px] font-semibold text-fg">Sharing</div>
          </div>
          <div className="flex items-center gap-8 mt-2">
            <div>
              <div className="text-[26px] font-semibold text-fg leading-none">
                {stats.shares.outgoing}
              </div>
              <div className="text-subtle text-[11.5px] mt-1.5">Shared by you</div>
            </div>
            <div>
              <div className="text-[26px] font-semibold text-fg leading-none">
                {stats.shares.incoming}
              </div>
              <div className="text-subtle text-[11.5px] mt-1.5">Shared with you</div>
            </div>
            {stats.shares.incoming > 0 && (
              <button
                className="ml-auto btn-ghost text-[12px]"
                onClick={() => navigate('/')}
              >
                <Users size={12} /> Browse
              </button>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Card({ children, padded }: { children: React.ReactNode; padded?: boolean }) {
  return (
    <section
      className={`rounded-xl ${padded ? 'p-5' : ''}`}
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border-soft)',
      }}
    >
      {children}
    </section>
  )
}

function IconBadge({
  children,
  bg,
  color,
}: {
  children: React.ReactNode
  bg: string
  color: string
}) {
  return (
    <div
      className="w-9 h-9 rounded-full inline-flex items-center justify-center shrink-0"
      style={{ background: bg, color }}
    >
      {children}
    </div>
  )
}

function Kpi({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  iconBg: string
  iconColor: string
  label: string
  value: string
  sub?: string
}) {
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <IconBadge bg={iconBg} color={iconColor}>{icon}</IconBadge>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle">
          {label}
        </div>
      </div>
      <div className="text-[24px] font-semibold text-fg leading-none tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-subtle mt-1.5">{sub}</div>}
    </div>
  )
}

function Thumb({ path, name }: { path: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const ext = (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
  const isImagey = [
    '.pdf',
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico',
    '.heic', '.heif', '.tiff', '.tif', '.jxl',
    '.mp4', '.mov', '.m4v', '.mkv', '.webm',
  ].includes(ext)
  if (isImagey && !failed) {
    return (
      <img
        src={api.thumbnailUrl(path)}
        alt=""
        className="max-w-full max-h-full object-contain"
        onError={() => setFailed(true)}
      />
    )
  }
  // Fallback: typed icon
  const props = { size: 36, strokeWidth: 1.4 } as const
  if (ext === '.pdf') return <FileType {...props} className="text-muted" />
  if (['.png','.jpg','.jpeg','.webp','.gif','.svg','.avif','.bmp','.ico','.heic','.heif','.tiff','.tif','.jxl'].includes(ext))
    return <FileImage {...props} className="text-muted" />
  if (['.mp4','.mov','.m4v','.mkv','.webm','.avi'].includes(ext))
    return <FileVideo {...props} className="text-muted" />
  if (['.xlsx','.xls','.csv'].includes(ext))
    return <FileSpreadsheet {...props} style={{ color: '#40C057' }} />
  if (['.json','.yaml','.yml','.toml','.html','.htm'].includes(ext))
    return <FileCode {...props} className="text-subtle" />
  return <FileText {...props} className="text-subtle" />
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function prettyAction(a: string): string {
  switch (a) {
    case 'vault.upload': return 'Uploaded a file'
    case 'vault.edit': return 'Edited on disk'
    case 'vault.trash': return 'Moved to Trash'
    case 'vault.delete': return 'Deleted a file'
    case 'vault.move': return 'Moved a file'
    case 'vault.visibility': return 'Changed visibility'
    case 'vault.tags': return 'Updated tags'
    case 'vault.index': return 'Re-indexed'
    case 'vault.folder-visibility': return 'Changed folder visibility'
    case 'vault.folder-tags': return 'Updated folder tags'
    case 'vault.share-with': return 'Shared with user'
    case 'vault.share-with-file':
    case 'vault.share-with-folder': return 'Cascaded share'
    case 'vault.share-revoke': return 'Revoked a share'
    case 'vault.bulk-trash': return 'Bulk trashed'
    case 'vault.bulk-visibility': return 'Bulk visibility'
    case 'auth.login': return 'Signed in'
    case 'auth.logout': return 'Signed out'
    default: return a
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

/**
 * Compact "email + re-index" row that sits below the account header.
 * Email persists immediately on blur; re-index walks only this user's
 * docs (admins still re-embed everyone from /settings if needed).
 */
function EmailAndReindex({ user }: { user: { username: string; email?: string } }) {
  const confirm = useConfirm()
  const [email, setEmail] = useState(user.email ?? '')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailSaved, setEmailSaved] = useState(false)
  const [emailErr, setEmailErr] = useState<string | null>(null)
  const [reembedBusy, setReembedBusy] = useState(false)
  const [reembedResult, setReembedResult] = useState<{
    total: number
    ok: number
    removed: number
    failed: number
  } | null>(null)
  const [reembedErr, setReembedErr] = useState<string | null>(null)

  const saveEmail = async () => {
    const next = email.trim()
    if (next === (user.email ?? '')) return
    setEmailBusy(true)
    setEmailErr(null)
    try {
      await api.patchAccountEmail(next)
      setEmailSaved(true)
      setTimeout(() => setEmailSaved(false), 1500)
    } catch (e) {
      setEmailErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setEmailBusy(false)
    }
  }

  const runReembed = async () => {
    const ok = await confirm({
      title: 'Re-index your files',
      message:
        'Re-runs text extraction + embedding on every file you own. Can take a while for large vaults; it runs in the background so feel free to keep using Reader.',
      confirmLabel: 'Re-index',
    })
    if (!ok) return
    setReembedBusy(true)
    setReembedErr(null)
    setReembedResult(null)
    try {
      const r = await api.accountReembed()
      setReembedResult(r)
    } catch (e) {
      setReembedErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setReembedBusy(false)
    }
  }

  return (
    <section
      className="rounded-xl p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3"
      style={{ background: 'var(--panel)', border: '1px solid var(--border-soft)' }}
    >
      <div className="flex-1 flex items-center gap-2.5 min-w-0">
        <Mail size={14} className="text-subtle shrink-0" />
        <input
          type="email"
          placeholder="Notification email (optional)"
          className="input h-8 text-[12.5px] flex-1 min-w-0"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setEmailSaved(false)
            setEmailErr(null)
          }}
          onBlur={saveEmail}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
          }}
          disabled={emailBusy}
        />
        {emailBusy && <Loader2 size={12} className="animate-spin text-subtle shrink-0" />}
        {emailSaved && !emailBusy && (
          <Check size={12} className="text-accent shrink-0" />
        )}
        {emailErr && (
          <span className="text-[11px] shrink-0" style={{ color: '#BF2600' }}>
            {emailErr}
          </span>
        )}
      </div>
      <div
        className="hidden md:block w-px self-stretch"
        style={{ background: 'var(--border-soft)' }}
      />
      <div className="flex items-center gap-2">
        <button
          className="btn-ghost"
          onClick={runReembed}
          disabled={reembedBusy}
          title="Re-extract + re-embed every file you own"
        >
          {reembedBusy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          Re-index my files
        </button>
        {reembedResult && (
          <span className="text-[11.5px] text-subtle">
            {reembedResult.ok}/{reembedResult.total} ok
            {reembedResult.failed > 0 && (
              <span style={{ color: '#BF2600' }}> · {reembedResult.failed} failed</span>
            )}
            {reembedResult.removed > 0 && (
              <span className="text-muted"> · {reembedResult.removed} stale removed</span>
            )}
          </span>
        )}
        {reembedErr && (
          <span className="text-[11px]" style={{ color: '#BF2600' }}>
            {reembedErr}
          </span>
        )}
      </div>
    </section>
  )
}
