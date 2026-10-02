import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useActionFlash } from './useActionFlash'

// Surface an action's outcome on the button itself (class + label) for a duration, then revert — used by
// FocusButton/HandoverPill/CardMenu's own action items instead of each
// re-implementing the same timeout/revert dance.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useActionFlash', () => {
  test('starts idle: no class, no override label', () => {
    const { result } = renderHook(() => useActionFlash())
    expect(result.current.flash).toEqual({ className: '', label: null })
  })

  test('show() sets the class and label immediately', () => {
    const { result } = renderHook(() => useActionFlash())
    act(() => result.current.show('btn-ok', '✓'))
    expect(result.current.flash).toEqual({ className: 'btn-ok', label: '✓' })
  })

  test('reverts to idle after the default duration (1400ms)', () => {
    const { result } = renderHook(() => useActionFlash())
    act(() => result.current.show('btn-err', 'failed'))
    act(() => vi.advanceTimersByTime(1399))
    expect(result.current.flash.label).toBe('failed')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.flash).toEqual({ className: '', label: null })
  })

  test('an explicit duration overrides the default', () => {
    const { result } = renderHook(() => useActionFlash())
    act(() => result.current.show('btn-err', 'no server', 6000))
    act(() => vi.advanceTimersByTime(1400))
    expect(result.current.flash.label).toBe('no server')
    act(() => vi.advanceTimersByTime(4600))
    expect(result.current.flash).toEqual({ className: '', label: null })
  })

  test('a second show() before the first reverts replaces it and restarts the timer', () => {
    const { result } = renderHook(() => useActionFlash())
    act(() => result.current.show('btn-ok', '✓'))
    act(() => vi.advanceTimersByTime(1000))
    act(() => result.current.show('btn-err', 'failed'))
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.flash).toEqual({ className: 'btn-err', label: 'failed' })
    act(() => vi.advanceTimersByTime(400))
    expect(result.current.flash).toEqual({ className: '', label: null })
  })

  // CR finding: none of the dispatching primitives guarded against a second
  // click while the first POST was still in flight. run() is the shared fix
  // every primitive wires up to.
  describe('run', () => {
    test('isPending is false until run() starts, true while the action is in flight, false again after', async () => {
      const { result } = renderHook(() => useActionFlash())
      expect(result.current.isPending).toBe(false)

      let resolveAction: () => void = () => {}
      const action = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve }))

      let runPromise!: Promise<void>
      act(() => { runPromise = result.current.run(action) })
      expect(result.current.isPending).toBe(true)

      await act(async () => { resolveAction(); await runPromise })
      expect(result.current.isPending).toBe(false)
    })

    // The actual enforcement: a second run() call landing while the first
    // is still pending must not invoke the action a second time — this has
    // to hold even before React re-renders with isPending: true (a fast
    // double-click can beat that), which is why the guard underneath is a
    // synchronous ref, not the isPending state value itself.
    test('a second run() call while the first is still pending is a no-op', async () => {
      const { result } = renderHook(() => useActionFlash())
      let resolveAction: () => void = () => {}
      const action = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve }))

      let firstPromise!: Promise<void>
      let secondPromise!: Promise<void>
      act(() => {
        firstPromise = result.current.run(action)
        secondPromise = result.current.run(action) // fires before the first resolves
      })
      expect(action).toHaveBeenCalledTimes(1)

      await act(async () => { resolveAction(); await Promise.all([firstPromise, secondPromise]) })
      expect(action).toHaveBeenCalledTimes(1)
    })

    test('a third run() call after the first completes runs normally', async () => {
      const { result } = renderHook(() => useActionFlash())
      const action = vi.fn().mockResolvedValue(undefined)

      await act(async () => { await result.current.run(action) })
      await act(async () => { await result.current.run(action) })

      expect(action).toHaveBeenCalledTimes(2)
    })

    test('isPending still clears when the action throws', async () => {
      const { result } = renderHook(() => useActionFlash())
      const action = vi.fn().mockRejectedValue(new Error('boom'))
      vi.spyOn(console, 'error').mockImplementation(() => {})

      // run() now absorbs (and logs) the throw instead of rethrowing it into
      // an unhandled rejection — see the dedicated test at the bottom.
      await act(async () => { await result.current.run(action) })

      expect(result.current.isPending).toBe(false)
    })
  })
})

describe('useActionFlash run(): a throwing action', () => {
  test('is logged with an [action] prefix, flashes the failure, and still releases the pending guard', async () => {
    const log = vi.fn()
    const { result } = renderHook(() => useActionFlash(log))

    await act(async () => { await result.current.run(async () => { throw new Error('boom') }) })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
    expect(result.current.flash).toEqual({ className: 'btn-err', label: 'failed' })
    expect(result.current.isPending).toBe(false)
  })
})