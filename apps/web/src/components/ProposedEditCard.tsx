import { useEffect, useState } from 'react'
import { Check, X, AlertTriangle, Loader2, FileEdit, Plus, Minus, ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, type ProposedEditOpDTO } from '../lib/api'

type Props = {
  docId: string
  /** The assistant turn that owns this edit. Used as the apply
   *  endpoint's identifier. */
  messageId: string
  edit: ProposedEditOpDTO
  /** When non-null, this turn has already been applied — render
   *  as a compact "Applied X ago" pill, no Apply button. */
  appliedAt?: number | null
  /** Called when the user successfully applies — parent refreshes
   *  history so the persisted appliedAt + edit_target_sha256
   *  drop into the message. */
  onApplied?: () => void
  /** Called when the user discards — parent refreshes so the
   *  pendingEdit field clears. */
  onDiscarded?: () => void
}

/**
 * Diff card rendered below an assistant message that proposed an
 * edit. Three states:
 *
 *   • pending  — Apply / Discard buttons live; clicking Apply runs
 *                the server endpoint atomically.
 *   • applied  — collapsed acknowledgement, no action buttons.
 *   • conflict — Apply returned 409 sha_mismatch (the doc changed
 *                underneath the proposal). Shows a "regenerate"
 *                hint and lets the user Discard.
 */
export function ProposedEditCard({
  docId,
  messageId,
  edit,
  appliedAt,
  onApplied,
  onDiscarded,
}: Props) {
  const [state, setState] = useState<'pending' | 'applying' | 'applied' | 'discarding' | 'discarded' | 'conflict'>(
    appliedAt ? 'applied' : 'pending',
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [contentOpen, setContentOpen] = useState(false)

  // If the parent gets a fresh appliedAt after Apply succeeds, flip
  // our local state. Defensive — handles the case where the parent
  // re-renders with appliedAt before our internal `applied` state
  // is set.
  useEffect(() => {
    if (appliedAt) setState('applied')
  }, [appliedAt])

  const handleApply = async () => {
    setState('applying')
    setErrorMsg(null)
    try {
      await api.applyChatEdit(docId, messageId)
      setState('applied')
      onApplied?.()
    } catch (e) {
      if (e instanceof ApiError && (e.body as { code?: string })?.code === 'sha_mismatch') {
        setState('conflict')
        setErrorMsg('The document changed since this edit was proposed.')
      } else {
        setState('pending')
        setErrorMsg((e as Error)?.message ?? 'apply failed')
      }
    }
  }

  const handleDiscard = async () => {
    setState('discarding')
    setErrorMsg(null)
    try {
      await api.discardChatEdit(docId, messageId)
      setState('discarded')
      onDiscarded?.()
    } catch (e) {
      setState('pending')
      setErrorMsg((e as Error)?.message ?? 'discard failed')
    }
  }

  // Applied state — compact pill, no actions.
  if (state === 'applied') {
    return (
      <div
        className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11.5px]"
        style={{ background: 'var(--selected)', color: 'var(--accent)' }}
      >
        <Check size={11} />
        Applied to <span className="font-medium">{describeTarget(edit)}</span>
      </div>
    )
  }
  // Discarded — even more compact.
  if (state === 'discarded') {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11.5px] text-subtle">
        <X size={11} />
        Discarded
      </div>
    )
  }

  // Pending / conflict — the full card.
  return (
    <div
      className="mt-2 rounded-md overflow-hidden"
      style={{
        background: state === 'conflict' ? 'var(--danger-bg)' : 'var(--panel-2)',
        border: `1px solid ${state === 'conflict' ? 'color-mix(in srgb, var(--danger-fg) 20%, transparent)' : 'var(--border-soft)'}`,
      }}
    >
      <button
        className="w-full px-2.5 py-2 flex items-center gap-2 text-left"
        onClick={() => setContentOpen((v) => !v)}
      >
        {contentOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <OpIcon op={edit.op} />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-subtle">
          {opLabel(edit.op)}
        </span>
        <span className="text-[12px] font-medium truncate flex-1">
          {describeTarget(edit)}
        </span>
      </button>

      {contentOpen && (
        <div
          className="px-2.5 pb-2 pt-1 text-[12px]"
          style={{ borderTop: '1px solid var(--border-soft)' }}
        >
          {/* Show the proposed new content for ops that have one. */}
          {(edit.op === 'replace_section' ||
            edit.op === 'insert_after' ||
            edit.op === 'append_text' ||
            edit.op === 'prepend_text') && (
            <>
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle mb-1">
                {edit.op === 'replace_section' ? 'New content' : 'To be added'}
              </div>
              <pre
                className="text-[11.5px] leading-snug whitespace-pre-wrap break-words m-0 p-2 rounded"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border-soft)',
                  color: 'var(--fg)',
                  maxHeight: '320px',
                  overflowY: 'auto',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {edit.content}
              </pre>
            </>
          )}
          {edit.op === 'delete_section' && (
            <div className="text-[12px] text-subtle">
              The section <span className="font-medium text-fg">{edit.heading}</span> and all its content will be removed.
            </div>
          )}
        </div>
      )}

      {state === 'conflict' && (
        <div
          className="px-2.5 py-2 text-[12px] flex items-start gap-1.5"
          style={{ borderTop: '1px solid color-mix(in srgb, var(--danger-fg) 20%, transparent)', color: 'var(--danger-fg)' }}
        >
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-0.5">Document changed</div>
            <div className="opacity-90">
              The document has been edited since Reader AI proposed this. The change is no longer safe to apply automatically. Re-ask Reader AI to regenerate the suggestion against the current state.
            </div>
          </div>
        </div>
      )}

      {errorMsg && state !== 'conflict' && (
        <div
          className="px-2.5 py-1.5 text-[11.5px]"
          style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
        >
          {errorMsg}
        </div>
      )}

      <div
        className="px-2.5 py-1.5 flex items-center gap-1.5"
        style={{ borderTop: '1px solid var(--border-soft)' }}
      >
        {state !== 'conflict' && (
          <button
            className="h-7 px-2.5 inline-flex items-center gap-1 rounded text-[12px] font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'white' }}
            onClick={handleApply}
            disabled={state === 'applying' || state === 'discarding'}
          >
            {state === 'applying' ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            {state === 'applying' ? 'Applying…' : 'Apply'}
          </button>
        )}
        <button
          className="btn-ghost h-7 px-2 text-[12px]"
          onClick={handleDiscard}
          disabled={state === 'applying' || state === 'discarding'}
        >
          {state === 'discarding' ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
          Discard
        </button>
      </div>
    </div>
  )
}

function opLabel(op: ProposedEditOpDTO['op']): string {
  switch (op) {
    case 'replace_section': return 'Replace section'
    case 'insert_after': return 'Insert section'
    case 'delete_section': return 'Delete section'
    case 'append_text': return 'Append to document'
    case 'prepend_text': return 'Prepend to document'
  }
}

function describeTarget(edit: ProposedEditOpDTO): string {
  if ('heading' in edit) return edit.heading
  return edit.op === 'append_text' ? 'end of document' : 'start of document'
}

function OpIcon({ op }: { op: ProposedEditOpDTO['op'] }) {
  if (op === 'delete_section') return <Minus size={11} className="text-danger" />
  if (op === 'insert_after' || op === 'append_text' || op === 'prepend_text') {
    return <Plus size={11} className="text-accent" />
  }
  return <FileEdit size={11} className="text-accent" />
}
