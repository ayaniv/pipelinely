import { describe, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useTriageSelection } from './useTriageSelection'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const ok = () => new Response(null, { status: 200 })

describe('useTriageSelection', () => {
  test('starts from what the server says is selected', () => {
    const { result } = renderHook(() => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected: [true, false], fetchImpl: vi.fn(), log: vi.fn() }))
    expect(result.current.selected).toEqual([true, false])
    expect(result.current.selectedCount).toBe(1)
  })

  test('a toggle shows immediately and POSTs the full selected-index set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const { result } = renderHook(() => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected: [true, false, true], fetchImpl, log: vi.fn() }))

    await act(async () => { await result.current.toggle(1) })

    expect(result.current.selected).toEqual([true, true, true])
    expect(fetchImpl).toHaveBeenCalledWith('/triage/t', expect.objectContaining({ body: JSON.stringify({ selected: [0, 1, 2] }) }))
  })

  test('toggling an already-selected row clears it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const { result } = renderHook(() => useTriageSelection({ slug: 't', endpoint: 'qa-triage', serverSelected: [true], fetchImpl, log: vi.fn() }))

    await act(async () => { await result.current.toggle(0) })

    expect(result.current.selected).toEqual([false])
    expect(fetchImpl).toHaveBeenCalledWith('/qa-triage/t', expect.objectContaining({ body: JSON.stringify({ selected: [] }) }))
  })

  test('a failed POST puts the row back to the server\'s selection and logs', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected: [true], fetchImpl, log }))

    await act(async () => { await result.current.toggle(0) })

    expect(result.current.selected).toEqual([true])
    expect(log).toHaveBeenCalledWith('[triage] POST /triage/t failed', expect.any(Error))
  })

  test('a failed toggle reverts only its own row while another toggle is still in flight', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const fetchImpl = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected: [false, false], fetchImpl, log: vi.fn() }))

    let firstToggle!: Promise<void>
    let secondToggle!: Promise<void>
    await act(async () => { firstToggle = result.current.toggle(0) })
    await act(async () => { secondToggle = result.current.toggle(1) })
    expect(result.current.selected).toEqual([true, true])

    await act(async () => { first.resolve(new Response(null, { status: 500 })); await firstToggle })
    expect(result.current.selected).toEqual([false, true])

    await act(async () => { second.resolve(ok()); await secondToggle })
  })

  test('the optimistic selection holds until the server\'s own state catches up, with no flicker back in between', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const { result, rerender } = renderHook(({ serverSelected }) => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected, fetchImpl, log: vi.fn() }), {
      initialProps: { serverSelected: [true, false] },
    })

    await act(async () => { await result.current.toggle(1) })
    expect(result.current.selected).toEqual([true, true])

    // An unrelated snapshot with the OLD selection (the write has not
    // reached the watcher yet) must not undo the click...
    rerender({ serverSelected: [true, false] })
    expect(result.current.selected).toEqual([true, true])

    // ...and once the server reports the new selection, it is authoritative.
    rerender({ serverSelected: [true, true] })
    expect(result.current.selected).toEqual([true, true])
    rerender({ serverSelected: [false, true] })
    await waitFor(() => expect(result.current.selected).toEqual([false, true]))
  })

  test('a later server change wins over a stale local selection once nothing is in flight', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const { result, rerender } = renderHook(({ serverSelected }) => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected, fetchImpl, log: vi.fn() }), {
      initialProps: { serverSelected: [false, false] },
    })
    await act(async () => { await result.current.toggle(0) })

    rerender({ serverSelected: [false, true] })

    await waitFor(() => expect(result.current.selected).toEqual([false, true]))
  })

  test('two quick toggles keep both, and a snapshot landing mid-flight does not drop the second', async () => {
    const first = deferred<Response>()
    const fetchImpl = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok())
    const { result, rerender } = renderHook(({ serverSelected }) => useTriageSelection({ slug: 't', endpoint: 'triage', serverSelected, fetchImpl, log: vi.fn() }), {
      initialProps: { serverSelected: [false, false] },
    })

    let firstDone!: Promise<void>
    act(() => { firstDone = result.current.toggle(0) })
    await act(async () => { await result.current.toggle(1) })
    rerender({ serverSelected: [true, false] })
    await act(async () => { first.resolve(ok()); await firstDone })

    expect(result.current.selected).toEqual([true, true])
  })
})
