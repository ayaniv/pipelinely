import { describe, expect, it } from 'vitest'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { resolveGraphSlot } from './graphSlotTarget'

const nav = (overrides: Partial<Parameters<typeof resolveGraphSlot>[1]> = {}) => ({ l1Tab: 'dev' as const, l2Tab: null, milestoneId: null, ...overrides })
const parent = makeTask({ milestones: [makeMilestone({ id: 'M0' }), makeMilestone({ id: 'M1' })] })

describe('resolveGraphSlot', () => {
  it('draws the eight-stage chain for a flat task', () => {
    expect(resolveGraphSlot(makeTask(), nav())).toEqual({ kind: 'stage-chain', stages: 'flat' })
  })

  it('draws the ds chain for a ds task', () => {
    expect(resolveGraphSlot(makeTask({ kind: 'ds' }), nav())).toEqual({ kind: 'stage-chain', stages: 'ds' })
  })

  it('draws the six-stage chain for a dispatched milestone child opened on its own', () => {
    expect(resolveGraphSlot(makeTask({ projectTitle: 'Big project' }), nav())).toEqual({ kind: 'stage-chain', stages: 'milestone' })
  })

  it("draws the parent's own five-node chart whichever stage is selected", () => {
    for (const l1Tab of ['planning', 'plan-review', 'dev', 'cr', 'qa', 'merge'] as const) {
      expect(resolveGraphSlot(parent, nav({ l1Tab }))).toEqual({ kind: 'parent-chart' })
    }
  })

  it('draws the drilled-into milestone with its own chain', () => {
    expect(resolveGraphSlot(parent, nav({ milestoneId: 'M1' }))).toEqual({ kind: 'milestone-detail', milestone: parent.milestones![1] })
  })

  it('a drill-down only applies on Dev', () => {
    expect(resolveGraphSlot(parent, nav({ l1Tab: 'cr', milestoneId: 'M1' }))).toEqual({ kind: 'parent-chart' })
  })

  it('falls back to the parent chart when the drilled milestone is gone from the plan', () => {
    expect(resolveGraphSlot(parent, nav({ milestoneId: 'M9' }))).toEqual({ kind: 'parent-chart' })
  })
})
