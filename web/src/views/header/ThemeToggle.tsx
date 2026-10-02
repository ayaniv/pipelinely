import { useTheme } from './useTheme'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  // Icon shown is what clicking will switch TO — moon while light, sun while dark.
  return (
    <button
      className="theme-toggle"
      id="theme-toggle"
      data-testid="theme-toggle"
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  )
}
