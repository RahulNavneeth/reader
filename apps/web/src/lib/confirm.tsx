import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * App-wide confirm modal. Replaces native `window.confirm()` so we get a
 * styled, themed prompt that matches the rest of the UI (and isn't
 * blocked or rate-limited by the browser). Resolves true on confirm,
 * false on cancel / dismiss.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<
    | {
        opts: ConfirmOptions
        resolve: (v: boolean) => void
      }
    | null
  >(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ opts, resolve })
    })
  }, [])

  const close = useCallback(
    (result: boolean) => {
      pending?.resolve(result)
      setPending(null)
    },
    [pending],
  )

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
      if (e.key === 'Enter') close(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, close])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center"
            style={{ background: 'rgba(9, 30, 66, 0.55)' }}
            onClick={() => close(false)}
          >
            <div
              className="w-[420px] max-w-[90vw] rounded-lg shadow-card overflow-hidden"
              style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-4 flex items-start gap-3">
                <AlertCircle
                  size={20}
                  style={{ color: pending.opts.destructive ? '#BF2600' : 'var(--accent)' }}
                  className="shrink-0 mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-fg font-semibold text-[14px]">
                    {pending.opts.title}
                  </div>
                  <div className="text-[12.5px] text-muted mt-1">
                    {pending.opts.message}
                  </div>
                </div>
              </div>
              <div
                className="px-4 py-3 flex justify-end gap-2"
                style={{ background: 'var(--panel-2)', borderTop: '1px solid var(--border-soft)' }}
              >
                <button className="btn-ghost h-7" onClick={() => close(false)}>
                  {pending.opts.cancelLabel ?? 'Cancel'}
                </button>
                <button
                  className="btn-primary h-7"
                  style={
                    pending.opts.destructive
                      ? { background: '#BF2600', color: 'white' }
                      : undefined
                  }
                  onClick={() => close(true)}
                  autoFocus
                >
                  {pending.opts.confirmLabel ?? 'Confirm'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm: missing ConfirmProvider')
  return fn
}
