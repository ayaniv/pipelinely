import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import type { MilestoneStatus, Stage, StageEvent } from '../../src/types'
import { READ_ONLY_INSTANCE_TITLE } from './components/readOnly'
import { createClientState, type ClientState } from './data/clientState'
import type { Logger } from './log'
import { makeMilestone, makeTask } from './testing/makeTask'
import { nextWaveAction, nextWaveButtonState, nextWaveTitle, runNextWave, type NextWaveAction } from './nextWave'

// dashboard-v4-inner-view M2. REQUEST-v4.md §4: waves run in order; Run next
// wave starts the first wave that isn't complete, only when every earlier wave
// is complete, otherwise it is disabled with "Waiting on wave N · M1 in
// review". Which milestones of a wave can start is eligibleWaveMilestones
// (milestoneModel.ts), the same gate the old per-wave Run button used — never
// a second readiness rule.

const PLANNED: StageEvent[] = [
  { stage: 'planning', at: '2026-08-10T09:00:00Z', note: 'done' },
  { stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: 'looks good' },
]

function dispatched(id: string, wave: number, stage: Stage, needs: string[] = []): MilestoneStatus {
  return makeMilestone({ id, wave, needs, state: 'dispatched', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage, status: 'working' }) })
}
const merged = (id: string, wave: number, needs: string[] = []) => makeMilestone({ id, wave, needs, state: 'done', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage: null, status: 'done' }) })
const queued = (id: string, wave: number, needs: string[] = []) => makeMilestone({ id, wave, needs })

const parent = (milestones: MilestoneStatus[], stageHistory = PLANNED) => makeTask({ slug: 'p', milestones, stageHistory, status: 'waiting' })

describe('nextWaveAction', () => {
  test('runs the first wave that is not complete, with its queued, unblocked milestones', () => {
    const action = nextWaveAction(parent([merged('M0', 1), queued('M1', 2, ['M0']), queued('M2', 2, ['M0'])]))
    expect(action).toEqual({ kind: 'run', wave: 2, slugs: ['p-m1', 'p-m2'] })
  })

  test('the very first wave runs as soon as the plan is reviewed', () => {
    expect(nextWaveAction(parent([queued('M0', 1), queued('M1', 2, ['M0'])]))).toEqual({ kind: 'run', wave: 1, slugs: ['p-m0'] })
  })

  test('only the queued part of a partly started wave runs', () => {
    const action = nextWaveAction(parent([dispatched('M0', 1, 'dev'), queued('M1', 1)]))
    expect(action).toEqual({ kind: 'run', wave: 1, slugs: ['p-m1'] })
  })

  test('a fully started but unmerged wave blocks the next one, naming what it waits on', () => {
    const action = nextWaveAction(parent([dispatched('M0', 1, 'code-review'), merged('M1', 1), queued('M2', 2, ['M0'])]))
    expect(action).toEqual({ kind: 'blocked', wave: 1, waitingOn: [{ id: 'M0', label: 'in review' }] })
  })

  test('a later wave waits for the earlier wave even when its own needs are met (wave order is stricter than needs:)', () => {
    const action = nextWaveAction(parent([merged('M0', 1), dispatched('M1', 1, 'dev'), queued('M2', 2, ['M0'])]))
    expect(action.kind).toBe('blocked')
  })

  test('without a reviewed plan nothing can start', () => {
    expect(nextWaveAction(parent([queued('M0', 1)], [PLANNED[0]]))).toEqual({ kind: 'plan-not-reviewed', wave: 1 })
  })

  test('every wave merged: nothing left to run', () => {
    expect(nextWaveAction(parent([merged('M0', 1), merged('M1', 2)]))).toEqual({ kind: 'all-merged' })
  })

  test('a parent with no milestones has nothing to run', () => {
    expect(nextWaveAction(parent([]))).toEqual({ kind: 'all-merged' })
  })
})

