import { describe, expect, it } from 'vitest'
import type { MilestoneStatus, Task } from '../../../../../src/types'
import type { TaskDetailNav } from '../detailNav'
import { resolvePanelTarget } from './panelTarget'

const task = (overrides: Partial<Task> = {}): Task => ({ slug: 'p', status: 'working', stage: 'dev', stageHistory: [], waitingReason: undefined, ...overrides }) as unknown as Task
const milestone = (id: string, overrides: Partial<MilestoneStatus> = {}): MilestoneStatus => ({ id, name: id, needs: [], estimate: null, specFile: null, wave: 1, task: null, state: 'queued', ...overrides })
const nav = (overrides: Partial<TaskDetailNav> = {}): TaskDetailNav => ({ l1Tab: 'dev', l2Tab: null, milestoneId: null, ...overrides })
const PLAN_REVIEWED = { stageHistory: [{ stage: 'plan-review', at: 'x', note: '' }] } as Partial<Task>

describe('a flat task', () => {
  it('shows the stage panel the waiting reason points at, with no needs row and a "Dispatched" state', () => {
    const t = task({ status: 'waiting', waitingReason: 'PR open, ready for CR' })
    expect(resolvePanelTarget(t, nav(), [t])).toEqual({ kind: 'stage', tab: 'cr', child: t, extra: { needs: null, stateLabel: 'Dispatched' } })
  })

  it('an explicit tab wins', () => {
    const t = task()
    expect(resolvePanelTarget(t, nav({ l2Tab: 'qa' }), [t])).toMatchObject({ kind: 'stage', tab: 'qa' })
  })

  it('the two plan stages route to the plan tab', () => {
    const t = task()
    expect(resolvePanelTarget(t, nav({ l2Tab: 'planning' }), [t])).toEqual({ kind: 'plan', task: t, stage: 'planning' })
    expect(resolvePanelTarget(t, nav({ l2Tab: 'plan-review' }), [t])).toEqual({ kind: 'plan', task: t, stage: 'plan-review' })
  })

  it('reads "Not started" while still in planning or plan review, and "Merged" once done', () => {
    const planning = task({ stage: 'planning' })
    const done = task({ status: 'done', stage: null })
    expect(resolvePanelTarget(planning, nav({ l2Tab: 'dev' }), [planning])).toMatchObject({ extra: { stateLabel: 'Not started' } })
    expect(resolvePanelTarget(done, nav({ l2Tab: 'dev' }), [done])).toMatchObject({ extra: { stateLabel: 'Merged' } })
  })
})

describe('a dispatched milestone child opened on its own', () => {
  const parent = task({ slug: 'p', milestones: [milestone('M1', { needs: ['M0'], state: 'dispatched' })] })
  const child = task({ slug: 'p-m1', projectTitle: 'P', projectBase: 'p' })
  parent.milestones![0].task = child

  it('takes its needs and state from its own declaration in the parent', () => {
    expect(resolvePanelTarget(child, nav(), [parent, child])).toEqual({ kind: 'stage', tab: 'dev', child, extra: { needs: ['M0'], stateLabel: 'Dispatched' } })
  })

  it('says it is still loading while the parent (or its declaration) has not arrived', () => {
    expect(resolvePanelTarget(child, nav(), [child])).toEqual({ kind: 'loading-milestone' })
  })

  it('never routes to a plan tab — its plan lives on the parent', () => {
    expect(resolvePanelTarget(child, nav({ l2Tab: 'planning' }), [parent, child])).toMatchObject({ kind: 'stage', tab: 'dev' })
  })
})

describe('a fan-out parent', () => {
  const m0 = milestone('M0', { state: 'done', task: task({ slug: 'p-m0' }) })
  const m1 = milestone('M1', { needs: ['M0'] })
  const parent = task({ slug: 'p', milestones: [m0, m1], ...PLAN_REVIEWED })

  it('Plan and Plan Review show the plan tab', () => {
    expect(resolvePanelTarget(parent, nav({ l1Tab: 'plan' }), [parent])).toEqual({ kind: 'plan', task: parent, stage: 'planning' })
    expect(resolvePanelTarget(parent, nav({ l1Tab: 'plan-review' }), [parent])).toEqual({ kind: 'plan', task: parent, stage: 'plan-review' })
  })

  it('Dev with nothing drilled into has no panel — the graph slot owns the milestone list', () => {
    expect(resolvePanelTarget(parent, nav(), [parent])).toEqual({ kind: 'none' })
  })

  it('a milestone the plan no longer declares has no panel either, rather than a blank one', () => {
    expect(resolvePanelTarget(parent, nav({ milestoneId: 'M9' }), [parent])).toEqual({ kind: 'none' })
  })

  it('a dispatched milestone drills into its child\'s own stage panel', () => {
    expect(resolvePanelTarget(parent, nav({ milestoneId: 'M0' }), [parent])).toEqual({
      kind: 'stage', tab: 'dev', child: m0.task, extra: { needs: [], stateLabel: 'Merged', readyForDev: false, milestoneSlug: 'p-m0' },
    })
  })

  it('an undispatched milestone is a stage panel with no child, ready for dev once its needs are done and the plan is reviewed', () => {
    expect(resolvePanelTarget(parent, nav({ milestoneId: 'M1' }), [parent])).toEqual({
      kind: 'stage', tab: 'dev', child: null, extra: { needs: ['M0'], stateLabel: 'Queued', readyForDev: true, milestoneSlug: 'p-m1' },
    })
  })

  it('an undispatched milestone is not ready before the plan has been reviewed', () => {
    const unreviewed = task({ slug: 'p', milestones: [m0, m1], stageHistory: [] })
    expect(resolvePanelTarget(unreviewed, nav({ milestoneId: 'M1' }), [unreviewed])).toMatchObject({ extra: { readyForDev: false } })
  })

  it('derives the child slug from the milestone number, not its name', () => {
    const p = task({ slug: 'big', milestones: [milestone('M12', { name: 'Twelve' })], ...PLAN_REVIEWED })
    expect(resolvePanelTarget(p, nav({ milestoneId: 'M12' }), [p])).toMatchObject({ extra: { milestoneSlug: 'big-m12' } })
  })

  it('a plan tab selected while drilled in falls back to a real stage tab', () => {
    expect(resolvePanelTarget(parent, nav({ milestoneId: 'M1', l2Tab: 'planning' }), [parent])).toMatchObject({ kind: 'stage', tab: 'dev' })
  })
})
