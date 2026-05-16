import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle } from 'lucide-react'

type ConfirmOptions = {
  title: string
  /** Body copy under the title. */
  message: string
  /** Label of the confirm button. Defaults to "Confirm". */
  confirmLabel?: string
  /** Label of the cancel button. Defaults to "Cancel". */
  cancelLabel?: string
  /** When true, the confirm button uses the destructive red style. */
  destructive?: boolean
}

type PromptOptions = {
  title: string
  /** Body copy under the title. */
  message?: string
  /** Placeholder for the text input. */
  placeholder?: string
  /** Initial value pre-filled in the input. */
  defaultValue?: string
  /** Label of the confirm button. Defaults to "OK". */
  confirmLabel?: string
  /** Label of the cancel button. Defaults to "Cancel". */
  cancelLabel?: string
  /** Optional validator — return a string to display as the error,
   *  or null/undefined to accept the value. Runs on every change. */
  validate?: (value: string) => string | null | undefined
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>
type PromptFn = (opts: PromptOptions) => Promise<string | null>

type DialogCtx = {
  confirm: ConfirmFn
  prompt: PromptFn
}

const DialogContext = createContext<DialogCtx | null>(null)

type PendingConfirm = {
  kind: 'confirm'
  opts: ConfirmOptions
  resolve: (v: boolean) => void
}
type PendingPrompt = {
  kind: 'prompt'
  opts: PromptOptions
  resolve: (v: string | null) => void
}
type Pending = PendingConfirm | PendingPrompt

/**
 * App-wide modal dialogs (confirm + prompt). Replaces native
 * `window.confirm()` / `window.prompt()` so we get themed dialogs that
 * match the rest of the UI, aren't blocked by browsers, and don't
 * stack three at once when async code races. Both return promises so
 * callers `await` the user's choice.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ kind: 'confirm', opts, resolve })
    })
  }, [])

  const prompt = useCallback<PromptFn>((opts) => {
    return new Promise<string | null>((resolve) => {
      setPending({ kind: 'prompt', opts, resolve })
    })
  }, [])

  const close = useCallback(
    (result: boolean | string | null) => {
      if (!pending) return
      if (pending.kind === 'confirm') {
        pending.resolve(result === true)
      } else {
        pending.resolve(typeof result === 'string' ? result : null)
      }
      setPending(null)
    },
    [pending],
  )

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {pending &&
        createPortal(
          <Backdrop onDismiss={() => close(pending.kind === 'confirm' ? false : null)}>
            {pending.kind === 'confirm' ? (
              <ConfirmDialog
                opts={pending.opts}
                onResolve={(v) => close(v)}
              />
            ) : (
              <PromptDialog
                opts={pending.opts}
                onResolve={(v) => close(v)}
              />
            )}
          </Backdrop>,
          document.body,
        )}
    </DialogContext.Provider>
  )
}

function Backdrop({
  children,
  onDismiss,
}: {
  children: ReactNode
  onDismiss: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(9, 30, 66, 0.55)' }}
      onClick={onDismiss}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

function ConfirmDialog({
  opts,
  onResolve,
}: {
  opts: ConfirmOptions
  onResolve: (v: boolean) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(false)
      if (e.key === 'Enter') onResolve(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onResolve])

  return (
    <div
      className="w-[420px] max-w-[90vw] rounded-lg shadow-card overflow-hidden"
      style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
    >
      <div className="p-4 flex items-start gap-3">
        <AlertCircle
          size={20}
          style={{ color: opts.destructive ? '#BF2600' : 'var(--accent)' }}
          className="shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="text-fg font-semibold text-[14px]">{opts.title}</div>
          <div className="text-[12.5px] text-muted mt-1">{opts.message}</div>
        </div>
      </div>
      <div
        className="px-4 py-3 flex justify-end gap-2"
        style={{ background: 'var(--panel-2)', borderTop: '1px solid var(--border-soft)' }}
      >
        <button className="btn-ghost h-7" onClick={() => onResolve(false)}>
          {opts.cancelLabel ?? 'Cancel'}
        </button>
        <button
          className="btn-primary h-7"
          style={
            opts.destructive
              ? { background: '#BF2600', color: 'white' }
              : undefined
          }
          onClick={() => onResolve(true)}
          autoFocus
        >
          {opts.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </div>
  )
}

function PromptDialog({
  opts,
  onResolve,
}: {
  opts: PromptOptions
  onResolve: (v: string | null) => void
}) {
  const [value, setValue] = useState(opts.defaultValue ?? '')
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const validation = opts.validate?.(value) ?? null
  const isValid = !validation && value.trim().length > 0

  useEffect(() => {
    // Autofocus + select existing content so re-prompts are easy to clear.
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = () => {
    setTouched(true)
    if (!isValid) return
    onResolve(value.trim())
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onResolve])

  return (
    <div
      className="w-[440px] max-w-[90vw] rounded-lg shadow-card overflow-hidden"
      style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
    >
      <div className="p-4">
        <div className="text-fg font-semibold text-[14px]">{opts.title}</div>
        {opts.message && (
          <div className="text-[12.5px] text-muted mt-1 mb-3">{opts.message}</div>
        )}
        <input
          ref={inputRef}
          type="text"
          className="input w-full h-9 text-[13px] mt-2"
          placeholder={opts.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        {touched && validation && (
          <div className="text-[11.5px] mt-1.5" style={{ color: '#BF2600' }}>
            {validation}
          </div>
        )}
      </div>
      <div
        className="px-4 py-3 flex justify-end gap-2"
        style={{ background: 'var(--panel-2)', borderTop: '1px solid var(--border-soft)' }}
      >
        <button className="btn-ghost h-7" onClick={() => onResolve(null)}>
          {opts.cancelLabel ?? 'Cancel'}
        </button>
        <button
          className="btn-primary h-7"
          onClick={submit}
          disabled={!isValid}
          style={!isValid ? { opacity: 0.5 } : undefined}
        >
          {opts.confirmLabel ?? 'OK'}
        </button>
      </div>
    </div>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useConfirm: missing ConfirmProvider')
  return ctx.confirm
}

export function usePrompt(): PromptFn {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('usePrompt: missing ConfirmProvider')
  return ctx.prompt
}
