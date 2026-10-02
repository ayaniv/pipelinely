import { describe, expect, test } from 'vitest'
import { makeMilestone, makeTask } from './testing/makeTask'
import { eligibleWaveMilestones, milestoneActual, milestoneChildSlug, milestoneStatusMeta, waveRule } from './milestoneModel'

const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]

describe('milestoneChildSlug', () => {
  test("is the parent's slug plus the lower-cased milestone id", () => {
    expect(milestoneChildSlug('react-migration', 'M7')).toBe('react-migration-m7')
  })
})

describe('waveRule', () => {
  test('names parallel milestones by count', () => {
    expect(waveRule([makeMilestone({ id: 'M1' }), makeMilestone({ id: 'M2' })])).toBe('parallel · 2 tabs')
  })

  test('calls a lone milestone waiting on two or more blockers a convergence point', () => {
    expect(waveRule([makeMilestone({ id: 'M5', needs: ['M2', 'M3'] })])).toBe('converges · waits for 2')
  })

  test('calls a lone milestone with at most one blocker sequential', () => {
    expect(waveRule([makeMilestone({ id: 'M1', needs: ['M0'] })])).toBe('sequential · alone')
    expect(waveRule([makeMilestone({ id: 'M0' })])).toBe('sequential · alone')
  })
})

describe('eligibleWaveMilestones', () => {
  const milestones = [
    makeMilestone({ id: 'M0', wave: 1, state: 'done' }),
    makeMilestone({ id: 'M1', wave: 2, needs: ['M0'] }),
    makeMilestone({ id: 'M2', wave: 2, needs: ['M3'] }),
    makeMilestone({ id: 'M3', wave: 3 }),
  ]

  test('keeps only queued milestones of the wave whose needs are all done', () => {
    expect(eligibleWaveMilestones(milestones, 2, PLAN_REVIEWED).map((m) => m.id)).toEqual(['M1'])
  })

  test('is empty until the plan has been reviewed, even for an unblocked milestone', () => {
    expect(eligibleWaveMilestones(milestones, 2, [])).toEqual([])
  })

  test('is empty for a wave with no milestones', () => {
    expect(eligibleWaveMilestones(milestones, 9, PLAN_REVIEWED)).toEqual([])
  })
})

describe('milestoneStatusMeta', () => {
  test('reads queued in the quiet palette and merged in the sage one', () => {
    expect(milestoneStatusMeta(makeMilestone({ id: 'M0', state: 'queued' })).label).toBe('queued')
    expect(milestoneStatusMeta(makeMilestone({ id: 'M0', state: 'done' })).label).toBe('merged')
  })

  test("labels a dispatched milestone by its child's real stage", () => {
    const child = makeTask({ stage: 'code-review' })
    expect(milestoneStatusMeta(makeMilestone({ id: 'M0', state: 'dispatched', task: child })).label).toBe('code review')
    expect(milestoneStatusMeta(makeMilestone({ id: 'M0', state: 'dispatched', task: makeTask({ stage: 'qa-fixes' }) })).label).toBe('qa fixes')
  })

  test('falls back to dev for a dispatched milestone whose child has no stage yet', () => {
    expect(milestoneStatusMeta(makeMilestone({ id: 'M0', state: 'dispatched', task: null })).label).toBe('dev')
  })
})

describe('milestoneActual', () => {
  const finished = (startIso: string, endIso: string | null) =>
    makeTask({ stageHistory: [{ stage: 'dev', at: startIso, note: '' }], completedAt: endIso })

  test('runs from the first TIMELINE entry to the completion date', () => {
    expect(milestoneActual(finished('2026-01-01T00:00:00Z', '2026-01-01T02:30:00Z'))).toBe('2h30m')
    expect(milestoneActual(finished('2026-01-01T00:00:00Z', '2026-01-01T03:00:00Z'))).toBe('3h')
    expect(milestoneActual(finished('2026-01-01T00:00:00Z', '2026-01-01T00:45:00Z'))).toBe('45m')
  })

  test('is null whenever either end is missing or the range is not positive — never a guess', () => {
    expect(milestoneActual(null)).toBeNull()
    expect(milestoneActual(finished('2026-01-01T00:00:00Z', null))).toBeNull()
    expect(milestoneActual(makeTask({ completedAt: '2026-01-01T00:00:00Z', stageHistory: [] }))).toBeNull()
    expect(milestoneActual(finished('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'))).toBeNull()
    expect(milestoneActual(finished('not a date', '2026-01-01T00:00:00Z'))).toBeNull()
  })
})
