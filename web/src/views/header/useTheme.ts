import { useCallback, useEffect, useState } from 'react'
import type { Logger } from '../../log'

// data-theme (set synchronously in <head> by web/index.html's inline script) is
// the explicit override; absent that, the OS's prefers-color-scheme media
// query governs. The toggle always reflects — and flips — the currently
// EFFECTIVE theme, not just the stored one.
export const THEME_STORAGE_KEY = 'cockpit-theme'
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

export type Theme = 'light' | 'dark'

function readEffectiveTheme(): Theme {
  const explicit = document.documentElement.dataset.theme
  if (explicit === 'light' || explicit === 'dark') return explicit
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? 'dark' : 'light'
}

export function useTheme(log: Logger = console.error) {
  const [theme, setTheme] = useState<Theme>(readEffectiveTheme)

  // Only follow OS changes live while the user hasn't made an explicit choice.
  useEffect(() => {
    const query = window.matchMedia(DARK_SCHEME_QUERY)
    const handleChange = () => {
      if (!document.documentElement.dataset.theme) setTheme(readEffectiveTheme())
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  const toggleTheme = useCallback(() => {
    const next: Theme = readEffectiveTheme() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    setTheme(next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch (err) {
      // Private mode / blocked site data: the theme still applies to this
      // page view, it just won't survive a reload.
      log('[theme] could not persist the theme choice', err)
    }
  }, [log])

  return { theme, toggleTheme }
}
