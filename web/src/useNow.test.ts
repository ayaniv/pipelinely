import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNow } from './useNow'

// The board re-renders on a tick, so a relative timestamp stays live with no
// network and no DOM patching.

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useNow', () => {
  test('starts at the current time and advances on each interval tick', () => {
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    const { result } = renderHook(() => useNow(30_000))
    const start = result.current

    act(() => { vi.advanceTimersByTime(30_000) })

    expect(result.current).toBe(start + 30_000)
  })

  test('does not tick before the interval elapses', () => {
    const { result } = renderHook(() => useNow(30_000))
    const start = result.current
    act(() => { vi.advanceTimersByTime(29_999) })
    expect(result.current).toBe(start)
  })

  test('stops ticking after unmount', () => {
    const { unmount } = renderHook(() => useNow(30_000))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
