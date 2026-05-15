import { Fragment, useEffect, useRef, useState } from 'react'
import {
  Copy,
  Plus,
  Trash2,
  X,
  KeyRound,
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
  RotateCcw,
} from 'lucide-react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import {
  ApiError,
  api,
  type ApiTokenInfo,
  type Grant,
  type PublicUser,
  type Role,
  type SystemInfo,
  type WorkspaceSettings,
} from '../lib/api'
import { PermissionTree } from './PermissionTree'

const ROLE_PRESETS: Record<Role, Grant[]> = {
  admin: [],
  editor: [{ path: '', read: true, write: true, create: true }],
  viewer: [{ path: '', read: true, write: false, create: false }],
}

type Section = 'general' | 'users' | 'trash' | 'embeddings' | 'storage' | 'mail' | 'advanced' | 'tokens'

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
      { id: 'trash', label: 'Trash', icon: Trash2 },
    ],
  },
  {
    label: 'Data',
    items: [
      { id: 'embeddings', label: 'Search & embeddings', icon: Sparkles },
      { id: 'storage', label: 'Storage', icon: Database },
    ],
  },
  {
    label: 'Notifications',
    items: [{ id: 'mail', label: 'Email (SMTP)', icon: Mail }],
  },
  {
    label: 'Access',
    items: [
      { id: 'tokens', label: 'API tokens', icon: KeyRound },
      { id: 'advanced', label: 'Server & sessions', icon: Settings },
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
          style={{ borderColor: 'var(--border-soft)' }}
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
                    className={clsx(
                      'w-full flex items-center gap-2 px-2 h-7 rounded text-[13px] text-left transition-colors',
                      !isActive && 'hover:bg-hover',
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
            {section === 'trash' && <TrashPanel />}
            {section === 'embeddings' && <EmbeddingsPanel />}
            {section === 'storage' && <StoragePanel />}
            {section === 'mail' && <MailPanel />}
            {section === 'advanced' && <AdvancedPanel />}
            {section === 'tokens' && <TokensPanel />}
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
  const [savingSignup, setSavingSignup] = useState(false)
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
      setDataMsg('Data dir saved. Restart the server to use the new location. Existing data is NOT auto-moved.')
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

  if (error && !sys) return <ErrText text={error} />
  if (!sys || !settings) return <Muted text="Loading…" />

  const vaultDirty = vaultDraft.trim() !== '' && vaultDraft.trim() !== sys.vaultRoot

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Locations">
        <div>
          <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1">
            Vault root
          </div>
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="/absolute/path/to/vault"
              value={vaultDraft}
              onChange={(e) => setVaultDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveVaultRoot()}
            />
            <input
              ref={folderInputRef}
              type="file"
              /* @ts-expect-error - non-standard but widely supported folder-pick attrs */
              webkitdirectory=""
              directory=""
              style={{ display: 'none' }}
              onChange={onFolderPicked}
            />
            <button
              className="btn-ghost"
              disabled={browsing || savingPath}
              onClick={() => openBrowse('vault')}
              title="Pick a folder via Finder"
            >
              {browsing && browseTarget === 'vault' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FolderSearch size={13} />
              )}
              Browse
            </button>
            <button
              className="btn-primary"
              disabled={!vaultDirty || savingPath}
              onClick={() => saveVaultRoot()}
            >
              {savingPath ? <Loader2 size={13} className="animate-spin" /> : null}
              Save
            </button>
            {vaultDirty && (
              <button
                className="btn-ghost"
                disabled={savingPath}
                onClick={() => setVaultDraft(sys.vaultRoot)}
              >
                Reset
              </button>
            )}
          </div>
          {pathMsg && (
            <div className="mt-1.5 text-[11.5px]" style={{ color: '#00875A' }}>
              {pathMsg}
            </div>
          )}
        </div>

        <div className="border-t pt-3" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1">
            Data dir
          </div>
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="/absolute/path/to/data"
              value={dataDraft}
              onChange={(e) => setDataDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveDataDir()}
            />
            <button
              className="btn-ghost"
              disabled={browsing || savingData}
              onClick={() => openBrowse('data')}
              title="Pick a folder via Finder"
            >
              {browsing && browseTarget === 'data' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FolderSearch size={13} />
              )}
              Browse
            </button>
            <button
              className="btn-primary"
              disabled={dataDraft.trim() === sys.dataDir || savingData}
              onClick={() => saveDataDir()}
            >
              {savingData ? <Loader2 size={13} className="animate-spin" /> : null}
              Save
            </button>
            {dataDraft.trim() !== sys.dataDir && (
              <button
                className="btn-ghost"
                disabled={savingData}
                onClick={() => setDataDraft(sys.dataDir)}
              >
                Reset
              </button>
            )}
          </div>
          {dataMsg && (
            <div
              className="mt-2 px-3 py-2 rounded text-[11.5px]"
              style={{ background: '#FFFAE6', color: '#974F0C', border: '1px solid #FFE0AC' }}
            >
              {dataMsg}
            </div>
          )}
          <Hint>
            <strong>Existing data is not auto-migrated</strong> — move it manually before
            restarting.
          </Hint>
        </div>
      </Card>

      <Card title="Sign-ups">
        <div className="flex items-center gap-3">
          <Toggle
            checked={settings.allowOpenSignup}
            disabled={savingSignup}
            onChange={toggleSignup}
          />
          <span className="text-[12.5px] text-fg font-medium">Anyone can create an account</span>
        </div>
      </Card>

      {candidates && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(9, 30, 66, 0.42)' }}
          onClick={() => setCandidates(null)}
        >
          <div
            className="w-full max-w-[520px] rounded-lg shadow-card overflow-hidden flex flex-col"
            style={{ background: 'var(--panel)', maxHeight: '70vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-3 h-10 border-b"
              style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
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
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [enabled, setEnabled] = useState<boolean>(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [embedModel, setEmbedModel] = useState('')
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
        ollama: { enabled, baseUrl: baseUrl.trim(), embedModel: embedModel.trim() },
        ingest: {
          chunkChars: typeof chunkChars === 'number' ? chunkChars : undefined,
          chunkOverlap: typeof chunkOverlap === 'number' ? chunkOverlap : undefined,
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

  if (!sys && !error) return <Muted text="Loading…" />
  if (!sys) return <ErrText text={error || 'failed'} />

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Card title="Ollama">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={() => setEnabled((v) => !v)} disabled={saving} />
          <div className="flex-1 text-[12.5px]">
            <div className="font-medium text-fg">Embeddings enabled</div>
            <div className="text-muted mt-0.5">
              Status:{' '}
              {sys.ollama.available ? (
                <Badge color="#00875A" icon={<CheckCircle2 size={11} />}>connected</Badge>
              ) : sys.ollama.enabled ? (
                <Badge color="#BF2600" icon={<XCircle size={11} />}>unreachable</Badge>
              ) : (
                <Badge color="#6B778C">disabled</Badge>
              )}
            </div>
          </div>
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

      <ReembedCard />

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}

function ReembedCard() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    total: number
    ok: number
    removed: number
    failed: number
    errors: { id: string; error: string }[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    if (!confirm('Re-index every document? Reads each file from disk, re-extracts, re-embeds.')) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.adminReembedAll()
      setResult({ total: r.total, ok: r.ok, removed: r.removed, failed: r.failed, errors: r.errors })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Re-index corpus">
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {busy ? 'Re-indexing…' : 'Re-index all'}
        </button>
        {result && (
          <span className="text-[12px]" style={{ color: result.failed === 0 ? '#00875A' : '#974F0C' }}>
            {result.ok} OK
            {result.removed > 0 ? `, ${result.removed} orphans cleaned` : ''}
            {result.failed > 0 ? `, ${result.failed} failed` : ''}
          </span>
        )}
        {error && (
          <span className="text-[12px]" style={{ color: '#BF2600' }}>
            {error}
          </span>
        )}
      </div>
      {result && result.errors.length > 0 && (
        <div
          className="rounded border text-[11.5px] mt-1"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
        >
          <div className="px-2.5 py-1.5 font-semibold text-subtle uppercase tracking-wider text-[10.5px] border-b" style={{ borderColor: 'var(--border-soft)' }}>
            Failures
          </div>
          <ul className="px-2.5 py-1.5 space-y-1">
            {result.errors.map((e, i) => (
              <li key={i} className="text-fg break-all">
                <code className="text-subtle">{e.id}</code> — <span style={{ color: '#BF2600' }}>{e.error}</span>
              </li>
            ))}
            {result.failed > result.errors.length && (
              <li className="text-subtle">…and {result.failed - result.errors.length} more</li>
            )}
          </ul>
        </div>
      )}
      <Hint>
        Re-reads each file from disk and runs extraction + embedding. Use after expanding
        the extractor (e.g. OCR added) or switching the embed model.
      </Hint>
    </Card>
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
          <span className="text-[12.5px] text-fg">TLS on connect (SMTPS, usually port 465)</span>
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
          <span className="text-[12.5px] text-fg">Cookie Secure (HTTPS-only)</span>
        </div>

      </Card>

      <SaveBar onSave={save} saving={saving} msg={msg} />
    </div>
  )
}

// ─── Users ──────────────────────────────────────────────────────────────────

function UsersPanel() {
  const [users, setUsers] = useState<PublicUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<Role>('viewer')
  const [newGrants, setNewGrants] = useState<Grant[]>(ROLE_PRESETS.viewer)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editGrants, setEditGrants] = useState<Grant[]>([])
  const [defaultGrants, setDefaultGrants] = useState<Grant[]>([])
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [defaultsMsg, setDefaultsMsg] = useState<string | null>(null)

  const refresh = () =>
    api
      .adminUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
    api
      .adminSettings()
      .then((r) => setDefaultGrants(r.settings.defaultGrants ?? ROLE_PRESETS.viewer))
      .catch(() => {})
  }, [])

  const setRolePreset = (role: Role) => {
    setNewRole(role)
    setNewGrants(role === 'admin' ? [] : ROLE_PRESETS[role])
  }

  const create = async () => {
    if (!newUsername.trim() || newPassword.length < 8) return
    setBusy(true)
    setError(null)
    try {
      await api.adminCreateUser(newUsername.trim(), newPassword, newRole, newGrants)
      setNewUsername('')
      setNewPassword('')
      setNewRole('viewer')
      setNewGrants(ROLE_PRESETS.viewer)
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
    setNewGrants(ROLE_PRESETS.viewer)
    setError(null)
    setAddOpen(true)
  }

  const startEdit = (u: PublicUser) => {
    setEditing(u.username)
    setEditGrants(u.grants ?? ROLE_PRESETS[u.role])
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      await api.adminPatchUser(editing, { grants: editGrants })
      setEditing(null)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const saveDefaults = async () => {
    setSavingDefaults(true)
    setDefaultsMsg(null)
    try {
      await api.adminPatchSettings({ defaultGrants })
      setDefaultsMsg('Saved.')
      setTimeout(() => setDefaultsMsg(null), 2500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSavingDefaults(false)
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
    if (!confirm(`Delete "${u.username}"? This cannot be undone.`)) return
    try {
      await api.adminDeleteUser(u.username)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <button className="btn-primary" onClick={openAdd}>
          <UserPlus size={14} />
          Add user
        </button>
      </div>

      {addOpen && (
        <Modal title="Add user" onClose={() => setAddOpen(false)} width={680}>
          <div className="grid grid-cols-[1fr_1fr_140px] gap-2">
            <input
              className="input"
              placeholder="username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              autoFocus
            />
            <input
              type="password"
              className="input"
              placeholder="password (8+ chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <select
              className="input"
              value={newRole}
              onChange={(e) => setRolePreset(e.target.value as Role)}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {newRole !== 'admin' && (
            <div className="mt-3">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1.5">
                Access
              </div>
              <PermissionTree grants={newGrants} onChange={setNewGrants} />
            </div>
          )}
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

      <Card title="Default access for new sign-ups">
        <PermissionTree grants={defaultGrants} onChange={setDefaultGrants} />
        <div className="flex items-center gap-3">
          <button className="btn-primary" onClick={saveDefaults} disabled={savingDefaults}>
            {savingDefaults ? <Loader2 size={13} className="animate-spin" /> : null}
            Save defaults
          </button>
          {defaultsMsg && (
            <span className="text-[11.5px]" style={{ color: '#00875A' }}>
              {defaultsMsg}
            </span>
          )}
        </div>
      </Card>

      {error && <ErrText text={error} />}

      <div>
        <SectionLabel>
          {users ? `${users.length} user${users.length === 1 ? '' : 's'}` : ''}
        </SectionLabel>
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
                  <tr className="border-t border-soft" style={{ borderColor: 'var(--border-soft)' }}>
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
                        className="text-[11.5px] hover:underline"
                        style={{ color: u.disabled ? '#BF2600' : '#00875A' }}
                        onClick={() => toggleDisabled(u)}
                      >
                        {u.disabled ? 'disabled' : 'active'}
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
                  {editing === u.username && u.role !== 'admin' && (
                    <tr style={{ borderTop: '1px solid var(--border-soft)' }}>
                      <td colSpan={5} className="px-3 py-3" style={{ background: 'var(--panel)' }}>
                        <PermissionTree grants={editGrants} onChange={setEditGrants} />
                        <div className="flex justify-end gap-2 mt-2">
                          <button className="btn-ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button className="btn-primary" onClick={saveEdit}>
                            Save
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {editing === u.username && u.role === 'admin' && (
                    <tr style={{ borderTop: '1px solid var(--border-soft)' }}>
                      <td colSpan={5} className="px-3 py-3 text-[12.5px] text-muted" style={{ background: 'var(--panel)' }}>
                        Admins have full access — no per-path grants needed.
                        <button className="btn-ghost ml-3" onClick={() => setEditing(null)}>
                          Close
                        </button>
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
      </div>
    </div>
  )
}

// ─── Trash ──────────────────────────────────────────────────────────────────

type TrashEntry = {
  id: string
  storageKey: string
  filename: string
  docId?: string
  bytes: number
  trashedAt: number
  trashedBy: string
}

function TrashPanel() {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = () =>
    api
      .trashList()
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const restore = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await api.trashRestore(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (id: string, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return
    setBusyId(id)
    setError(null)
    try {
      await api.trashPurge(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-5">
      {error && <ErrText text={error} />}

      <Hint>
        Items deleted from the vault land here and are automatically purged after 30 days.
        Restore returns the file to its original path; purge removes it immediately.
      </Hint>

      <div>
        <SectionLabel>
          {entries ? `${entries.length} item${entries.length === 1 ? '' : 's'} in trash` : ''}
        </SectionLabel>
        {!entries && <Muted text="Loading…" />}
        {entries && entries.length === 0 && <Muted text="Trash is empty." />}
        {entries && entries.length > 0 && (
          <div className="rounded border border-app overflow-hidden">
            <table className="w-full text-[13px]">
              <thead style={{ background: 'var(--panel)' }}>
                <tr className="text-left text-[11px] uppercase tracking-wider text-subtle">
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Original path</th>
                  <th className="px-3 py-2 font-semibold">Size</th>
                  <th className="px-3 py-2 font-semibold">Deleted</th>
                  <th className="px-3 py-2 font-semibold">By</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-soft"
                    style={{ borderColor: 'var(--border-soft)' }}
                  >
                    <td className="px-3 py-2 font-medium text-fg break-all">{e.filename}</td>
                    <td className="px-3 py-2 text-muted text-[11.5px] break-all">{e.storageKey}</td>
                    <td className="px-3 py-2 text-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatBytes(e.bytes)}
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {new Date(e.trashedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-muted">{e.trashedBy}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        className="btn-ghost"
                        onClick={() => restore(e.id)}
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
                        className="btn-ghost ml-1"
                        onClick={() => purge(e.id, e.filename)}
                        disabled={busyId === e.id}
                        style={{ color: '#BF2600' }}
                        title="Permanently delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ─── API tokens ─────────────────────────────────────────────────────────────

function TokensPanel() {
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('viewer')
  const [justCreated, setJustCreated] = useState<{ secret: string; name: string } | null>(null)

  const refresh = () =>
    api
      .adminTokens()
      .then((r) => setTokens(r.tokens))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))

  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const r = await api.adminCreateToken(newName.trim(), newRole)
      setJustCreated({ secret: r.secret, name: r.token.name })
      setNewName('')
      setNewRole('viewer')
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this token? Agents using it will be disconnected immediately.')) return
    try {
      await api.adminDeleteToken(id)
      refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-5">
      <Card title="New token">
        <div className="grid grid-cols-[1fr_140px_auto] gap-2">
          <input
            className="input"
            placeholder="Name (e.g., laptop-claude)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
          <button className="btn-primary" onClick={create} disabled={creating || !newName.trim()}>
            <Plus size={14} />
            Create
          </button>
        </div>
        <Hint>The secret is shown <strong>once</strong> — copy it immediately.</Hint>
      </Card>

      {justCreated && (
        <div
          className="rounded border p-3"
          style={{ background: '#E3FCEF', borderColor: '#ABF5D1' }}
        >
          <div className="text-[12px] font-semibold mb-1" style={{ color: '#006644' }}>
            Secret for "{justCreated.name}" — copy now
          </div>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 px-2 py-1.5 rounded text-[12px] truncate"
              style={{ background: '#FFFFFF', border: '1px solid #ABF5D1' }}
            >
              {justCreated.secret}
            </code>
            <button className="btn" onClick={() => navigator.clipboard.writeText(justCreated.secret)}>
              <Copy size={13} />
              Copy
            </button>
            <button className="btn-ghost" onClick={() => setJustCreated(null)}>
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {error && <ErrText text={error} />}

      <div>
        <SectionLabel>{tokens ? `${tokens.length} token${tokens.length === 1 ? '' : 's'}` : ''}</SectionLabel>
        {!tokens && <Muted text="Loading…" />}
        {tokens && tokens.length === 0 && <Muted text="No tokens yet." />}
        {tokens && tokens.length > 0 && (
          <div className="rounded border border-app overflow-hidden">
            <table className="w-full text-[13px]">
              <thead style={{ background: 'var(--panel)' }}>
                <tr className="text-left text-[11px] uppercase tracking-wider text-subtle">
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">ID</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                  <th className="px-3 py-2 font-semibold">Last used</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className="border-t border-soft" style={{ borderColor: 'var(--border-soft)' }}>
                    <td className="px-3 py-2 font-medium text-fg">{t.name}</td>
                    <td className="px-3 py-2 text-muted text-[11.5px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {t.id}…
                    </td>
                    <td className="px-3 py-2 capitalize text-muted">{t.role}</td>
                    <td className="px-3 py-2 text-muted">{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-muted">
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button className="btn-ghost" onClick={() => revoke(t.id)} title="Revoke">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4"
      style={{ background: 'rgba(9, 30, 66, 0.42)' }}
      onClick={onClose}
    >
      <div
        className="w-full rounded-lg shadow-card overflow-hidden flex flex-col"
        style={{ background: 'var(--panel)', maxWidth: width ?? 640, maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-4 h-10 border-b shrink-0"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--panel-2)' }}
        >
          <div className="text-[13px] font-semibold text-fg flex-1">{title}</div>
          <button className="btn-ghost h-7 w-7 px-0" onClick={onClose}>
            <X size={12} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded border border-app overflow-hidden"
      style={{ background: 'var(--bg)' }}
    >
      <div
        className="px-3 h-8 flex items-center border-b text-[11.5px] uppercase tracking-wider font-semibold text-subtle"
        style={{ background: 'var(--panel)', borderColor: 'var(--border-soft)' }}
      >
        {title}
      </div>
      <div className="p-3 space-y-3">{children}</div>
    </section>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle mb-2 px-1">
      {children}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="text-[11.5px] text-subtle leading-relaxed">{children}</div>
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-center">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-subtle">{label}</div>
      <div>{children}</div>
    </div>
  )
}

function SaveBar({
  onSave,
  saving,
  msg,
}: {
  onSave: () => void
  saving: boolean
  msg: string | null
}) {
  return (
    <div className="flex items-center gap-3">
      <button className="btn-primary" onClick={onSave} disabled={saving}>
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

