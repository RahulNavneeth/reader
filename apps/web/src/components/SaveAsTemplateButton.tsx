import { useState } from 'react'
import { BookCopy, Check, Loader2 } from 'lucide-react'
import { ApiError, api } from '../lib/api'
import { usePrompt } from '../lib/confirm'

type Props = {
  /** Vault-relative path of the source doc — pre-filled into the
   *  server's body.source. The button itself only shows for
   *  markdown surfaces (the parent gates this). */
  path: string
  /** Doc title used as the default template name. The dialog lets
   *  the user override before saving. */
  defaultTitle: string
}

/** Toolbar affordance: copy the current markdown doc into the user's
 *  `_templates/` folder so it can be re-instantiated later from the
 *  TemplatesButton picker. Hidden for non-markdown content (the
 *  template engine only operates on text), and for shared / read-
 *  only contexts (the server returns 403 in those cases anyway, but
 *  hiding the button avoids dead clicks). */
export function SaveAsTemplateButton({ path, defaultTitle }: Props) {
  const promptDialog = usePrompt()
  const [busy, setBusy] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = async () => {
    if (busy) return
    const name = await promptDialog({
      title: 'Save as template',
      placeholder: 'My template name',
      defaultValue: defaultTitle,
      confirmLabel: 'Save',
      // Plain text — the server appends .md if the user omits it
      // and strips path metacharacters defensively.
    })
    const trimmed = name?.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await api.saveAsTemplate({ source: path, name: trimmed })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setTimeout(() => setError(null), 3500)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="btn-ghost"
      onClick={handleClick}
      disabled={busy}
      title={
        error
          ? error
          : savedFlash
            ? 'Saved to _templates/'
            : 'Save this document as a template'
      }
      aria-label="Save as template"
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : savedFlash ? (
        <Check size={13} />
      ) : (
        <BookCopy size={13} />
      )}
    </button>
  )
}
