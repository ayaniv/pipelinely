import { describe, expect, test } from 'vitest'
import type { MilestoneStatus, Stage } from '../../src/types'
import { makeMilestone, makeTask } from './testing/makeTask'
import { buildWaves, reworkMilestoneIds, waveCardLabel, waveCardStatus } from './waveModel'

// dashboard-v4-inner-view M1. The one model of a fan-out parent's waves that
// both the pipeline chart (Dev's wave dots, the rework loop) and M2's wave
// graph draw from. Waves and milestone states come from computeMilestones
// (src/taskParser.ts); this only folds them into what the charts show.

function dispatched(id: string, wave: number, stage: Stage): MilestoneStatus {
  return makeMilestone({ id, wave, state: 'dispatched', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage, status: 'working' }) })
}

const merged = (id: string, wave: number) => makeMilestone({ id, wave, state: 'done', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage: null, status: 'done' }) })
const queued = (id: string, wave: number) => makeMilestone({ id, wave })

describe('waveCardStatus', () => {
  test('merged, queued, and a dispatched child by its own stage', () => {
    expect(waveCardStatus(merged('M0', 1))).toBe('merged')
    expect(waveCardStatus(queued('M1', 2))).toBe('queued')
    expect(waveCardStatus(dispatched('M1', 2, 'code-review'))).toBe('review')
    expect(waveCardStatus(dispatched('M1', 2, 'comment-fix'))).toBe('review')
    expect(waveCardStatus(dispatched('M1', 2, 'dev'))).toBe('working')
    expect(waveCardStatus(dispatched('M1', 2, 'qa'))).toBe('working')
  })

  test('a dispatched milestone whose child has not loaded yet reads as working, not queued', () => {
    expect(waveCardStatus(makeMilestone({ id: 'M1', state: 'dispatched', task: null }))).toBe('working')
  })
})

describe('waveCardLabel', () => {
  test('names where the milestone actually is', () => {
    expect(waveCardLabel(merged('M0', 1))).toBe('merged')
    expect(waveCardLabel(queued('M1', 2))).toBe('queued')
    expect(waveCardLabel(dispatched('M1', 2, 'code-review'))).toBe('in review')
    expect(waveCardLabel(dispatched('M1', 2, 'dev'))).toBe('working')
    expect(waveCardLabel(dispatched('M1', 2, 'qa'))).toBe('in QA')
  })
})

describe('buildWaves', () => {
  test('groups milestones by wave in order, keeping declared order inside a wave', () => {
    const waves = buildWaves([queued('M2', 2), merged('M0', 1), queued('M1', 2)])
    expect(waves.map((w) => w.wave)).toEqual([1, 2])
    expect(waves[1].cards.map((c) => c.id)).toEqual(['M2', 'M1'])
  })

  test('a wave with every milestone merged is complete; the next is running; any after an incomplete one is locked', () => {
    const waves = buildWaves([merged('M0', 1), dispatched('M1', 2, 'dev'), queued('M2', 2), queued('M3', 3)])
    expect(waves.map((w) => w.state)).toEqual(['complete', 'running', 'locked'])
    expect(waves[1].doneCount).toBe(0)
  })

  test('the first wave is never locked, even when nothing has started', () => {
    expect(buildWaves([queued('M0', 1), queued('M1', 2)]).map((w) => w.state)).toEqual(['running', 'locked'])
  })

  test('each card carries its child slug once dispatched, and null while queued', () => {
    const [wave] = buildWaves([merged('M0', 1), queued('M1', 1)])
    expect(wave.cards.map((c) => c.childSlug)).toEqual(['p-m0', null])
  })

  test('no milestones, no waves', () => {
    expect(buildWaves([])).toEqual([])
  })
})

describe('reworkMilestoneIds', () => {
  test('lists the milestones in code review or CR fixes, in declared order', () => {
    const milestones = [dispatched('M2', 2, 'comment-fix'), merged('M0', 1), dispatched('M1', 2, 'code-review'), dispatched('M3', 3, 'qa')]
    expect(reworkMilestoneIds(milestones)).toEqual(['M2', 'M1'])
  })

  test('none in review, no loop', () => {
    expect(reworkMilestoneIds([merged('M0', 1), queued('M1', 2)])).toEqual([])
  })
})
