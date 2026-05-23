import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Trash2,
  RotateCcw,
  Loader2,
  AlertCircle,
  ArrowLeft,
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
    <div className="flex-1 overflow-y-auto surface">
      <div className="max-w-[1080px] mx-auto px-8 py-10">
        <button className="btn-ghost mb-4" onClick={() => navigate('/')}>
          <ArrowLeft size={13} /> Back to vault
        </button>

        <header className="mb-6">
          <div className="text-[26px] font-semibold text-fg leading-tight inline-flex items-center gap-2.5">
            <Trash2 size={20} className="text-accent" />
            Trash
          </div>
          <div className="text-[13px] text-muted mt-1.5">
            Items you've deleted from the vault. Restore returns the file to its original
            path. Anything you don't restore is purged automatically after 30 days.
          </div>
        </header>

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
            className="rounded-xl p-8 text-center"
            style={{ background: 'var(--panel)', border: '1px dashed var(--border)' }}
          >
            <div className="text-[14px] text-fg font-medium">Trash is empty</div>
            <div className="text-[12px] text-muted mt-1.5">
              Anything you delete from the vault will show up here.
            </div>
          </div>
        ) : (
          <div
            className="rounded-xl overflow-hidden"
            style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
          >
            {entries.map((e, i) => (
              <div
                key={e.id}
                className="flex items-center gap-3 px-4 py-3"
                style={{
                  borderTop: i === 0 ? undefined : '1px solid var(--border)',
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-fg truncate">
                    {e.filename}
                  </div>
                  <div className="text-[11.5px] text-subtle truncate mt-0.5">
                    /{e.storageKey}
                  </div>
                </div>
                <div className="text-[11.5px] text-subtle shrink-0 tabular-nums">
                  {formatBytes(e.bytes)}
                </div>
                <div className="text-[11.5px] shrink-0 w-[180px] text-right">
                  <div className="text-subtle">deleted {timeAgo(e.trashedAt)}</div>
                  <div
                    className="text-[10.5px] mt-0.5"
                    style={{ color: deletionColor(e.trashedAt) }}
                  >
                    {deletionCountdown(e.trashedAt)}
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
                  className="btn-ghost shrink-0"
                  onClick={() => purge(e)}
                  disabled={busyId === e.id}
                  style={{ color: '#BF2600' }}
                  title="Permanently delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
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
