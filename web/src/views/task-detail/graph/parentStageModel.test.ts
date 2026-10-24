import { describe, expect, test } from 'vitest'
import type { MilestoneStatus, Stage, StageEvent } from '../../../../../src/types'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { isParentStageSelected, parentStageChainModel, parentStageNodes } from './parentStageModel'

// dashboard-v4-inner-view M1. A fan-out parent's five chart nodes, which the
// parent never runs itself past planning: Dev, Code review, QA and Merge
// summarise its milestones (QUESTIONS.md #6). The parent is "current" at the
// earliest stage any unfinished milestone is in; stages every milestone has
// passed are done; the rest are not started.

const PLANNED: StageEvent[] = [
  { stage: 'planning', at: '2026-08-10T09:00:00Z', note: 'done' },
  { stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: 'looks good' },
]

function child(id: string, wave: number, stage: Stage | null, isDone = false): MilestoneStatus {
  return makeMilestone({
    id,
    wave,
    state: isDone ? 'done' : 'dispatched',
    task: makeTask({ slug: `p-${id.toLowerCase()}`, stage, status: isDone ? 'done' : 'working' }),
  })
}

function parent(milestones: MilestoneStatus[], overrides: Parameters<typeof makeTask>[0] = {}) {
  return makeTask({ slug: 'p', stage: 'dev', status: 'waiting', stageHistory: PLANNED, milestones, ...overrides })
}

const stateOf = (nodes: ReturnType<typeof parentStageNodes>) => Object.fromEntries(nodes.map((node) => [node.id, node.state]))
const subOf = (nodes: ReturnType<typeof parentStageNodes>, id: string) => nodes.find((node) => node.id === id)?.sub

describe('parentStageNodes', () => {
  test('always the five stages, in order', () => {
    expect(parentStageNodes(parent([])).map((node) => node.id)).toEqual(['planning', 'dev', 'cr', 'qa', 'merge'])
  })

  test('a parent still planning is current at Planning, with nothing else started', () => {
    const nodes = parentStageNodes(parent([makeMilestone({ id: 'M0' })], { stage: 'planning', stageHistory: [] }))
    expect(stateOf(nodes)).toEqual({ planning: 'current', dev: 'todo', cr: 'todo', qa: 'todo', merge: 'todo' })
  })

  test('a reviewed plan with milestones queued or in dev is current at Dev', () => {
    const nodes = parentStageNodes(parent([child('M0', 1, null, true), child('M1', 2, 'code-review'), makeMilestone({ id: 'M2', wave: 2 })]))
    expect(stateOf(nodes)).toEqual({ planning: 'done', dev: 'current', cr: 'todo', qa: 'todo', merge: 'todo' })
    expect(subOf(nodes, 'dev')).toBe('wave 2 of 2')
    expect(subOf(nodes, 'cr')).toBe('1 in review')
    expect(subOf(nodes, 'merge')).toBe('1 of 3 merged')
  })

  test('once every unfinished milestone is past dev, the earliest of them is current', () => {
    const nodes = parentStageNodes(parent([child('M0', 1, null, true), child('M1', 2, 'qa'), child('M2', 2, 'merge')]))
    expect(stateOf(nodes)).toEqual({ planning: 'done', dev: 'done', cr: 'done', qa: 'current', merge: 'todo' })
    expect(subOf(nodes, 'qa')).toBe('1 in QA')
  })

  test('a parent whose milestones are all merged has every stage done and none current', () => {
    const nodes = parentStageNodes(parent([child('M0', 1, null, true), child('M1', 2, null, true)], { status: 'done', stage: null }))
    expect(stateOf(nodes)).toEqual({ planning: 'done', dev: 'done', cr: 'done', qa: 'done', merge: 'done' })
    expect(subOf(nodes, 'dev')).toBe('all merged')
    expect(subOf(nodes, 'merge')).toBe('2 of 2 merged')
  })

  test('a parent with no milestones declared yet stays at Planning rather than claiming Dev', () => {
    const nodes = parentStageNodes(parent([], { stage: 'plan-review' }))
    expect(stateOf(nodes).planning).toBe('current')
    expect(stateOf(nodes).dev).toBe('todo')
  })
})

describe('parentStageChainModel', () => {
  const milestones = [child('M0', 1, null, true), child('M1', 2, 'code-review')]

  test('selecting Plan Review selects the Planning node and routes its click to Plan Review', () => {
    const model = parentStageChainModel(parent(milestones), 'plan-review')
    expect(model.nodes.filter((node) => node.isSelected).map((node) => node.id)).toEqual(['planning'])
    expect(model.nodes[0].tabId).toBe('plan-review')
    expect(model.selectedIndex).toBe(0)
  })

  test('an edge is reached when the stage it enters is done or current', () => {
    const model = parentStageChainModel(parent(milestones), 'dev')
    expect(model.edges.map((edge) => [edge.targetId, edge.isReached])).toEqual([['dev', true], ['cr', true], ['qa', false], ['merge', false]])
  })

  test('the selected note names the stage and its summary line', () => {
    expect(parentStageChainModel(parent(milestones), 'cr').selectedNote).toBe('CR: 1 in review')
  })

  test('a selection outside the chart (a stale stage) falls back to the first node instead of throwing', () => {
    const model = parentStageChainModel(parent(milestones), 'cr-fixes')
    expect(model.nodes.filter((node) => node.isSelected).map((node) => node.id)).toEqual(['cr'])
    expect(parentStageChainModel(parent(milestones), 'design-qa').selectedIndex).toBe(0)
  })
})

describe('isParentStageSelected', () => {
  test('a node is selected by its own id or by a stage folded into it', () => {
    const [planning, dev] = parentStageNodes(parent([]))
    expect(isParentStageSelected(planning, 'plan-review')).toBe(true)
    expect(isParentStageSelected(planning, 'dev')).toBe(false)
    expect(isParentStageSelected(dev, 'dev')).toBe(true)
  })
})
