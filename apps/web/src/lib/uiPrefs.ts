/**
 * Small per-user UI preferences backed by localStorage. Currently
 * holds the global Vim-mode flag for the markdown editor; designed
 * to grow other personal preferences (e.g. font size, syntax theme)
 * without introducing a server round-trip.
 *
 * Changes propagate cross-component via a custom DOM event so a
 * toggle in the UserMenu immediately re-renders any open editor
 * subscribed via `useVimMode()`. Pure DOM event is enough here —
 * we don't need a full context provider for one boolean.
 */
import { useEffect, useState } from 'react'

const VIM_KEY = 'reader:crdtVim'
const PREF_EVENT = 'reader:uiPrefs'

function readVim(): boolean {
  try {
    return localStorage.getItem(VIM_KEY) === '1'
  } catch {
    return false
  }
}

export function getVimMode(): boolean {
  return readVim()
}

export function setVimMode(next: boolean): void {
  try {
    localStorage.setItem(VIM_KEY, next ? '1' : '0')
  } catch {/* private-mode storage failure — ignore */}
  // Same-tab listeners. The native `storage` event only fires on
  // OTHER tabs, so we dispatch our own for the current tab.
  window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: VIM_KEY, value: next } }))
}

export function useVimMode(): [boolean, (next: boolean) => void] {
  const [vim, setVim] = useState<boolean>(readVim)
  useEffect(() => {
    const onPref = () => setVim(readVim())
    const onStorage = (e: StorageEvent) => {
      if (e.key === VIM_KEY) setVim(readVim())
    }
    window.addEventListener(PREF_EVENT, onPref)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PREF_EVENT, onPref)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return [vim, setVimMode]
}
