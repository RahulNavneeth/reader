import { useEffect, useState } from 'react'
import { FolderOpen, ArrowRight, FileText } from 'lucide-react'
import { api } from '../lib/api'

type Props = { onSelect: (root: string) => void }

const SUGGESTED = ['~/Documents', '~/projects', '~/Desktop', '~']

export function RootPicker({ onSelect }: Props) {
  const [path, setPath] = useState('~/Documents')
  const [home, setHome] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.home().then((r) => setHome(r.home)).catch(() => {})
  }, [])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.validate(path)
      if (!r.exists) {
        setError('Path does not exist')
        return
      }
      if (!r.isDirectory) {
        setError('Path is not a directory')
        return
      }
      onSelect(r.path || path)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center surface">
      <div className="w-full max-w-md p-8">
        <div className="flex items-center gap-2 mb-6">
          <FileText size={20} className="text-accent" />
          <span className="text-[15px] font-semibold tracking-tight">Reader</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">Pick a folder to read</h1>
        <p className="text-[13.5px] text-muted mb-5">
          Point at any directory on your machine. The reader walks <code className="text-[12px] px-1 py-0.5 rounded" style={{ background: 'var(--code-bg)' }}>.md</code>, <code className="text-[12px] px-1 py-0.5 rounded" style={{ background: 'var(--code-bg)' }}>.markdown</code>, and <code className="text-[12px] px-1 py-0.5 rounded" style={{ background: 'var(--code-bg)' }}>.mdx</code> files only.
        </p>

        <label className="block text-[12px] font-medium text-muted mb-1.5">Folder path</label>
        <div className="flex gap-2 mb-3">
          <input
            className="input flex-1"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="~/Documents"
            autoFocus
          />
          <button className="btn-primary" onClick={submit} disabled={busy}>
            <ArrowRight size={14} />
            Open
          </button>
        </div>

        {error && <div className="text-[12.5px] mb-3" style={{ color: '#DE350B' }}>{error}</div>}

        <div className="text-[11.5px] uppercase tracking-wider font-semibold text-subtle mb-2 mt-6">Suggestions</div>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED.map((s) => (
            <button key={s} className="btn-ghost" onClick={() => setPath(s)}>
              <FolderOpen size={13} />
              {s}
            </button>
          ))}
        </div>

        {home && (
          <div className="text-[11.5px] text-subtle mt-6">
            Home is <code className="px-1 py-0.5 rounded" style={{ background: 'var(--code-bg)' }}>{home}</code>. Tildes are expanded.
          </div>
        )}
      </div>
    </div>
  )
}
