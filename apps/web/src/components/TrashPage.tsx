import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Trash2,
  RotateCcw,
  Loader2,
  AlertCircle,
  ArrowLeft,
  FileText,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { useVault } from '../lib/vault-context'
import { useConfirm } from '../lib/confirm'

type Entry = {
  id: string
  storageKey: string
  filename: string
  docId?: string
  bytes: number
  trashedAt: number
  trashedBy: string
}

/**
 * Per-user trash bin. The server scopes the trash list to the caller
 * already; this page just renders it with restore + purge actions.
 * Admins still get the wider table in /settings; users get this.
 */
export function TrashPage() {
  const navigate = useNavigate()
  const { refresh } = useVault()
  const confirm = useConfirm()
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = () =>
    api
      .trashList()
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    load()
  }, [])

  const restore = async (e: Entry) => {
    setBusyId(e.id)
    setError(null)
    try {
      await api.trashRestore(e.id)
      await load()
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (e: Entry) => {
    const ok = await confirm({
      title: 'Permanently delete',
      message: `"${e.filename}" will be erased from disk. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      destructive: true,
    })
    if (!ok) return
    setBusyId(e.id)
    setError(null)
    try {
      await api.trashPurge(e.id)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ background: 'var(--surface-3)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/')}
          title="Back to vault"
          aria-label="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <Trash2 size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">Trash</div>
        {entries && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {entries.length} {entries.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1080px] mx-auto px-8 py-6">

        {error && (
          <div
            className="mb-4 px-3 py-2 rounded text-[12.5px] inline-flex items-center gap-2"
            style={{ background: '#FFEBE6', color: '#BF2600' }}
          >
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {!entries ? null : entries.length === 0 ? (
          <div
            className="rounded-md p-8 text-center"
            style={{ background: 'var(--viewer)', border: '1px dashed var(--border)' }}
          >
            <div className="text-[14px] text-fg font-medium">Trash is empty</div>
            <div className="text-[12px] text-muted mt-1.5">
              Anything you delete from the vault will show up here.
            </div>
          </div>
        ) : (
          <div
            className="rounded-md overflow-hidden settings-list-card"
            style={{ background: 'var(--viewer)', border: '1px solid var(--border)' }}
          >
            {entries.map((e) => {
              const lastSlash = e.storageKey.lastIndexOf('/')
              const parentDir = lastSlash >= 0 ? e.storageKey.slice(0, lastSlash) : ''
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <FileText size={14} className="text-subtle shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-fg truncate">
                      {e.filename}
                    </div>
                    <div className="text-[11px] text-subtle truncate mt-0.5">
                      {parentDir && (
                        <>
                          <span className="opacity-80">{parentDir}/</span>
                          <span className="mx-1.5 opacity-60">·</span>
                        </>
                      )}
                      <span className="tabular-nums">{formatBytes(e.bytes)}</span>
                      <span className="mx-1.5 opacity-60">·</span>
                      <span>deleted {timeAgo(e.trashedAt)}</span>
                      <span className="mx-1.5 opacity-60">·</span>
                      <span style={{ color: deletionColor(e.trashedAt) }}>
                        {deletionCountdown(e.trashedAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn-ghost shrink-0"
                    onClick={() => restore(e)}
                    disabled={busyId === e.id}
                    title="Restore to original location"
                  >
                    {busyId === e.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCcw size={12} />
                    )}
                    Restore
                  </button>
                  <button
                    className="btn-ghost-danger shrink-0"
                    onClick={() => purge(e)}
                    disabled={busyId === e.id}
                    title="Permanently delete"
                    aria-label="Permanently delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const TRASH_RETENTION_DAYS = 30

function deletionCountdown(trashedAt: number): string {
  const purgeAt = trashedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const msLeft = purgeAt - Date.now()
  if (msLeft <= 0) return 'purges any moment'
  const hours = Math.floor(msLeft / (60 * 60 * 1000))
  if (hours < 24) return `purges in ${hours}h`
  const days = Math.floor(msLeft / (24 * 60 * 60 * 1000))
  return `purges in ${days}d`
}

function deletionColor(trashedAt: number): string {
  const purgeAt = trashedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const daysLeft = (purgeAt - Date.now()) / (24 * 60 * 60 * 1000)
  if (daysLeft <= 1) return '#BF2600'
  if (daysLeft <= 7) return '#FF991F'
  return 'var(--fg-subtle)'
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
