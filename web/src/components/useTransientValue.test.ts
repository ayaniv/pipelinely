import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTransientValue } from './useTransientValue'

describe('useTransientValue', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('holds a shown value for the duration, then clears it', () => {
    const { result } = renderHook(() => useTransientValue<string>(1000))
    expect(result.current[0]).toBeNull()

    act(() => result.current[1]('failed'))
    expect(result.current[0]).toBe('failed')

    act(() => { vi.advanceTimersByTime(999) })
    expect(result.current[0]).toBe('failed')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current[0]).toBeNull()
  })

  test('a newer value restarts the clock, so the older timer cannot clear it early', () => {
    const { result } = renderHook(() => useTransientValue<string>(1000))

    act(() => result.current[1]('first'))
    act(() => { vi.advanceTimersByTime(800) })
    act(() => result.current[1]('second'))
    act(() => { vi.advanceTimersByTime(800) })

    expect(result.current[0]).toBe('second')
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current[0]).toBeNull()
  })

  test('a call can override the default duration', () => {
    const { result } = renderHook(() => useTransientValue<string>(1000))

    act(() => result.current[1]('slow', 3000))
    act(() => { vi.advanceTimersByTime(2999) })
    expect(result.current[0]).toBe('slow')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current[0]).toBeNull()
  })

  test('does not fire after unmount', () => {
    const { result, unmount } = renderHook(() => useTransientValue<string>(1000))
    act(() => result.current[1]('x'))

    unmount()

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
  })
})
