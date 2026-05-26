import { useEffect, useState } from 'react'
import { Sparkles, Trash2 } from 'lucide-react'
import { api, ApiError, type SmartCollectionQuery } from '../lib/api'

type Props = {
  collectionId: string
  /** Current query state from the loaded collection. NULL means
   *  the collection is currently static. */
  initialQuery: SmartCollectionQuery | null
  /** Called after a successful save so the parent can refresh
   *  the resolved items list. */
  onChanged: () => void
}

/**
 * Inline editor for a collection's smart-mode rule. Renders a
 * single header row when collapsed; expands to a form when the
 * user opts to convert the collection to "smart" (or open the
 * existing query for editing).
 *
 * Filter fields are intentionally minimal — they cover the
 * dimensions that actually matter for everyday workflows:
 *
 *   - Semantic query (Ollama-backed similarity) — natural language
 *     prompt resolved through the same `searchKnowledge` the
 *     search bar uses
 *   - Tags (any-of)
 *   - Path prefix (folder scope)
 *   - Mime kind
 *   - Include archived?
 *
 * Date range and explicit field validators are deferred — the
 * server tolerates extra fields, so we can add UI for them
 * later without a schema bump.
 */
export function SmartCollectionEditor({ collectionId, initialQuery, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Local mirror of the query while the editor is open. Reset
  // whenever the parent reloads with a new initialQuery (e.g.
  // after a refresh).
  const [semanticQuery, setSemanticQuery] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [mimeKind, setMimeKind] = useState<'' | 'image' | 'video' | 'file' | 'markdown'>('')
  const [includeArchived, setIncludeArchived] = useState(false)

  useEffect(() => {
    setSemanticQuery(initialQuery?.semanticQuery ?? '')
    setTagsRaw((initialQuery?.tags ?? []).join(', '))
    setPathPrefix(initialQuery?.pathPrefix ?? '')
    setMimeKind((initialQuery?.mimeKind ?? '') as typeof mimeKind)
    setIncludeArchived(initialQuery?.archived === true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery])

  const isSmart = initialQuery != null

  const buildQuery = (): SmartCollectionQuery => {
    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)
    const q: SmartCollectionQuery = {}
    const sem = semanticQuery.trim()
    if (sem) q.semanticQuery = sem
    if (tags.length > 0) q.tags = tags
    if (pathPrefix.trim()) q.pathPrefix = pathPrefix.trim()
    if (mimeKind) q.mimeKind = mimeKind
    if (includeArchived) q.archived = true
    return q
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.patchCollection(collectionId, { query: buildQuery() })
      setOpen(false)
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const convertToStatic = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.patchCollection(collectionId, { query: null })
      setOpen(false)
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="mb-4 rounded-md overflow-hidden"
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 text-[12px]"
        style={{ color: isSmart ? 'var(--accent)' : 'var(--subtle)' }}
      >
        <Sparkles size={12} />
        <span className="text-fg font-semibold">
          {isSmart ? 'Smart collection' : 'Static collection'}
        </span>
        <span>·</span>
        <span>
          {isSmart
            ? 'Membership resolves live from the query below'
            : 'Documents added manually via the file viewer'}
        </span>
        <div className="flex-1" />
        <button
          className="btn-ghost h-6 px-2 text-[11.5px]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Cancel' : isSmart ? 'Edit query' : 'Make smart'}
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-[12px]" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="pt-3">
            <label className="block text-[11px] text-subtle mb-1">
              Semantic query
            </label>
            <textarea
              value={semanticQuery}
              onChange={(e) => setSemanticQuery(e.target.value)}
              placeholder="e.g. notes about onboarding new engineers · or “sunset over ocean” for photos"
              className="w-full text-[12.5px] px-2 py-1.5 rounded resize-none outline-none"
              rows={2}
              style={{
                background: 'var(--surface-1)',
                border: '1px solid var(--border)',
                color: 'var(--fg)',
              }}
            />
            <div className="text-[10.5px] text-subtle mt-1">
              Natural language. Text docs are matched via Ollama
              embeddings; when CLIP is enabled in admin settings,
              images are matched too.
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-subtle mb-1">Tags (any-of)</label>
              <input
                type="text"
                value={tagsRaw}
                onChange={(e) => setTagsRaw(e.target.value)}
                placeholder="comma, separated"
                className="w-full text-[12.5px] px-2 py-1.5 rounded outline-none"
                style={{
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)',
                }}
              />
            </div>
            <div>
              <label className="block text-[11px] text-subtle mb-1">Path prefix</label>
              <input
                type="text"
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                placeholder="e.g. journal/"
                className="w-full text-[12.5px] px-2 py-1.5 rounded outline-none"
                style={{
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)',
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-subtle mb-1">Kind</label>
              <select
                value={mimeKind}
                onChange={(e) => setMimeKind(e.target.value as typeof mimeKind)}
                className="w-full text-[12.5px] px-2 py-1.5 rounded outline-none"
                style={{
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)',
                }}
              >
                <option value="">Any</option>
                <option value="markdown">Markdown</option>
                <option value="image">Image</option>
                <option value="video">Video</option>
                <option value="file">Other file</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="inline-flex items-center gap-2 text-[12px] text-fg">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                />
                Include archived
              </label>
            </div>
          </div>
          {error && (
            <div className="text-[11px]" style={{ color: '#BF2600' }}>
              {error}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              className="btn-ghost h-7 px-3 text-[12px]"
              style={{ background: 'var(--accent)', color: 'white' }}
              disabled={saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save query'}
            </button>
            {isSmart && (
              <button
                className="btn-ghost h-7 px-3 text-[12px]"
                disabled={saving}
                onClick={convertToStatic}
                title="Drop the query; collection goes back to manual membership"
              >
                <Trash2 size={11} className="inline -mt-0.5 mr-1" />
                Convert to static
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
