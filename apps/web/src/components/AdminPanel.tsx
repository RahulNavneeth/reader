import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Copy,
  Plus,
  Trash2,
  X,
  Users as UsersIcon,
  Settings,
  ChevronLeft,
  Database,
  Sparkles,
  UserPlus,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderSearch,
  Folder,
  Mail,
  Send,
  HardDrive,
  RefreshCw,
  Webhook,
  Plug,
  Archive,
  Play,
} from 'lucide-react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import {
  ApiError,
  api,
  type PublicUser,
  type Role,
  type SystemInfo,
  type WorkspaceSettings,
} from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { useVault } from '../lib/vault-context'
import { AdminWebhooksPanel } from './AdminWebhooksPanel'
import { AdminOauthClientsPanel } from './AdminOauthClientsPanel'

type Section = 'general' | 'users' | 'duplicates' | 'embeddings' | 'storage' | 'mounts' | 'mail' | 'webhooks' | 'oauth-clients' | 'advanced' | 'backup'

type Group = {
  label: string
  items: { id: Section; label: string; icon: typeof UsersIcon }[]
}

const GROUPS: Group[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'general', label: 'General', icon: Database },
      { id: 'users', label: 'Users', icon: UsersIcon },
    ],
  },
  {
    label: 'Data',
    items: [
      { id: 'duplicates', label: 'Duplicates', icon: Copy },
      { id: 'embeddings', label: 'Search & embeddings', icon: Sparkles },
      { id: 'storage', label: 'Storage', icon: Database },
      { id: 'mounts', label: 'External libraries', icon: HardDrive },
    ],
  },
  {
    label: 'Notifications',
    items: [
      { id: 'mail', label: 'Email (SMTP)', icon: Mail },
      { id: 'webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'oauth-clients', label: 'OAuth clients', icon: Plug },
      { id: 'advanced', label: 'Server & sessions', icon: Settings },
    ],
  },
  {
    label: 'Reliability',
    items: [
      { id: 'backup', label: 'Backup', icon: Archive },
    ],
  },
]

