import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClientState, type ClientState } from '../data/clientState'
import { makeMilestone, makeTask } from '../testing/makeTask'
import { runWaveBatch, WAVE_STATUS_VISIBLE_MS } from './waveBatch'

const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]

const parent = makeTask({
  slug: 'proj',
  stageHistory: PLAN_REVIEWED,
  milestones: [
    makeMilestone({ id: 'M0', wave: 1, state: 'done' }),
    makeMilestone({ id: 'M1', wave: 2, needs: ['M0'] }),
    makeMilestone({ id: 'M2', wave: 2, needs: ['M0'] }),
    makeMilestone({ id: 'M3', wave: 2, needs: ['M9'] }),
  ],
})

let state: ClientState
beforeEach(() => {
  state = createClientState()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function deps(response: Response | Error) {
  const fetchImpl = vi.fn()
  if (response instanceof Error) fetchImpl.mockRejectedValue(response)
  else fetchImpl.mockResolvedValue(response)
  return { fetchImpl, log: vi.fn(), state }
}

describe('runWaveBatch', () => {
  test("stages one command for the wave's queued, unblocked milestones only", async () => {
    const options = deps(new Response(null, { status: 200 }))

    await runWaveBatch(parent, 2, options)

    expect(JSON.parse(options.fetchImpl.mock.calls[0][1].body)).toEqual({ kind: 'wave', slugs: ['proj-m1', 'proj-m2'] })
  })

  test('every eligible milestone shares the one outcome, shown for a few seconds then cleared', async () => {
    await runWaveBatch(parent, 2, deps(new Response(null, { status: 200 })))

    expect(state.getDispatchStatus('proj-m1')).toEqual({ ok: true, label: 'staged', detail: undefined })
    expect(state.getDispatchStatus('proj-m2')).toEqual({ ok: true, label: 'staged', detail: undefined })
    expect(state.getDispatchStatus('proj-m3')).toBeNull()

    vi.advanceTimersByTime(WAVE_STATUS_VISIBLE_MS)
    expect(state.getDispatchStatus('proj-m1')).toBeNull()
    expect(state.getDispatchStatus('proj-m2')).toBeNull()
  })

  test("a second run's fresh outcome is not wiped by the first run's timer", async () => {
    await runWaveBatch(parent, 2, deps(new Response(null, { status: 200 })))
    vi.advanceTimersByTime(WAVE_STATUS_VISIBLE_MS - 1000)

    await runWaveBatch(parent, 2, deps(new Response(null, { status: 200 })))
    vi.advanceTimersByTime(1500)

    expect(state.getDispatchStatus('proj-m1')).not.toBeNull()
    vi.advanceTimersByTime(WAVE_STATUS_VISIBLE_MS)
    expect(state.getDispatchStatus('proj-m1')).toBeNull()
  })

  test("a smaller second run does not strand the slugs it no longer includes", async () => {
    const firstRunner = makeTask({
      slug: 'proj',
      stageHistory: PLAN_REVIEWED,
      milestones: [
        makeMilestone({ id: 'M0', wave: 1, state: 'done' }),
        makeMilestone({ id: 'M1', wave: 2, needs: ['M0'] }),
        makeMilestone({ id: 'M2', wave: 2, needs: ['M0'] }),
      ],
    })
    const secondRunner = makeTask({
      slug: 'proj',
      stageHistory: PLAN_REVIEWED,
      milestones: [
        makeMilestone({ id: 'M0', wave: 1, state: 'done' }),
        makeMilestone({ id: 'M1', wave: 2, state: 'dispatched', needs: ['M0'] }),
        makeMilestone({ id: 'M2', wave: 2, needs: ['M0'] }),
      ],
    })
    await runWaveBatch(firstRunner, 2, deps(new Response(null, { status: 200 })))
    vi.advanceTimersByTime(2000)

    await runWaveBatch(secondRunner, 2, deps(new Response(null, { status: 200 })))
    vi.advanceTimersByTime(15000)

    expect(state.getDispatchStatus('proj-m1')).toBeNull()
    expect(state.getDispatchStatus('proj-m2')).toBeNull()
  })

  test('an overlapping run only extends the slugs it shares, each clearing on its own clock', async () => {
    const staggered = (secondIncludesM1: boolean) =>
      makeTask({
        slug: 'proj',
        stageHistory: PLAN_REVIEWED,
        milestones: [
          makeMilestone({ id: 'M0', wave: 1, state: 'done' }),
          makeMilestone({ id: 'M1', wave: 2, state: secondIncludesM1 ? 'queued' : 'dispatched', needs: ['M0'] }),
          makeMilestone({ id: 'M2', wave: 2, needs: ['M0'] }),
        ],
      })
    await runWaveBatch(staggered(true), 2, deps(new Response(null, { status: 200 })))
    vi.advanceTimersByTime(3000)
    await runWaveBatch(staggered(false), 2, deps(new Response(null, { status: 200 })))

    vi.advanceTimersByTime(WAVE_STATUS_VISIBLE_MS - 3000)
    expect(state.getDispatchStatus('proj-m1')).toBeNull()
    expect(state.getDispatchStatus('proj-m2')).not.toBeNull()
    vi.advanceTimersByTime(3000)
    expect(state.getDispatchStatus('proj-m2')).toBeNull()
  })

  test("a failure carries the server's label and detail onto each milestone", async () => {
    const response = new Response(JSON.stringify({ error: 'no session' }), { status: 503, headers: { 'Content-Type': 'application/json' } })

    await runWaveBatch(parent, 2, deps(response))

    expect(state.getDispatchStatus('proj-m1')).toEqual({ ok: false, label: 'no orchestrator', detail: 'no session' })
  })

  test('the wave reads as running while the request is out, and never stays stuck after it fails', async () => {
    let observedDuringRequest = false
    const fetchImpl = vi.fn().mockImplementation(async () => {
      observedDuringRequest = state.isWaveRunning('proj', 2)
      throw new Error('down')
    })

    await runWaveBatch(parent, 2, { fetchImpl, log: vi.fn(), state })

    expect(observedDuringRequest).toBe(true)
    expect(state.isWaveRunning('proj', 2)).toBe(false)
    expect(state.getDispatchStatus('proj-m1')?.label).toBe('no server')
  })

  test('is a no-op when nothing in the wave is eligible', async () => {
    const options = deps(new Response(null, { status: 200 }))

    await runWaveBatch(parent, 1, options)

    expect(options.fetchImpl).not.toHaveBeenCalled()
    expect(state.isWaveRunning('proj', 1)).toBe(false)
  })

  test('ignores a second run of the same wave while one is in flight', async () => {
    state.setWaveRunning('proj', 2, true)
    const options = deps(new Response(null, { status: 200 }))

    await runWaveBatch(parent, 2, options)

    expect(options.fetchImpl).not.toHaveBeenCalled()
  })
})