describe('nextWaveTitle', () => {
  test('a blocked wave reads "Waiting on wave N · <id> <label>, …"', () => {
    expect(nextWaveTitle({ kind: 'blocked', wave: 1, waitingOn: [{ id: 'M1', label: 'in review' }, { id: 'M2', label: 'in QA' }] }, true))
      .toBe('Waiting on wave 1 · M1 in review, M2 in QA')
  })

  test('a read-only dashboard says so whatever the wave state', () => {
    expect(nextWaveTitle({ kind: 'run', wave: 2, slugs: ['p-m1'] }, false)).toBe(READ_ONLY_INSTANCE_TITLE)
    expect(nextWaveTitle({ kind: 'blocked', wave: 1, waitingOn: [{ id: 'M1', label: 'in review' }] }, false)).toBe(READ_ONLY_INSTANCE_TITLE)
  })

  test('a runnable wave says which wave and how many milestones it stages', () => {
    expect(nextWaveTitle({ kind: 'run', wave: 2, slugs: ['p-m1', 'p-m2'] }, true)).toMatch(/wave 2/)
  })
})

describe('nextWaveButtonState', () => {
  const run: NextWaveAction = { kind: 'run', wave: 2, slugs: ['p-m1'] }
  let state: ClientState

  beforeEach(() => {
    state = createClientState()
  })

  test('a runnable wave on the canonical instance is enabled with the staging hint', () => {
    expect(nextWaveButtonState('p', run, true, state)).toEqual({ isDisabled: false, title: nextWaveTitle(run, true) })
  })

  test('off the canonical instance it is disabled with the read-only title, even while staging', () => {
    state.setWaveRunning('p', 2, true)
    expect(nextWaveButtonState('p', run, false, state)).toEqual({ isDisabled: true, title: READ_ONLY_INSTANCE_TITLE })
  })

  test('while the wave is being staged it is disabled with the staging title', () => {
    state.setWaveRunning('p', 2, true)
    expect(nextWaveButtonState('p', run, true, state)).toEqual({ isDisabled: true, title: 'Staging wave 2…' })
  })

  test('a blocked, unreviewed or finished wave is disabled and says why', () => {
    const blocked: NextWaveAction = { kind: 'blocked', wave: 1, waitingOn: [{ id: 'M1', label: 'in review' }] }
    expect(nextWaveButtonState('p', blocked, true, state)).toEqual({ isDisabled: true, title: 'Waiting on wave 1 · M1 in review' })
    expect(nextWaveButtonState('p', { kind: 'plan-not-reviewed', wave: 1 }, true, state)).toEqual({ isDisabled: true, title: 'The plan has not been reviewed yet' })
    expect(nextWaveButtonState('p', { kind: 'all-merged' }, true, state)).toEqual({ isDisabled: true, title: 'Every wave is merged' })
  })
})

describe('runNextWave', () => {
  let state: ClientState
  let log: Mock<Logger>

  beforeEach(() => {
    state = createClientState()
    log = vi.fn<Logger>()
  })

  const respondWith = (status: number) => vi.fn(async () => new Response(status === 200 ? null : 'busy', { status }))

  test('stages the runnable wave through the existing /batch-dispatch wave batch', async () => {
    const fetchImpl = respondWith(200)
    await runNextWave(parent([merged('M0', 1), queued('M1', 2, ['M0'])]), { fetchImpl, log, state })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/batch-dispatch$/)
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'wave', slugs: ['p-m1'] })
  })

  test('does nothing when the next wave is blocked', async () => {
    const fetchImpl = respondWith(200)
    await runNextWave(parent([dispatched('M0', 1, 'code-review'), queued('M1', 2, ['M0'])]), { fetchImpl, log, state })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a refused batch is logged and recorded as a failed outcome on the wave\'s milestones', async () => {
    await runNextWave(parent([merged('M0', 1), queued('M1', 2, ['M0'])]), { fetchImpl: respondWith(409), log, state })
    expect(log).toHaveBeenCalled()
    expect(state.getDispatchStatus('p-m1')?.ok).toBe(false)
    expect(state.isWaveRunning('p', 2)).toBe(false)
  })
})
