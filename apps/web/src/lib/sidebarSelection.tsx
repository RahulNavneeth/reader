import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * Multi-select state shared across every VaultTree node in the
 * sidebar. Plain click navigates / toggles expansion (and clears
 * the selection). Shift-click toggles the node in/out of the set
 * instead — letting the user assemble a bulk selection across
 * folders and then drag the whole set to a new parent in one
 * gesture.
 *
 * Lifted out of the tree so every recursive `<VaultTree>` reads
 * the same set without prop-drilling. The drag/drop handlers on
 * each row consult `selected` to decide whether to package one
 * path or many.
 */
type SidebarSelectionCtx = {
  selected: Set<string>
  isSelected: (path: string) => boolean
  toggle: (path: string) => void
  clear: () => void
}

const Ctx = createContext<SidebarSelectionCtx | null>(null)

export function SidebarSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const isSelected = useCallback(
    (path: string) => selected.has(path),
    [selected],
  )
  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const clear = useCallback(() => setSelected(new Set()), [])
  const value = useMemo(
    () => ({ selected, isSelected, toggle, clear }),
    [selected, isSelected, toggle, clear],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSidebarSelection(): SidebarSelectionCtx {
  const v = useContext(Ctx)
  if (!v) {
    // No provider — return a no-op shell so VaultTree works in
    // places without the sidebar wiring (e.g. unit tests).
    return {
      selected: new Set(),
      isSelected: () => false,
      toggle: () => {},
      clear: () => {},
    }
  }
  return v
}
