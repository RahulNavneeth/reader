import { useEffect, useMemo, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { CrdtBody } from '../lib/crdt/useCrdtBody'

type Props = {
  crdt: CrdtBody
  /** Human-readable label rendered on this tab's awareness chip
   *  on every other tab. Usually the signed-in username.
   *  Falls back to an anonymous tab id if absent. */
  userLabel?: string | null
  /** Called when the user clicks "View"; the parent flips back to
   *  the rendered markdown. Edits aren't lost on exit — the CRDT
   *  has them already and the materialiser persists to disk. */
  onExit?: () => void
}

/**
 * Live-collab markdown editor backed by CodeMirror 6 +
 * `y-codemirror.next`. Replaces the earlier textarea-based MVP
 * with proper char-level CRDT operations:
 *
 *   - **Per-keystroke deltas, not whole-body replace.** The
 *     yCollab extension translates CodeMirror's character-level
 *     changes into Y.Text ops, so two concurrent authors on
 *     different paragraphs merge cleanly instead of racing.
 *
 *   - **Remote cursors + selections.** y-codemirror.next reads
 *     the WebsocketProvider's awareness state and renders each
 *     peer's cursor/selection inline. Phase 6 awareness comes
 *     "for free" with this binding.
 *
 *   - **Undo/redo scoped to local edits.** The Y.UndoManager
 *     filters out remote ops so Cmd-Z only undoes what *you*
 *     just typed, not what a peer did.
 *
 *   - **Markdown syntax highlighting** via `@codemirror/lang-
 *     markdown`. Defaults are fine; we let CodeMirror's
 *     `defaultHighlightStyle` pick the colors so dark/light
 *     mode just works without a custom palette.
 */
export function CrdtEditor({ crdt, userLabel, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  // y-codemirror.next wants an UndoManager scoped to the Y.Text
  // we're binding. Memoise so HMR / re-renders don't churn it.
  const undoManager = useMemo(() => {
    if (!crdt.doc) return null
    const ytext = crdt.doc.getText('body')
    return new Y.UndoManager(ytext)
  }, [crdt.doc])

  useEffect(() => {
    if (!hostRef.current) return
    if (!crdt.doc) return
    const ytext = crdt.doc.getText('body')

    // Identify this peer in the awareness map. `name` is the
    // signed-in username when the caller passes one (so two open
    // tabs of the same user show the same readable label), and
    // a stable per-tab id otherwise. The colour is hashed from
    // the *tab* identity so two tabs of the same user still
    // show up as distinct cursors.
    if (crdt.awareness) {
      const tabId = (() => {
        try {
          const k = 'reader:crdtTab'
          const cached = sessionStorage.getItem(k)
          if (cached) return cached
          const next = Math.random().toString(36).slice(2, 10)
          sessionStorage.setItem(k, next)
          return next
        } catch {
          return Math.random().toString(36).slice(2, 10)
        }
      })()
      let hash = 0
      for (let i = 0; i < tabId.length; i++) hash = (hash * 31 + tabId.charCodeAt(i)) | 0
      const hue = Math.abs(hash) % 360
      crdt.awareness.setLocalStateField('user', {
        name: userLabel || tabId,
        color: `hsl(${hue}, 70%, 55%)`,
        colorLight: `hsl(${hue}, 70%, 85%)`,
      })
    }

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        history(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, ...yUndoManagerKeymap]),
        yCollab(ytext, crdt.awareness, undoManager ? { undoManager } : undefined),
        // Minimal theme that picks up Reader's CSS variables so
        // light / dark switch keeps working. CodeMirror's
        // defaults are workable but the gutter + background
        // colours look wrong against `--surface-3`.
        EditorView.theme(
          {
            '&': {
              backgroundColor: 'transparent',
              color: 'var(--fg)',
              height: '100%',
            },
            '.cm-scroller': {
              fontFamily: 'inherit',
              fontSize: '14px',
              lineHeight: '1.6',
              padding: '24px 40px',
            },
            '.cm-content': { caretColor: 'var(--accent)' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
            '.cm-gutters': {
              backgroundColor: 'transparent',
              color: 'var(--subtle)',
              border: 'none',
            },
            '.cm-activeLine': { backgroundColor: 'var(--hover)' },
            '.cm-activeLineGutter': { backgroundColor: 'transparent' },
            '.cm-selectionBackground, ::selection': {
              backgroundColor: 'var(--selected) !important',
            },
            '&.cm-focused .cm-selectionBackground': {
              backgroundColor: 'var(--selected) !important',
            },
          },
          { dark: false },
        ),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // userLabel is intentionally NOT in the dep array — re-running the whole
    // editor mount on a username change would lose focus + cursor. We update
    // the awareness field below without re-creating the EditorView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crdt.doc, crdt.awareness, undoManager])

  // Light-touch awareness label refresh when `userLabel` arrives
  // after the editor is already mounted (the auth/meta state can
  // resolve later than the first render).
  useEffect(() => {
    if (!crdt.awareness) return
    const current = crdt.awareness.getLocalState() as { user?: { name?: string } } | null
    if (current?.user && userLabel && current.user.name !== userLabel) {
      crdt.awareness.setLocalStateField('user', { ...current.user, name: userLabel })
    }
  }, [crdt.awareness, userLabel])

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className="flex items-center justify-between px-10 py-2 text-[11.5px]"
        style={{ borderBottom: '1px solid var(--border)', color: 'var(--subtle)' }}
      >
        <span>{crdt.synced ? 'Autosaving' : 'Offline'}</span>
        {onExit && (
          <button className="btn-ghost h-6 px-2 text-[11.5px]" onClick={onExit}>
            View
          </button>
        )}
      </div>
      <div ref={hostRef} className="flex-1 overflow-hidden" />
    </div>
  )
}
