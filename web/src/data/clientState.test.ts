import { describe, expect, it, vi } from 'vitest'
import { createClientState } from './clientState'

describe('off focus', () => {
  it('starts in focus, toggles off, and toggles back', () => {
    const state = createClientState()
    expect(state.isOffFocus('a')).toBe(false)
    state.toggleOffFocus('a')
    expect(state.isOffFocus('a')).toBe(true)
    expect(state.isOffFocus('b')).toBe(false)
    state.toggleOffFocus('a')
    expect(state.isOffFocus('a')).toBe(false)
  })

  it('notifies subscribers on each toggle, and not after they unsubscribe', () => {
    const state = createClientState()
    const listener = vi.fn()
    const unsubscribe = state.subscribe(listener)
    state.toggleOffFocus('a')
    state.toggleOffFocus('a')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    state.toggleOffFocus('a')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('merge state', () => {
  it('is idle with no banner for a slug nothing has touched', () => {
    expect(createClientState().getMergeState('a')).toEqual({ banner: null, isInFlight: false })
  })

  it('marks a merge in flight and clears a stale banner as it begins', () => {
    const state = createClientState()
    state.beginMerge('a')
    state.settleMerge('a', { tone: 'error', lines: ['blocked'] })
    state.beginMerge('a')
    expect(state.getMergeState('a')).toEqual({ banner: null, isInFlight: true })
  })

  it('settles with the outcome banner and leaves other slugs alone', () => {
    const state = createClientState()
    state.beginMerge('a')
    state.beginMerge('b')
    state.settleMerge('a', { tone: 'warning', lines: ['cleanup needs a hand'] })
    expect(state.getMergeState('a')).toEqual({ banner: { tone: 'warning', lines: ['cleanup needs a hand'] }, isInFlight: false })
    expect(state.getMergeState('b').isInFlight).toBe(true)
  })

  it('settling with no banner clears it', () => {
    const state = createClientState()
    state.beginMerge('a')
    state.settleMerge('a', { tone: 'error', lines: ['x'] })
    state.beginMerge('a')
    state.settleMerge('a', null)
    expect(state.getMergeState('a')).toEqual({ banner: null, isInFlight: false })
  })
})

describe('wave batches', () => {
  it('tracks which parent:wave batches are mid-flight', () => {
    const state = createClientState()
    expect(state.isWaveRunning('p', 1)).toBe(false)
    state.setWaveRunning('p', 1, true)
    expect(state.isWaveRunning('p', 1)).toBe(true)
    expect(state.isWaveRunning('p', 2)).toBe(false)
    state.setWaveRunning('p', 1, false)
    expect(state.isWaveRunning('p', 1)).toBe(false)
  })
})

describe('milestone dispatch status', () => {
  it('holds a status per child slug until cleared', () => {
    const state = createClientState()
    state.setDispatchStatuses(['p-m0', 'p-m1'], { ok: true, label: 'staged', detail: undefined })
    expect(state.getDispatchStatus('p-m0')).toEqual({ ok: true, label: 'staged', detail: undefined })
    state.clearDispatchStatuses(['p-m0'])
    expect(state.getDispatchStatus('p-m0')).toBeNull()
    expect(state.getDispatchStatus('p-m1')).not.toBeNull()
  })
})
