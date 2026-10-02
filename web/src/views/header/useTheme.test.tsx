import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { THEME_STORAGE_KEY, useTheme } from './useTheme'

interface FakeMediaQuery {
  matches: boolean
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

describe('useTheme', () => {
  let mediaQuery: FakeMediaQuery
  let changeListeners: Array<() => void>
  let storage: Map<string, string>
  let log: Mock<(message: string, ...args: unknown[]) => void>

  beforeEach(() => {
    changeListeners = []
    mediaQuery = {
      matches: false,
      addEventListener: (_type, listener) => { changeListeners.push(listener) },
      removeEventListener: (_type, listener) => { changeListeners = changeListeners.filter((l) => l !== listener) },
    }
    vi.stubGlobal('matchMedia', () => mediaQuery)
    storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
    delete document.documentElement.dataset.theme
    log = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  test('with no explicit choice it reads the OS scheme', () => {
    mediaQuery.matches = true
    const { result } = renderHook(() => useTheme(log))
    expect(result.current.theme).toBe('dark')
  })

  test('an explicit data-theme wins over the OS scheme', () => {
    mediaQuery.matches = true
    document.documentElement.dataset.theme = 'light'
    const { result } = renderHook(() => useTheme(log))
    expect(result.current.theme).toBe('light')
  })

  test('toggling flips the effective theme, writes data-theme and persists it', () => {
    const { result } = renderHook(() => useTheme(log))
    expect(result.current.theme).toBe('light')

    act(() => result.current.toggleTheme())

    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark')
  })

  test('an OS scheme change is followed only while no explicit choice exists', () => {
    const { result } = renderHook(() => useTheme(log))

    mediaQuery.matches = true
    act(() => changeListeners.forEach((listener) => listener()))
    expect(result.current.theme).toBe('dark')

    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('light')
    mediaQuery.matches = true
    act(() => changeListeners.forEach((listener) => listener()))
    expect(result.current.theme).toBe('light')
  })

  test('a storage failure still flips the theme and logs', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('blocked') }, getItem: () => null })
    const { result } = renderHook(() => useTheme(log))

    act(() => result.current.toggleTheme())

    expect(result.current.theme).toBe('dark')
    expect(log).toHaveBeenCalledWith('[theme] could not persist the theme choice', expect.any(Error))
  })

  test('removes its OS-change listener on unmount', () => {
    const { unmount } = renderHook(() => useTheme(log))
    expect(changeListeners).toHaveLength(1)
    unmount()
    expect(changeListeners).toHaveLength(0)
  })
})
