import { describe, expect, it } from 'vitest'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { resolveGraphSlot } from './graphSlotTarget'

const nav = (overrides: Partial<Parameters<typeof resolveGraphSlot>[1]> = {}) => ({ l1Tab: 'dev' as const, l2Tab: null, milestoneId: null, ...overrides })
const parent = makeTask({ milestones: [makeMilestone({ id: 'M0' }), makeMilestone({ id: 'M1' })] })

describe('resolveGraphSlot', () => {
  it('draws the eight-stage chain for a flat task', () => {
    expect(resolveGraphSlot(makeTask(), nav())).toEqual({ kind: 'stage-chain', stages: 'flat' })
  })

  it('draws the six-stage chain for a dispatched milestone child opened on its own', () => {
    expect(resolveGraphSlot(makeTask({ projectTitle: 'Big project' }), nav())).toEqual({ kind: 'stage-chain', stages: 'milestone' })
  })

  it("draws nothing on a fan-out parent's Plan and Plan Review tabs", () => {
    expect(resolveGraphSlot(parent, nav({ l1Tab: 'plan' }))).toEqual({ kind: 'none' })
    expect(resolveGraphSlot(parent, nav({ l1Tab: 'plan-review' }))).toEqual({ kind: 'none' })
  })

  it("draws the milestone graph on a fan-out parent's Dev tab", () => {
    expect(resolveGraphSlot(parent, nav())).toEqual({ kind: 'milestone-graph' })
  })

  it('draws the drilled-into milestone with its own chain', () => {
    expect(resolveGraphSlot(parent, nav({ milestoneId: 'M1' }))).toEqual({ kind: 'milestone-detail', milestone: parent.milestones![1] })
  })

  it('falls back to the milestone graph when the drilled milestone is gone from the plan', () => {
    expect(resolveGraphSlot(parent, nav({ milestoneId: 'M9' }))).toEqual({ kind: 'milestone-graph' })
  })
})
