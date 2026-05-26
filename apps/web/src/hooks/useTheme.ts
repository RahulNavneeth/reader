import { useEffect, useState } from 'react'

const KEY = 'mdr.theme'
type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => initialTheme())
  useEffect(() => {
    // Suppress every CSS transition during the theme swap. Without
    // this, anything with a `transition-colors` / `transition-*` rule
    // (buttons, nav items, checkboxes, hover backgrounds) crossfaded
    // from the old theme's colour to the new one's over ~150ms, while
    // the rest of the chrome — which uses inline CSS variables and so
    // has no transition — flipped instantly. The visual mismatch made
    // the whole toggle feel sluggish. The class is removed on the
    // next animation frame so normal hover/focus easing resumes
    // immediately after the swap.
    const root = document.documentElement
    root.classList.add('theme-transitioning')
    root.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(KEY, theme)
    const id = window.requestAnimationFrame(() => {
      // Two RAFs so the swap actually paints before we re-enable
      // transitions — a single RAF can fire inside the same paint
      // boundary and leak the transition.
      window.requestAnimationFrame(() => {
        root.classList.remove('theme-transitioning')
      })
    })
    return () => window.cancelAnimationFrame(id)
  }, [theme])
  return {
    theme,
    toggle: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
  }
}