export function AdminPanel() {
  const navigate = useNavigate()
  const [section, setSection] = useState<Section>('general')

  const activeItem = GROUPS.flatMap((g) => g.items).find((i) => i.id === section)!

  return (
    <div className="flex-1 flex overflow-hidden">
      <aside
        className="panel border-r border-app shrink-0 w-[240px] flex flex-col"
        style={{ background: 'var(--panel)' }}
      >
        <div
          className="h-11 px-2 flex items-center gap-1.5 border-b shrink-0"
          style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
        >
          <button
            className="btn-ghost h-7 w-7 px-0 shrink-0"
            onClick={() => navigate('/')}
            title="Back to vault"
          >
            <ChevronLeft size={14} />
          </button>
          <Settings size={14} className="text-accent" />
          <span className="text-[13px] font-semibold text-fg">Settings</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-3">
          {GROUPS.map((g) => (
            <div key={g.label} className="space-y-0.5">
              <div className="px-2 pt-1 pb-1 text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                {g.label}
              </div>
              {g.items.map((item) => {
                const Icon = item.icon
                const isActive = section === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => setSection(item.id)}
                    /* No `transition-colors` on the active row: when the
                       user switches theme, `--selected` and `--accent`
                       both flip values; a colour transition would animate
                       the selected row over ~150ms while everything else
                       snaps instantly, producing a visible lag. Non-active
                       rows still get hover smoothing. */
                    className={clsx(
                      'w-full flex items-center gap-2 px-2 h-7 rounded text-[13px] text-left',
                      !isActive && 'transition-colors hover:bg-hover',
                    )}
                    style={{
                      background: isActive ? 'var(--selected)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--fg)',
                      fontWeight: isActive ? 500 : 400,
                    }}
                  >
                    <Icon size={13} className={isActive ? 'text-accent' : 'text-muted'} />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col surface">
        <header
          className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
          style={{ background: 'var(--panel-2)' }}
        >
          <activeItem.icon size={14} className="text-accent" />
          <div className="text-[13.5px] font-semibold text-fg">{activeItem.label}</div>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-6 py-6">
            {section === 'general' && <GeneralPanel />}
            {section === 'users' && <UsersPanel />}
            {section === 'duplicates' && <DuplicatesPanel />}
            {section === 'embeddings' && <EmbeddingsPanel />}
            {section === 'storage' && <StoragePanel />}
            {section === 'mounts' && <ExternalMountsPanel />}
            {section === 'mail' && <MailPanel />}
            {section === 'webhooks' && <AdminWebhooksPanel />}
            {section === 'oauth-clients' && <AdminOauthClientsPanel />}
            {section === 'advanced' && <AdvancedPanel />}
            {section === 'backup' && <BackupPanel />}
          </div>
        </div>
      </main>
    </div>
  )
}

// ─── General ────────────────────────────────────────────────────────────────

type BrowseTarget = 'vault' | 'data'

function GeneralPanel() {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [vaultDraft, setVaultDraft] = useState('')
  const [dataDraft, setDataDraft] = useState('')
  const [savingPath, setSavingPath] = useState(false)
  const [savingData, setSavingData] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pathMsg, setPathMsg] = useState<string | null>(null)
  const [dataMsg, setDataMsg] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget>('vault')
  const [candidates, setCandidates] = useState<{ name: string; matches: string[]; target: BrowseTarget } | null>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    try {
      const [sysR, setR] = await Promise.all([api.adminSystem(), api.adminSettings()])
      setSys(sysR)
      setSettings(setR.settings)
      setVaultDraft(sysR.vaultRoot)
      setDataDraft(sysR.dataDir)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const saveVaultRoot = async (overridePath?: string) => {
    if (!sys) return
    const trimmed = (overridePath ?? vaultDraft).trim()
    if (!trimmed || trimmed === sys.vaultRoot) return
    setSavingPath(true)
    setError(null)
    setPathMsg(null)
    try {
      await api.adminPatchSettings({ vaultRoot: trimmed })
      await refresh()
      setPathMsg('Vault root updated.')
      setTimeout(() => setPathMsg(null), 2500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSavingPath(false)
    }
  }

  const saveDataDir = async (overridePath?: string) => {
    if (!sys) return
    const trimmed = (overridePath ?? dataDraft).trim()
    if (!trimmed || trimmed === sys.dataDir) return
    setSavingData(true)
    setError(null)
    setDataMsg(null)
    try {
      await api.adminSetDataDir(trimmed)
      setDataMsg('Data dir saved. Restart the server to apply.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSavingData(false)
    }
  }

  const onFolderPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || ''
    const folderName = rel.split('/')[0] || ''
    const target = browseTarget
    if (!folderName) {
      setError('Could not read folder name from the picker.')
      return
    }
    setBrowsing(true)
    setError(null)
    setPathMsg(null)
    setDataMsg(null)
    try {
      const r = await api.adminFindFolder(folderName)
      if (r.matches.length === 0) {
        setError(
          `No folder named "${folderName}" found under your home dir or /Volumes. Paste the absolute path manually.`,
        )
      } else if (r.matches.length === 1) {
        if (target === 'vault') {
          setVaultDraft(r.matches[0])
          saveVaultRoot(r.matches[0])
        } else {
          setDataDraft(r.matches[0])
          saveDataDir(r.matches[0])
        }
      } else {
        setCandidates({ name: folderName, matches: r.matches, target })
      }
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : String(e2))
    } finally {
      setBrowsing(false)
    }
  }

  const pickCandidate = (p: string) => {
    const target = candidates?.target ?? 'vault'
    setCandidates(null)
    if (target === 'vault') {
      setVaultDraft(p)
      saveVaultRoot(p)
    } else {
      setDataDraft(p)
      saveDataDir(p)
    }
  }

  const openBrowse = (t: BrowseTarget) => {
    setBrowseTarget(t)
    folderInputRef.current?.click()
  }


  if (error && !sys) return <ErrText text={error} />
  if (!sys || !settings) return <Muted text="Loading…" />

  const vaultDirty = vaultDraft.trim() !== '' && vaultDraft.trim() !== sys.vaultRoot

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Locations">
        <input
          ref={folderInputRef}
          type="file"
          /* @ts-expect-error - non-standard but widely supported folder-pick attrs */
          webkitdirectory=""
          directory=""
          style={{ display: 'none' }}
          onChange={onFolderPicked}
        />
        <FieldRow label="Vault root">
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="/absolute/path/to/vault"
              value={vaultDraft}
              onChange={(e) => setVaultDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveVaultRoot()}
            />
            <button
              className="btn-ghost h-8 w-8 px-0 shrink-0"
              disabled={browsing || savingPath}
              onClick={() => openBrowse('vault')}
              title="Browse — pick a folder via Finder"
              aria-label="Browse for folder"
            >
              {browsing && browseTarget === 'vault' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FolderSearch size={13} />
              )}
            </button>
          </div>
        </FieldRow>
        <FieldRow label="Data dir">
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="/absolute/path/to/data"
              value={dataDraft}
              onChange={(e) => setDataDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveDataDir()}
            />
            <button
              className="btn-ghost h-8 w-8 px-0 shrink-0"
              disabled={browsing || savingData}
              onClick={() => openBrowse('data')}
              title="Browse — pick a folder via Finder"
              aria-label="Browse for folder"
            >
              {browsing && browseTarget === 'data' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FolderSearch size={13} />
              )}
            </button>
          </div>
        </FieldRow>
        {dataMsg && (
          <div
            className="mt-1 px-3 py-2 rounded text-[11.5px]"
            style={{ background: '#FFFAE6', color: '#974F0C', border: '1px solid #FFE0AC' }}
          >
            {dataMsg}
          </div>
        )}
        <Hint>Restart the server after changing either path. Existing data isn't moved automatically.</Hint>
      </Card>

      <SaveBar
        onSave={async () => {
          if (vaultDirty) await saveVaultRoot()
          if (dataDraft.trim() !== sys.dataDir) await saveDataDir()
        }}
        saving={savingPath || savingData}
        msg={pathMsg}
        disabled={!vaultDirty && dataDraft.trim() === sys.dataDir}
      />

      {candidates && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'var(--scrim)' }}
          onClick={() => setCandidates(null)}
        >
          <div
            className="w-full max-w-[520px] rounded-lg shadow-card overflow-hidden flex flex-col"
            style={{ background: 'var(--panel)', maxHeight: '70vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-3 h-10 border-b"
              style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
            >
              <FolderSearch size={14} className="text-accent" />
              <div className="text-[13px] font-semibold text-fg flex-1">
                Multiple folders named "{candidates.name}"
              </div>
              <button className="btn-ghost h-7 w-7 px-0" onClick={() => setCandidates(null)}>
                <X size={12} />
              </button>
            </div>
            <div className="px-3 py-2 text-[11.5px] text-muted">
              Pick the correct absolute path:
            </div>
            <div className="flex-1 overflow-y-auto pb-2">
              {candidates.matches.map((p) => (
                <button
                  key={p}
                  onClick={() => pickCandidate(p)}
                  className="w-full flex items-center gap-2 px-3 h-8 text-left text-[12.5px] text-fg hover:bg-hover transition-colors"
                >
                  <Folder size={13} className="text-accent shrink-0" />
                  <span className="truncate">{p}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Search & embeddings ────────────────────────────────────────────────────

function EmbeddingsPanel() {
  const { refreshWorkspace } = useVault()
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [enabled, setEnabled] = useState<boolean>(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [chatEnabled, setChatEnabled] = useState<boolean>(true)
  const [chatModel, setChatModel] = useState('')
  const [chunkChars, setChunkChars] = useState<number | ''>('')
  const [chunkOverlap, setChunkOverlap] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])

  const refresh = async () => {
    try {
      const r = await api.adminSystem()
      setSys(r)
      setEnabled(r.ollama.enabled)
      setBaseUrl(r.ollama.baseUrl)
      setEmbedModel(r.ollama.embedModel)
      setChatEnabled(r.ollama.chatEnabled)
      setChatModel(r.ollama.chatModel)
      setChunkChars(r.ingest.chunkChars)
      setChunkOverlap(r.ingest.chunkOverlap)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
    try {
      const r = await api.adminOllamaModels()
      setAvailableModels(r.models)
    } catch {
      setAvailableModels([])
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    setMsg(null)
    try {
      await api.adminPatchSettings({
        ollama: {
          enabled,
          baseUrl: baseUrl.trim(),
          embedModel: embedModel.trim(),
          chatEnabled,
          chatModel: chatModel.trim(),
        },
        ingest: {
          chunkChars: typeof chunkChars === 'number' ? chunkChars : undefined,
          chunkOverlap: typeof chunkOverlap === 'number' ? chunkOverlap : undefined,
        },
      })
      await refresh()
      // Push the new chatEnabled into VaultContext so the doc viewer
      // hides/shows the Reader AI dock without a page reload.
      await refreshWorkspace()
      setMsg('Saved.')
      setTimeout(() => setMsg(null), 2500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!sys && !error) return <Muted text="Loading…" />
  if (!sys) return <ErrText text={error || 'failed'} />

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Ollama">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={() => setEnabled((v) => !v)} disabled={saving} />
          <span className="text-[12.5px] text-fg font-medium flex-1">Embeddings</span>
          {sys.ollama.available ? (
            <Badge color="#00875A" icon={<CheckCircle2 size={11} />}>connected</Badge>
          ) : sys.ollama.enabled ? (
            <Badge color="#BF2600" icon={<XCircle size={11} />}>unreachable</Badge>
          ) : (
            <Badge color="#6B778C">off</Badge>
          )}
        </div>
        <FieldRow label="Endpoint">
          <input
            className="input"
            placeholder="http://localhost:11434"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Embed model">
          {availableModels.length > 0 ? (
            <select
              className="input"
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
            >
              {/* Include the current value even if it's no longer installed,
                  so the user can see and re-pick. */}
              {!availableModels.includes(embedModel) && embedModel && (
                <option value={embedModel}>{embedModel} (not installed)</option>
              )}
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              placeholder="nomic-embed-text"
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
            />
          )}
        </FieldRow>

        {/* Per-document AI chat. Toggleable independently of
            embeddings so an admin can search-only by turning chat
            off (or while picking the right chat model). */}
        <div className="flex items-center gap-3 mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
          <Toggle checked={chatEnabled} onChange={() => setChatEnabled((v) => !v)} disabled={saving} />
          <span className="text-[12.5px] text-fg font-medium">Per-document AI chat</span>
        </div>
        <FieldRow label="Chat model">
          {availableModels.length > 0 ? (
            <select
              className="input"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              disabled={!chatEnabled}
            >
              {!availableModels.includes(chatModel) && chatModel && (
                <option value={chatModel}>{chatModel} (not installed)</option>
              )}
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              placeholder="qwen2.5:7b-instruct"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              disabled={!chatEnabled}
            />
          )}
        </FieldRow>
      </Card>

      <Card title="Chunking">
        <FieldRow label="Chunk chars">
          <input
            type="number"
            className="input"
            value={chunkChars}
            onChange={(e) =>
              setChunkChars(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))
            }
          />
        </FieldRow>
        <FieldRow label="Chunk overlap">
          <input
            type="number"
            className="input"
            value={chunkOverlap}
            onChange={(e) =>
              setChunkOverlap(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))
            }
          />
        </FieldRow>
      </Card>

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}


// ─── Storage ────────────────────────────────────────────────────────────────

function StoragePanel() {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [backend, setBackend] = useState<'local' | 's3'>('local')
  const [maxMB, setMaxMB] = useState<number | ''>('')
  const [s3, setS3] = useState({
    endpoint: '',
    bucket: '',
    accessKey: '',
    secretKey: '',
    region: '',
    forcePathStyle: false,
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<{
    scanned: number
    ingested: number
    updated: number
    skipped: number
  } | null>(null)

  const refresh = async () => {
    try {
      const r = await api.adminSystem()
      setSys(r)
      setBackend(r.storage.backend)
      setMaxMB(Math.round(r.ingest.maxFileBytes / (1024 * 1024)))
      setS3({
        endpoint: r.storage.s3.endpoint || '',
        bucket: r.storage.s3.bucket || '',
        accessKey: r.storage.s3.accessKey || '',
        secretKey: '',
        region: r.storage.s3.region || '',
        forcePathStyle: !!r.storage.s3.forcePathStyle,
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    setMsg(null)
    try {
      const r = await api.adminPatchSettings({
        ingest: {
          maxFileBytes: typeof maxMB === 'number' ? Math.max(1, maxMB) * 1024 * 1024 : undefined,
        },
        storage: {
          backend,
          s3: {
            endpoint: s3.endpoint,
            bucket: s3.bucket,
            accessKey: s3.accessKey,
            ...(s3.secretKey ? { secretKey: s3.secretKey } : {}),
            region: s3.region,
            forcePathStyle: s3.forcePathStyle,
          },
        },
      })
      await refresh()
      setMsg(r.restartRequired ? 'Saved. Restart required for backend/credentials.' : 'Saved.')
      setTimeout(() => setMsg(null), 4000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const runReconcile = async () => {
    if (reconciling) return
    setReconciling(true)
    setReconcileResult(null)
    setError(null)
    try {
      const r = await api.adminReconcileVault()
      setReconcileResult(r)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setReconciling(false)
    }
  }

  if (!sys && !error) return <Muted text="Loading…" />
  if (!sys) return <ErrText text={error || 'failed'} />

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Uploads">
        <FieldRow label="Max upload (MB)">
          <input
            type="number"
            className="input"
            value={maxMB}
            onChange={(e) =>
              setMaxMB(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))
            }
          />
        </FieldRow>
      </Card>

      <Card title="Reconcile vault">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            className="btn-primary h-8"
            onClick={runReconcile}
            disabled={reconciling}
          >
            {reconciling ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            Reconcile now
          </button>
          {reconcileResult && (
            <div className="text-[11.5px] text-subtle">
              Scanned {reconcileResult.scanned} · ingested{' '}
              <span className="text-fg font-semibold">
                {reconcileResult.ingested}
              </span>{' '}
              new · updated {reconcileResult.updated}
              {reconcileResult.skipped > 0 && (
                <span style={{ color: '#BF2600' }}>
                  {' '}· {reconcileResult.skipped} failed
                </span>
              )}
            </div>
          )}
        </div>
        <Hint>
          Walks every user's vault folder and ingests any supported file
          that isn't currently indexed. Use after dropping files in via
          Finder / rsync, or to recover after a bulk-delete leaves orphan
          files on disk. Already-indexed files cost just a sha check.
        </Hint>
      </Card>

      <Card title="Backend">
        <FieldRow label="Backend">
          <select
            className="input"
            value={backend}
            onChange={(e) => setBackend(e.target.value as 'local' | 's3')}
          >
            <option value="local">Local disk</option>
            <option value="s3">S3 / MinIO / R2</option>
          </select>
        </FieldRow>
      </Card>

      {backend === 's3' && (
        <Card title="S3 credentials">
          <FieldRow label="Endpoint">
            <input
              className="input"
              placeholder="https://s3.amazonaws.com"
              value={s3.endpoint}
              onChange={(e) => setS3({ ...s3, endpoint: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Bucket">
            <input
              className="input"
              value={s3.bucket}
              onChange={(e) => setS3({ ...s3, bucket: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Region">
            <input
              className="input"
              value={s3.region}
              onChange={(e) => setS3({ ...s3, region: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Access key">
            <input
              className="input"
              value={s3.accessKey}
              onChange={(e) => setS3({ ...s3, accessKey: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Secret key">
            <input
              type="password"
              className="input"
              placeholder={sys.storage.s3.endpoint ? '(stored — leave blank to keep)' : ''}
              value={s3.secretKey}
              onChange={(e) => setS3({ ...s3, secretKey: e.target.value })}
            />
          </FieldRow>
          <div className="flex items-center gap-2 pt-1">
            <Toggle
              checked={s3.forcePathStyle}
              onChange={() => setS3({ ...s3, forcePathStyle: !s3.forcePathStyle })}
              disabled={saving}
            />
            <span className="text-[12.5px] text-fg">Force path-style URLs (MinIO, R2)</span>
          </div>
        </Card>
      )}

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}

// ─── Email (SMTP) ───────────────────────────────────────────────────────────

function MailPanel() {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState<number | ''>(587)
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [from, setFrom] = useState('')
  const [secure, setSecure] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const r = await api.adminSystem()
      setSys(r)
      setEnabled(r.smtp.enabled)
      setHost(r.smtp.host)
      setPort(r.smtp.port)
      setUser(r.smtp.user)
      setFrom(r.smtp.from)
      setSecure(r.smtp.secure)
      setPass('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    setMsg(null)
    try {
      await api.adminPatchSettings({
        smtp: {
          enabled,
          host: host.trim(),
          port: typeof port === 'number' ? port : undefined,
          user: user.trim(),
          ...(pass ? { pass } : {}),
          from: from.trim(),
          secure,
        },
      })
      await refresh()
      setMsg('Saved.')
      setTimeout(() => setMsg(null), 2500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    if (!testTo.trim()) return
    setTesting(true)
    setError(null)
    setMsg(null)
    try {
      await api.adminTestSmtp(testTo.trim())
      setMsg(`Test email sent to ${testTo.trim()}.`)
      setTimeout(() => setMsg(null), 3500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  if (!sys && !error) return <Muted text="Loading…" />
  if (!sys) return <ErrText text={error || 'failed'} />

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="SMTP">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={() => setEnabled((v) => !v)} disabled={saving} />
          <span className="text-[12.5px] text-fg font-medium">Send emails via SMTP</span>
        </div>
        <FieldRow label="Host">
          <input
            className="input"
            placeholder="smtp.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Port">
          <input
            type="number"
            className="input"
            value={port}
            onChange={(e) =>
              setPort(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))
            }
          />
        </FieldRow>
        <div className="flex items-center gap-2 pt-1">
          <Toggle checked={secure} onChange={() => setSecure((v) => !v)} disabled={saving} />
          <span className="text-[12.5px] text-fg">TLS on connect</span>
        </div>
        <FieldRow label="From">
          <input
            className="input"
            placeholder='"Reader" <noreply@example.com>'
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Username">
          <input
            className="input"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Password">
          <input
            type="password"
            className="input"
            placeholder={sys.smtp.passSet ? '(stored — leave blank to keep)' : ''}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </FieldRow>
      </Card>

      <Card title="Test">
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            placeholder="recipient@example.com"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && test()}
          />
          <button className="btn-primary" onClick={test} disabled={testing || !testTo.trim()}>
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Send test
          </button>
        </div>
      </Card>

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}

// ─── Backup ─────────────────────────────────────────────────────────────────

function BackupPanel() {
  const [enabled, setEnabled] = useState(false)
  const [schedule, setSchedule] = useState<'daily' | 'weekly'>('daily')
  const [time, setTime] = useState('03:00')
  const [weekday, setWeekday] = useState(0)
  const [outDir, setOutDir] = useState('')
  const [retainDays, setRetainDays] = useState<number | ''>(0)
  const [state, setState] = useState<{
    lastRunAt: number | null
    lastSuccessAt: number | null
    lastFile: string | null
    lastBytes: number | null
    lastError: string | null
    nextFireAt: number | null
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const [s, st] = await Promise.all([api.adminSettings(), api.adminBackupState()])
      const b = s.settings.backup ?? {}
      setEnabled(!!b.enabled)
      setSchedule((b.schedule ?? 'daily') as 'daily' | 'weekly')
      setTime(b.time ?? '03:00')
      setWeekday(b.weekday ?? 0)
      setOutDir(b.outDir ?? '')
      setRetainDays(b.retainDays ?? 0)
      setState(st)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    setMsg(null)
    try {
      await api.adminPatchSettings({
        backup: {
          enabled,
          schedule,
          time,
          weekday: schedule === 'weekly' ? weekday : undefined,
          outDir: outDir.trim() || undefined,
          retainDays: typeof retainDays === 'number' ? retainDays : 0,
        },
      })
      await refresh()
      setMsg('Saved.')
      setTimeout(() => setMsg(null), 2500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    setRunningNow(true)
    setError(null)
    setMsg(null)
    try {
      const r = await api.adminBackupRunNow()
      setState(r)
      setMsg('Backup complete.')
      setTimeout(() => setMsg(null), 3500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRunningNow(false)
    }
  }

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Scheduled backup">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={() => setEnabled((v) => !v)} disabled={saving} />
          <span className="text-[12.5px] text-fg font-medium">
            Run a tar.gz snapshot of <code className="text-[11.5px]">/data</code> + <code className="text-[11.5px]">/vault</code> on a schedule
          </span>
        </div>
        <FieldRow label="Cadence">
          <select
            className="input"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value as 'daily' | 'weekly')}
            disabled={!enabled || saving}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </FieldRow>
        <FieldRow label="Time">
          <input
            type="time"
            className="input"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={!enabled || saving}
          />
        </FieldRow>
        {schedule === 'weekly' && (
          <FieldRow label="Day">
            <select
              className="input"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              disabled={!enabled || saving}
            >
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </FieldRow>
        )}
        <FieldRow label="Output directory">
          <input
            className="input"
            placeholder="(default: $DATA_DIR/backups)"
            value={outDir}
            onChange={(e) => setOutDir(e.target.value)}
            disabled={saving}
          />
        </FieldRow>
        <FieldRow label="Retain (days)">
          <input
            type="number"
            min={0}
            className="input"
            value={retainDays}
            onChange={(e) =>
              setRetainDays(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))
            }
            disabled={saving}
          />
        </FieldRow>
        <div className="text-[11.5px] text-subtle">
          Retain = 0 keeps every archive. Otherwise older `reader-backup-*.tar.gz` files
          in the output dir are pruned after each run.
        </div>
      </Card>

      <Card title="Status">
        <div className="space-y-1.5 text-[12.5px]">
          <StatusLine label="Next backup" value={fmtAbsTs(state?.nextFireAt)} />
          <StatusLine label="Last run" value={fmtAbsTs(state?.lastRunAt)} />
          <StatusLine label="Last success" value={fmtAbsTs(state?.lastSuccessAt)} />
          <StatusLine label="Last file" value={state?.lastFile ?? '—'} />
          <StatusLine
            label="Last size"
            value={state?.lastBytes != null ? `${(state.lastBytes / 1024 / 1024).toFixed(1)} MB` : '—'}
          />
          {state?.lastError && (
            <div
              className="text-[11.5px] mt-2 px-2 py-1.5 rounded"
              style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
            >
              Last error: {state.lastError}
            </div>
          )}
        </div>
        <div className="pt-2">
          <button className="btn-primary" onClick={runNow} disabled={runningNow}>
            {runningNow ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            Backup now
          </button>
        </div>
      </Card>

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-subtle min-w-[110px]">{label}</span>
      <span className="text-fg font-mono text-[11.5px] break-all">{value}</span>
    </div>
  )
}

function fmtAbsTs(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString()
}

// ─── Server & sessions ──────────────────────────────────────────────────────

function AdvancedPanel() {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState<number | ''>('')
  const [ttlDays, setTtlDays] = useState<number | ''>('')
  const [cookieSecure, setCookieSecure] = useState(false)
  const [cookieSameSite, setCookieSameSite] = useState<'lax' | 'strict' | 'none'>('lax')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const r = await api.adminSystem()
      setSys(r)
      setHost(r.server.host)
      setPort(r.server.port)
      setTtlDays(r.session.ttlDays)
      setCookieSecure(r.session.cookieSecure)
      setCookieSameSite(r.session.cookieSameSite)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    setMsg(null)
    try {
      await api.adminPatchSettings({
        server: {
          host: host.trim(),
          port: typeof port === 'number' ? port : undefined,
        },
        session: {
          ttlDays: typeof ttlDays === 'number' ? ttlDays : undefined,
          cookieSecure,
          cookieSameSite,
        },
      })
      await refresh()
      setMsg('Saved. Restart the server to apply.')
      setTimeout(() => setMsg(null), 4000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!sys && !error) return <Muted text="Loading…" />
  if (!sys) return <ErrText text={error || 'failed'} />

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Server">
        <FieldRow label="Host">
          <input
            className="input"
            placeholder="127.0.0.1"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Port">
          <input
            type="number"
            className="input"
            value={port}
            onChange={(e) =>
              setPort(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))
            }
          />
        </FieldRow>

      </Card>

      <Card title="Sessions">
        <FieldRow label="Session TTL (days)">
          <input
            type="number"
            className="input"
            value={ttlDays}
            onChange={(e) =>
              setTtlDays(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))
            }
          />
        </FieldRow>
        <FieldRow label="Cookie SameSite">
          <select
            className="input"
            value={cookieSameSite}
            onChange={(e) => setCookieSameSite(e.target.value as 'lax' | 'strict' | 'none')}
          >
            <option value="lax">lax</option>
            <option value="strict">strict</option>
            <option value="none">none</option>
          </select>
        </FieldRow>
        <div className="flex items-center gap-2 pt-1">
          <Toggle
            checked={cookieSecure}
            onChange={() => setCookieSecure((v) => !v)}
            disabled={saving}
          />
          <span className="text-[12.5px] text-fg">HTTPS-only cookies</span>
        </div>

      </Card>

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}

// ─── Users ──────────────────────────────────────────────────────────────────

function UsersPanel() {
  const confirm = useConfirm()
  const [users, setUsers] = useState<PublicUser[] | null>(null)
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [savingSignup, setSavingSignup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<Role>('viewer')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editQuotaMB, setEditQuotaMB] = useState<string>('')

  const refresh = () =>
    api
      .adminUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
    api
      .adminSettings()
      .then((r) => setSettings(r.settings))
      .catch(() => null)
  }, [])

  const toggleSignup = async () => {
    if (!settings) return
    setSavingSignup(true)
    setError(null)
    try {
      const r = await api.adminPatchSettings({ allowOpenSignup: !settings.allowOpenSignup })
      setSettings(r.settings)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSavingSignup(false)
    }
  }

  const create = async () => {
    if (!newUsername.trim() || newPassword.length < 8) return
    setBusy(true)
    setError(null)
    try {
      await api.adminCreateUser(newUsername.trim(), newPassword, newRole)
      setNewUsername('')
      setNewPassword('')
      setNewRole('viewer')
      setAddOpen(false)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openAdd = () => {
    setNewUsername('')
    setNewPassword('')
    setNewRole('viewer')
    setError(null)
    setAddOpen(true)
  }

  const startEdit = (u: PublicUser) => {
    setEditing(u.username)
    setEditQuotaMB(u.quotaBytes ? String(Math.round(u.quotaBytes / (1024 * 1024))) : '')
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      const parsed = editQuotaMB.trim() === '' ? null : Math.max(0, Number(editQuotaMB))
      const quotaBytes = parsed == null ? null : Math.round(parsed * 1024 * 1024)
      await api.adminPatchUser(editing, { quotaBytes })
      setEditing(null)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const updateRole = async (u: PublicUser, role: Role) => {
    try {
      await api.adminPatchUser(u.username, { role })
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const toggleDisabled = async (u: PublicUser) => {
    try {
      await api.adminPatchUser(u.username, { disabled: !u.disabled })
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const remove = async (u: PublicUser) => {
    const ok = await confirm({
      title: 'Delete user',
      message: `"${u.username}" and their session tokens will be removed. Files on disk are not deleted; an admin can re-create the user later to regain access.`,
      confirmLabel: 'Delete user',
      destructive: true,
    })
    if (!ok) return
    try {
      await api.adminDeleteUser(u.username)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-5">
      {addOpen && (
        <Modal title="Add user" onClose={() => setAddOpen(false)} width={420}>
          <div className="space-y-2">
            <input
              className="input"
              placeholder="Username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              autoFocus
            />
            <input
              type="password"
              className="input"
              placeholder="Password (8+ chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <select
              className="input"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="text-[11.5px] text-subtle mt-2.5">
            Starts with an empty, isolated workspace.
          </div>
          {error && (
            <div className="text-[12px] mt-2" style={{ color: '#BF2600' }}>
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button className="btn-ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={create}
              disabled={busy || !newUsername.trim() || newPassword.length < 8}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={14} />}
              Create
            </button>
          </div>
        </Modal>
      )}

      {error && <ErrText text={error} />}

      <Card
        title={`Users${users ? ` · ${users.length}` : ''}`}
        action={
          <button className="btn-primary h-7" onClick={openAdd}>
            <UserPlus size={13} />
            Add user
          </button>
        }
      >
        <div className="rounded border border-app overflow-hidden">
          <table className="w-full text-[13px]">
            <thead style={{ background: 'var(--panel)' }}>
              <tr className="text-left text-[11px] uppercase tracking-wider text-subtle">
                <th className="px-3 py-2 font-semibold">Username</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Created</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <Fragment key={u.username}>
                  <tr className="border-t border-soft" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-2 font-medium text-fg">{u.username}</td>
                    <td className="px-3 py-2">
                      <select
                        className="input h-7 text-[12px]"
                        style={{ width: 110 }}
                        value={u.role}
                        onChange={(e) => updateRole(u, e.target.value as Role)}
                      >
                        <option value="viewer">viewer</option>
                        <option value="editor">editor</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        className="inline-flex items-center px-1.5 h-5 rounded text-[10px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80"
                        title={u.disabled ? 'Click to enable' : 'Click to disable'}
                        style={
                          u.disabled
                            ? {
                                background: 'color-mix(in srgb, #BF2600 12%, transparent)',
                                color: '#BF2600',
                              }
                            : {
                                background: 'color-mix(in srgb, #00875A 12%, transparent)',
                                color: '#00875A',
                              }
                        }
                        onClick={() => toggleDisabled(u)}
                      >
                        {u.disabled ? 'Disabled' : 'Active'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        className="btn-ghost"
                        onClick={() => (editing === u.username ? setEditing(null) : startEdit(u))}
                        title="Edit access"
                      >
                        Access
                      </button>
                      <button className="btn-ghost ml-1" onClick={() => remove(u)} title="Delete user">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                  {editing === u.username && (
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td colSpan={5} className="px-3 py-2" style={{ background: 'var(--panel)' }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                            Quota
                          </span>
                          <input
                            type="number"
                            min={0}
                            className="input h-7 text-[12px]"
                            style={{ width: 120 }}
                            placeholder="Unlimited"
                            value={editQuotaMB}
                            onChange={(e) => setEditQuotaMB(e.target.value)}
                          />
                          <span className="text-[11px] text-subtle">MB</span>
                          <div className="flex-1" />
                          <button className="btn-ghost h-7" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button className="btn-primary h-7" onClick={saveEdit}>
                            Save
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {users && users.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-muted">No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {settings && (
        <Card title="Sign-ups">
          <div className="flex items-center gap-3">
            <Toggle
              checked={settings.allowOpenSignup}
              disabled={savingSignup}
              onChange={toggleSignup}
            />
            <span className="text-[12.5px] text-fg font-medium">
              Anyone can create an account
            </span>
          </div>
        </Card>
      )}
    </div>
  )
}


function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ─── Duplicates ─────────────────────────────────────────────────────────────

function DuplicatesPanel() {
  const confirm = useConfirm()
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof api.adminDuplicates>>['groups'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = () =>
    api
      .adminDuplicates()
      .then((r) => setGroups(r.groups))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const trash = async (storageKey: string) => {
    const ok = await confirm({
      title: 'Move to Trash',
      message: `"${storageKey}" goes to Trash where it can still be restored. Purges automatically after 30 days.`,
      confirmLabel: 'Move to Trash',
      destructive: true,
    })
    if (!ok) return
    setBusy(storageKey)
    setError(null)
    try {
      await api.deleteFile(storageKey)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrText text={error} />
  if (!groups) return <Muted text="Loading…" />
  if (groups.length === 0) return <Muted text="No duplicates — every file's sha256 + perceptual hash is unique." />

  return (
    <div className="space-y-5">
      <Hint>
        <strong>Exact</strong> = byte-identical. <strong>Near</strong> = visually identical (resized, recompressed, cropped).
      </Hint>
      {groups.map((g) => (
        <Card
          key={g.kind === 'exact' ? `sha:${g.sha256}` : `phash:${g.pHash}`}
          title={
            g.kind === 'exact'
              ? `${g.docs.length} exact copies • ${formatBytes(g.bytes)} each`
              : `${g.docs.length} near-duplicates`
          }
        >
          <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
            {g.kind === 'exact' ? 'sha256' : 'pHash (dHash)'}
          </div>
          <code className="text-[11px] text-muted break-all block mb-2">
            {g.kind === 'exact' ? g.sha256 : g.pHash}
          </code>
          <div className="rounded border border-app overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead style={{ background: 'var(--panel)' }}>
                <tr className="text-left text-[11px] uppercase tracking-wider text-subtle">
                  <th className="px-3 py-1.5 font-semibold">Path</th>
                  <th className="px-3 py-1.5 font-semibold">Owner</th>
                  <th className="px-3 py-1.5 font-semibold">Uploaded</th>
                  <th className="px-3 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {g.docs.map((d, i) => (
                  <tr key={d.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 text-fg break-all">
                      {d.storageKey}
                      {i === 0 && (
                        <span className="ml-1 text-[10.5px] text-subtle">(oldest)</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-muted">{d.owner}</td>
                    <td className="px-3 py-1.5 text-muted">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        className="btn-ghost"
                        disabled={busy === d.storageKey}
                        onClick={() => trash(d.storageKey)}
                        style={{ color: '#BF2600' }}
                      >
                        {busy === d.storageKey ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                        Trash
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  )
}


// ─── Shared atoms ───────────────────────────────────────────────────────────

function Modal({
  title,
  width,
  onClose,
  children,
}: {
  title: string
  width?: number
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Render into document.body so no ancestor (transform / overflow / etc.)
  // can clip the backdrop. Explicit top/left/right/bottom guarantees full
  // viewport coverage independent of Tailwind purging or stacking quirks.
  return createPortal(
    <div
      className="flex items-start justify-center px-4"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100,
        background: 'rgba(9, 30, 66, 0.42)',
        paddingTop: '10vh',
      }}
      onClick={onClose}
    >
      <div
        className="w-full rounded-lg shadow-card overflow-hidden flex flex-col"
        style={{ background: 'var(--panel)', maxWidth: width ?? 640, maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-4 h-10 border-b shrink-0"
          style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
        >
          <div className="text-[13px] font-semibold text-fg flex-1">{title}</div>
          <button className="btn-ghost h-7 w-7 px-0" onClick={onClose}>
            <X size={12} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

function Card({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div
        className="flex items-center justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="text-[14px] font-semibold text-fg">{title}</div>
        {action}
      </div>
      <div className="space-y-4 pl-0.5">{children}</div>
    </section>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="text-[11.5px] text-subtle leading-relaxed">{children}</div>
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

function SaveBar({
  onSave,
  saving,
  msg,
  disabled,
}: {
  onSave: () => void
  saving: boolean
  msg: string | null
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <button className="btn-primary" onClick={onSave} disabled={saving || disabled}>
        {saving ? <Loader2 size={13} className="animate-spin" /> : null}
        Save
      </button>
      {msg && (
        <span className="text-[11.5px]" style={{ color: '#00875A' }}>
          {msg}
        </span>
      )}
    </div>
  )
}

function Muted({ text }: { text: string }) {
  return <div className="text-[13px] text-muted">{text}</div>
}

function ErrText({ text }: { text: string }) {
  return (
    <div className="text-[12.5px] px-3 py-2 rounded" style={{ color: '#BF2600', background: '#FFEBE6' }}>
      {text}
    </div>
  )
}


function Badge({ children, color, icon }: { children: React.ReactNode; color: string; icon?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color }}>
      {icon}
      {children}
    </span>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className="relative inline-block w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5"
      style={{
        background: checked ? 'var(--accent)' : 'var(--border)',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
        style={{ left: 2, transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}


/**
 * Read-only external library mounts — admin-only config that exposes
 * on-disk folders as virtual sidebar entries for every signed-in user.
 * Strictly read; the server refuses writes under these paths.
 */
function ExternalMountsPanel() {
  const confirm = useConfirm()
  const [mounts, setMounts] = useState<
    Array<{ id: string; name: string; absPath: string; createdAt: number }> | null
  >(null)
  const [name, setName] = useState('')
  const [absPath, setAbsPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    api
      .adminListExternalMounts()
      .then((r) => setMounts(r.mounts))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const add = async () => {
    if (!name.trim() || !absPath.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.adminCreateExternalMount({ name: name.trim(), absPath: absPath.trim() })
      setName('')
      setAbsPath('')
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const ok = await confirm({
      title: 'Remove mount',
      message: 'Users will lose sidebar access to this library. Files on disk are not affected.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!ok) return
    try {
      await api.adminDeleteExternalMount(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="px-3 py-2 rounded text-[12.5px]"
          style={{ background: '#FFEBE6', color: '#BF2600' }}
        >
          {error}
        </div>
      )}

      <Card title="Add a mount">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="input flex-1 h-8 text-[12.5px]"
            placeholder="Display name (e.g., Family Photos)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <input
            className="input flex-[2] h-8 text-[12.5px]"
            placeholder="Absolute path (e.g., /Users/me/Photos)"
            value={absPath}
            onChange={(e) => setAbsPath(e.target.value)}
            disabled={busy}
          />
          <button className="btn-ghost" onClick={add} disabled={busy || !name || !absPath}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Add
          </button>
        </div>
        <Hint>Read-only mounts appear in the sidebar for every user. Never written, never indexed.</Hint>
      </Card>

      <Card title="Current mounts">
        {!mounts ? (
          <div className="text-[12.5px] text-muted inline-flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : mounts.length === 0 ? (
          <div className="text-[12.5px] text-subtle">None configured.</div>
        ) : (
          <div className="space-y-1.5">
            {mounts.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 px-3 py-2 rounded"
                style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
              >
                <HardDrive size={14} className="text-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-fg truncate">{m.name}</div>
                  <div className="text-[11px] text-subtle truncate" title={m.absPath}>
                    {m.absPath}
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  onClick={() => remove(m.id)}
                  title="Remove mount"
                  aria-label="Remove mount"
                  style={{ color: '#BF2600' }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
