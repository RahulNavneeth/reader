import { useEffect, useMemo, useRef } from 'react'
import { EditorState, Prec, StateEffect } from '@codemirror/state'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import {
  history,
  defaultKeymap,
  historyKeymap,
} from '@codemirror/commands'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { vim } from '@replit/codemirror-vim'
import type { CrdtBody } from '../lib/crdt/useCrdtBody'
import { useVimMode } from '../lib/uiPrefs'

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
  /** Cursor / selection range to restore on mount. PathViewer
   *  stores this per-doc so toggling edit ↔ preview (or
   *  re-opening a file in the same session) keeps the caret
   *  where the user left it. */
  initialSelection?: { anchor: number; head: number } | null
  /** Fires whenever the selection changes; lets the parent
   *  persist the latest position into the per-doc cursor map. */
  onSelectionChange?: (sel: { anchor: number; head: number }) => void
  /** Source line (1-indexed) the parent wants at the top of the
   *  editor viewport on mount. Anchors the edit ↔ preview scroll
   *  sync — landing the saved line at `y:'start'` keeps the visual
   *  state aligned with what the viewer / previous editor showed.
   *  Falls through to centering the cursor if not provided. */
  initialScrollLine?: number | null
  /** Exposes the live CodeMirror view to the parent — used at
   *  toggle time to ask "what line is the user looking at?". */
  viewRef?: React.MutableRefObject<EditorView | null>
  /** Fired when the user pastes a file (image, video, any
   *  non-text blob). The parent opens the PasteMediaDialog so
   *  the user can pick the destination folder + filename, then
   *  inserts the resulting markdown snippet at the cursor via
   *  `viewRef` after upload. */
  onMediaPaste?: (file: File) => void
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
export function CrdtEditor({
  crdt,
  userLabel,
  onExit,
  initialSelection,
  onSelectionChange,
  initialScrollLine,
  viewRef: externalViewRef,
  onMediaPaste,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Ref-mirror of onMediaPaste so the paste DOM handler (which
  // is captured inside the EditorView's static extension list)
  // always sees the latest callback without remounting the
  // editor when the parent re-renders with a new closure.
  const onMediaPasteRef = useRef(onMediaPaste)
  useEffect(() => {
    onMediaPasteRef.current = onMediaPaste
  }, [onMediaPaste])
  // Vim mode is a global user preference (toggled from the user
  // menu). Re-mounts the editor when it flips because `vim()`
  // registers extensions at EditorState construction time and
  // can't be cleanly toggled on a live state.
  const [vimEnabled] = useVimMode()

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

    // Identify this peer in the awareness map. `name` MUST be
    // the signed-in username — falling back to a random tabId
    // surfaced as "dnr3933q"-style ghosts in other tabs' Peers
    // panels. If userLabel isn't ready yet we skip the seed; the
    // companion effect below picks it up when the prop resolves.
    // Colour is hashed from the *tab* identity so two tabs of
    // the same user still show up as distinct cursors.
    if (crdt.awareness && userLabel) {
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
        name: userLabel,
        color: `hsl(${hue}, 70%, 55%)`,
        // Translucent so a solid pale wash doesn't obscure the
        // text underneath (especially in dark mode where a
        // solid `hsl(…, 70%, 85%)` was unreadable).
        colorLight: `hsla(${hue}, 70%, 60%, 0.22)`,
      })
    }

    // Clamp the parent's saved selection to the live doc length
    // — collab edits could have shrunk the doc while the user
    // was in preview mode.
    const docLen = ytext.length
    const seedSelection = initialSelection
      ? {
          anchor: Math.min(initialSelection.anchor, docLen),
          head: Math.min(initialSelection.head, docLen),
        }
      : undefined

    // Tab / Shift-Tab nesting for markdown list items.
    //
    // For UNORDERED lists (`- `, `* `, `+ `, task-list variants)
    // we just indent / dedent — the bullet character is the
    // same at every depth.
    //
    // For ORDERED lists (`1. `, `1) `) we ALSO renumber:
    //   - Tab → the moved line becomes "1." (start of a fresh
    //     nested sub-list), and any later siblings at the old
    //     indent level get renumbered to fill the gap.
    //   - Shift-Tab → the moved line resumes the parent's
    //     numbering (prev sibling at new indent +1, or "1." if
    //     it's the first at that level), and later siblings at
    //     the OLD inner indent renumber from 1.
    // Without renumbering, the source ends up with stale numbers
    // (e.g. "   2. Item" right after a Tab) — the user wanted a
    // fresh sub-list count instead.
    const LIST_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(.*)$/
    const parseListLine = (text: string) => {
      const m = text.match(LIST_RE)
      if (!m) return null
      return {
        indent: m[1],
        marker: m[2],
        num: m[3] ? parseInt(m[3], 10) : null,
        delim: m[4] || '',
        sep: m[5],
        rest: m[6],
      }
    }
    const isListLine = (line: string) => !!parseListLine(line)

    // Indent unit kept in sync with the indentUnit extension below
    // (`indentUnit.of('  ')`). Defined here so the indent/dedent
    // logic can splice/strip the exact same prefix.
    const INDENT = '  '

    const indentForLine = (view: EditorView): boolean => {
      const { state } = view
      const sel = state.selection.main
      const lineObj = state.doc.lineAt(sel.head)
      const parsed = parseListLine(lineObj.text)
      if (!parsed) return false
      // Directly splice the indent in at the line start so we
      // never depend on indentMore — at deep nesting levels its
      // language-aware indent computation could cancel or stop
      // adding chars, which broke Tab past 3-4 levels.
      const oldIndentLen = parsed.indent.length
      const newIndent = parsed.indent + INDENT
      const newNum = parsed.num !== null ? 1 : null
      const newMarker = newNum !== null ? `${newNum}${parsed.delim}` : parsed.marker
      const newText = `${newIndent}${newMarker}${parsed.sep}${parsed.rest}`
      const cursorOffset = sel.head - lineObj.from
      const indentDelta = newText.length - lineObj.text.length
      const newCursor = lineObj.from + Math.min(
        newText.length,
        cursorOffset + indentDelta,
      )
      const changes: { from: number; to: number; insert: string }[] = [
        { from: lineObj.from, to: lineObj.to, insert: newText },
      ]
      // Renumber the OLD-indent siblings that follow: they fill
      // the gap left by the moved item. Counter starts from the
      // previous same-indent sibling's number (or 0 if none).
      if (parsed.num !== null) {
        const oldIndent = parsed.indent
        let n = 0
        for (let ln = lineObj.number - 1; ln >= 1; ln--) {
          const t = state.doc.line(ln).text
          const p = parseListLine(t)
          if (!p) break
          if (p.indent.length < oldIndentLen) break
          if (p.indent.length === oldIndentLen) {
            if (p.num !== null) n = p.num
            break
          }
        }
        for (let ln = lineObj.number + 1; ln <= state.doc.lines; ln++) {
          const sibLine = state.doc.line(ln)
          const sp = parseListLine(sibLine.text)
          if (!sp) break
          if (sp.indent.length < oldIndentLen) break
          if (sp.indent.length !== oldIndentLen) continue
          if (sp.num === null) break
          n += 1
          if (sp.num !== n) {
            const rewritten = `${oldIndent}${n}${sp.delim}${sp.sep}${sp.rest}`
            changes.push({ from: sibLine.from, to: sibLine.to, insert: rewritten })
          }
        }
      }
      view.dispatch({ changes, selection: { anchor: newCursor } })
      return true
    }

    const dedentForLine = (view: EditorView): boolean => {
      const { state } = view
      const sel = state.selection.main
      const lineObj = state.doc.lineAt(sel.head)
      const parsed = parseListLine(lineObj.text)
      if (!parsed) return false
      if (parsed.indent.length === 0) return false // at root — let CM handle
      // Strip ONE indent-unit's worth of leading whitespace.
      // Take from the START so the indent shrinks cleanly even
      // when the line happens to use mixed widths.
      const stripped =
        parsed.indent.startsWith(INDENT)
          ? parsed.indent.slice(INDENT.length)
          : parsed.indent.slice(1)
      const newIndentLen = stripped.length
      // Compute the resumed number: prev sibling at the new
      // (outer) indent's number + 1, or 1 if there's no sibling.
      let n = 0
      if (parsed.num !== null) {
        for (let ln = lineObj.number - 1; ln >= 1; ln--) {
          const t = state.doc.line(ln).text
          const p = parseListLine(t)
          if (!p) break
          if (p.indent.length < newIndentLen) break
          if (p.indent.length === newIndentLen) {
            if (p.num !== null) n = p.num
            break
          }
        }
        n += 1
      }
      const newMarker = parsed.num !== null ? `${n}${parsed.delim}` : parsed.marker
      const newText = `${stripped}${newMarker}${parsed.sep}${parsed.rest}`
      const cursorOffset = sel.head - lineObj.from
      const delta = newText.length - lineObj.text.length
      const newCursor = lineObj.from + Math.max(0, cursorOffset + delta)
      const changes: { from: number; to: number; insert: string }[] = [
        { from: lineObj.from, to: lineObj.to, insert: newText },
      ]
      // Renumber following siblings at the new indent.
      if (parsed.num !== null) {
        let counter = n
        for (let ln = lineObj.number + 1; ln <= state.doc.lines; ln++) {
          const sibLine = state.doc.line(ln)
          const sp = parseListLine(sibLine.text)
          if (!sp) break
          if (sp.indent.length < newIndentLen) break
          if (sp.indent.length !== newIndentLen) continue
          if (sp.num === null) break
          counter += 1
          if (sp.num !== counter) {
            const rewritten = `${stripped}${counter}${sp.delim}${sp.sep}${sp.rest}`
            changes.push({ from: sibLine.from, to: sibLine.to, insert: rewritten })
          }
        }
      }
      view.dispatch({ changes, selection: { anchor: newCursor } })
      return true
    }

    // Enter handler:
    //   - empty list item (just the marker, no content) → exit
    //     the list. If indented, outdent one level (turn into a
    //     parent-level item / paragraph). If at root, strip the
    //     marker so the user lands on a plain paragraph.
    //   - non-empty list item → continue with the next marker
    //     (next number for ordered, same bullet for unordered).
    //   - non-list line → fall through to default Enter (newline).
    const enterForList = (view: EditorView): boolean => {
      const { state } = view
      const sel = state.selection.main
      if (sel.from !== sel.to) return false // active selection — let default replace it
      const lineObj = state.doc.lineAt(sel.head)
      const parsed = parseListLine(lineObj.text)
      if (!parsed) return false
      const contentTrimmed = parsed.rest.trim()
      if (!contentTrimmed) {
        // Empty list item. Exit the list.
        if (parsed.indent.length > 0) {
          return dedentForLine(view)
        }
        view.dispatch({
          changes: { from: lineObj.from, to: lineObj.to, insert: '' },
          selection: { anchor: lineObj.from },
        })
        return true
      }
      // Continue the list. Split at the cursor: keep "before"
      // on the current line, push "after" to the new list item.
      // This works whether the cursor is at end-of-line OR
      // mid-content (mid-content split was previously bailing,
      // which fell through to default insertNewlineAndIndent —
      // that auto-indented to the CONTENT column at deep nesting
      // and broke the list-item structure entirely).
      const cursorInLine = sel.head - lineObj.from
      const before = lineObj.text.slice(0, cursorInLine)
      const after = lineObj.text.slice(cursorInLine)
      const nextMarker =
        parsed.num !== null
          ? `${parsed.num + 1}${parsed.delim}`
          : parsed.marker
      const newLinePrefix = `${parsed.indent}${nextMarker}${parsed.sep}`
      const insertion = `\n${newLinePrefix}${after}`
      view.dispatch({
        changes: { from: lineObj.from + before.length, to: lineObj.to, insert: insertion },
        selection: { anchor: lineObj.from + before.length + 1 + newLinePrefix.length },
      })
      return true
    }

    const listTabKeymap = keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          const { state } = view
          const line = state.doc.lineAt(state.selection.main.head).text
          if (!isListLine(line)) return false
          return indentForLine(view)
        },
      },
      {
        key: 'Shift-Tab',
        run: (view) => {
          const { state } = view
          const line = state.doc.lineAt(state.selection.main.head).text
          if (!isListLine(line)) return false
          return dedentForLine(view)
        },
      },
      {
        key: 'Enter',
        run: enterForList,
      },
    ])

    const state = EditorState.create({
      doc: ytext.toString(),
      ...(seedSelection ? { selection: seedSelection } : {}),
      extensions: [
        // vim() MUST be at the top so its high-precedence
        // keymap intercepts insert / normal-mode keys before
        // CodeMirror's defaults.
        ...(vimEnabled ? [vim()] : []),
        // Two-space indent unit so list nesting bullets sit
        // close to their parent.
        indentUnit.of('  '),
        // drawSelection draws the standard `.cm-selectionBackground`
        // overlay. Without it, native browser selection is used —
        // which vim mode suppresses, leaving visual-mode selection
        // invisible locally even though peers render it fine via
        // awareness.
        drawSelection(),
        history(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown(),
        // Paste interception: when the clipboard carries a file
        // (image / video / arbitrary blob) we cancel the default
        // text-paste and hand the file up to the parent. The
        // parent opens a folder-picker dialog, uploads, and
        // dispatches the resulting markdown snippet back via
        // viewRef so it lands at the cursor.
        EditorView.domEventHandlers({
          paste: (e) => {
            const files = e.clipboardData?.files
            if (!files || files.length === 0) return false
            // If the user has BOTH text and a file in the
            // clipboard (e.g. screenshot tools that include a
            // title), we still prefer the file — the markdown
            // insertion will be richer than the raw text.
            const file = files[0]
            // Skip plain-text "file" entries the browser
            // synthesises from text payloads — they have empty
            // type strings and we don't want to upload those.
            if (!file.type) return false
            e.preventDefault()
            onMediaPasteRef.current?.(file)
            return true
          },
        }),
        EditorView.lineWrapping,
        // Keep the cursor away from the top/bottom edges as it moves
        // — the viewport starts scrolling well before the cursor
        // reaches the last visible line, so the reader can always
        // see a few lines of what's coming next. Match the editor's
        // top padding (24px) plus ~6 lines of breathing room.
        EditorView.scrollMargins.of(() => ({ top: 200, bottom: 320 })),
        // Prec.highest so our list Tab / Shift-Tab / Enter beat
        // every default + language-aware handler — at deep
        // nesting (4-5 levels) `markdown()` + `indentOnInput`
        // were absorbing Enter and inserting a continuation
        // line at the content column instead of a new numbered
        // item.
        Prec.highest(listTabKeymap),
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
            // Vim normal-mode block cursor. The vim package
            // paints `.cm-fat-cursor` with its own default
            // (a pink/peach) — pin to the theme accent so the
            // local caret matches the rest of Reader's UI.
            '.cm-fat-cursor': {
              background: 'var(--accent) !important',
              color: 'var(--bg) !important',
              outline: 'none !important',
              border: 'none !important',
            },
            '&:not(.cm-focused) .cm-fat-cursor': {
              background: 'transparent !important',
              outline: 'solid 1px var(--accent) !important',
              color: 'transparent !important',
            },
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
            // Remote cursor styling from y-codemirror.next. The
            // library stamps `.cm-ySelectionInfo` next to each
            // remote caret with the peer's name; default styles
            // hide it on non-hover, so surface it as a small
            // always-visible chip in the peer's hue.
            '.cm-ySelectionCaret': {
              position: 'relative',
              borderLeft: '2px solid',
              borderRight: '2px solid',
              marginLeft: '-2px',
              marginRight: '-2px',
              wordBreak: 'normal',
            },
            '.cm-ySelectionCaretDot': {
              borderRadius: '50%',
              position: 'absolute',
              width: '6px',
              height: '6px',
              top: '-2.5px',
              left: '-3px',
              backgroundColor: 'inherit',
              transform: 'scale(0.6)',
            },
            '.cm-ySelectionInfo': {
              position: 'absolute',
              top: '-1.7em',
              left: '-2px',
              fontSize: '12.5px',
              fontFamily: 'inherit',
              fontStyle: 'normal',
              fontWeight: '600',
              lineHeight: '1.1',
              userSelect: 'none',
              color: 'white',
              padding: '3px 8px',
              zIndex: 101,
              whiteSpace: 'nowrap',
              borderRadius: '4px',
              opacity: '1',
              transition: 'opacity 100ms ease-in',
              pointerEvents: 'none',
            },
          },
          { dark: false },
        ),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    if (externalViewRef) externalViewRef.current = view

    // Scroll to the parent-supplied source line (scroll sync
    // target from the rendered preview), then re-centre on the
    // restored cursor if there is one. Force a layout measure
    // first so `scrollIntoView` runs against real coordinates
    // instead of zero-height boxes during the initial mount.
    void view.scrollDOM.offsetHeight
    if (initialScrollLine && initialScrollLine > 0) {
      const lineCount = view.state.doc.lines
      const lineNo = Math.min(Math.max(1, initialScrollLine), lineCount)
      const pos = view.state.doc.line(lineNo).from
      // `y: 'start'` puts the anchor line at the viewport top —
      // matches the parent's saved "top of viewport" line so the
      // round-trip back from preview lands at the identical view.
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
    } else if (seedSelection) {
      view.dispatch({
        effects: EditorView.scrollIntoView(seedSelection.head, { y: 'center' }),
      })
    }
    view.focus()

    // Stream selection changes back to the parent so its cursor
    // map always has the latest position to restore from.
    const selUpdater = EditorView.updateListener.of((u) => {
      if (!u.selectionSet) return
      const { anchor, head } = u.state.selection.main
      onSelectionChange?.({ anchor, head })
    })
    view.dispatch({ effects: StateEffect.appendConfig.of(selUpdater) })

    return () => {
      view.destroy()
      viewRef.current = null
      if (externalViewRef && externalViewRef.current === view) {
        externalViewRef.current = null
      }
    }
    // userLabel is intentionally NOT in the dep array — re-running the whole
    // editor mount on a username change would lose focus + cursor. We update
    // the awareness field below without re-creating the EditorView.
    // vimEnabled IS — toggling vim re-creates the editor since `vim()`
    // installs its keymap at construction time.
    // initialSelection / initialScrollLine are also intentionally NOT in
    // the dep array — they're only read on mount; including them would
    // remount the editor on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crdt.doc, crdt.awareness, undoManager, vimEnabled])

  // Awareness label sync — seeds the local state if the mount
  // effect bailed because `userLabel` was still null (auth /
  // meta state can resolve later than the first render).
  useEffect(() => {
    if (!crdt.awareness || !userLabel) return
    const current = crdt.awareness.getLocalState() as
      | { user?: { name?: string; color?: string; colorLight?: string } }
      | null
    if (current?.user?.name === userLabel) return
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
      name: userLabel,
      color: current?.user?.color ?? `hsl(${hue}, 70%, 55%)`,
      colorLight:
        current?.user?.colorLight ?? `hsla(${hue}, 70%, 60%, 0.22)`,
    })
  }, [crdt.awareness, userLabel])

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className="h-11 flex items-center justify-between px-10 text-[11.5px] shrink-0"
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
          color: 'var(--subtle)',
        }}
      >
        <div className="flex items-center gap-2">
          <span>{crdt.connected ? 'Autosaving' : 'Offline'}</span>
          {vimEnabled && (
            <span
              className="px-1.5 py-0.5 rounded text-[10.5px] font-semibold tracking-wide uppercase"
              style={{
                background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                color: 'var(--accent)',
              }}
              title="Vim mode is on — toggle from the user menu"
            >
              Vim
            </span>
          )}
        </div>
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
