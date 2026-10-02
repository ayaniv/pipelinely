import { describe, expect, test } from 'vitest'
import type { StageEvent } from '../../../../../src/types'
import { FLAT_CHAIN_STAGES, MILESTONE_CHAIN_STAGES, STAGE_CHAIN_GROUPS, type ChainStageId } from '../../../pipelineStages'
import { makeTask } from '../../../testing/makeTask'
import { buildStageChainModel } from './stageChainModel'

const MILESTONE_STAGES = MILESTONE_CHAIN_STAGES
const FLAT_STAGES = FLAT_CHAIN_STAGES
const formatWhen = (iso: string) => `at ${iso}`

const event = (stageValue: string, note: string | null = null): StageEvent => ({ stage: stageValue as StageEvent['stage'], at: `2026-01-01T00:00:00Z`, note })

function build(child: ReturnType<typeof makeTask> | null, resolvedTab: ChainStageId | null, stages = FLAT_STAGES) {
  return buildStageChainModel({ child, stages, groups: STAGE_CHAIN_GROUPS, resolvedTab, formatWhen })
}

describe('buildStageChainModel: nodes', () => {
  test('folds grouped stages into their parent node, leaving one node per visible stage', () => {
    const model = build(makeTask(), 'dev')
    expect(model.nodes.map((n) => n.id)).toEqual(['planning', 'dev', 'cr', 'qa', 'merge'])
  })

  test('a milestone chain has no folded stages except its own groups', () => {
    const model = build(makeTask(), 'dev', MILESTONE_STAGES)
    expect(model.nodes.map((n) => n.id)).toEqual(['dev', 'cr', 'qa', 'merge'])
  })

  test('the resolved tab is the one current, selected node; earlier recorded stages are done, the rest pending', () => {
    const task = makeTask({ stageHistory: [event('planning'), event('plan-review'), event('dev')] })
    const model = build(task, 'dev')

    const stateByNode = Object.fromEntries(model.nodes.map((n) => [n.id, n.stateClass]))
    expect(stateByNode).toEqual({
      planning: 'is-done',
      dev: 'is-current is-selected',
      cr: 'is-pending',
      qa: 'is-pending',
      merge: 'is-pending',
    })
    expect(model.selectedIndex).toBe(1)
  })

  test('done is only ever a recorded stage, never inferred from position', () => {
    const model = build(makeTask({ stageHistory: [] }), 'qa')
    expect(model.nodes.filter((n) => n.isDone)).toEqual([])
  })

  test('a grouped node is current when its folded child is the resolved tab, and routes clicks to that child', () => {
    const task = makeTask({ stageHistory: [event('planning'), event('plan-review')] })
    const model = build(task, 'plan-review')

    const planning = model.nodes[0]
    expect(planning.isCurrent).toBe(true)
    expect(planning.tabId).toBe('plan-review')
  })

  test('a grouped node not currently selected routes to its furthest-reached member', () => {
    const task = makeTask({ stageHistory: [event('planning'), event('plan-review')] })
    const model = build(task, 'dev')

    expect(model.nodes[0].isDone).toBe(true)
    expect(model.nodes[0].tabId).toBe('plan-review')
  })

  test('an ungrouped node routes clicks to its own id', () => {
    const model = build(makeTask(), 'dev')
    expect(model.nodes.find((n) => n.id === 'merge')?.tabId).toBe('merge')
  })

  test('on a finished task every un-recorded stage is "unrecorded", never pending or done', () => {
    const task = makeTask({ status: 'done', stage: null, stageHistory: [event('dev')] })
    const model = build(task, null)

    expect(model.nodes.find((n) => n.id === 'dev')?.stateClass).toBe('is-done')
    expect(model.nodes.find((n) => n.id === 'qa')?.stateClass).toBe('is-unrecorded')
    expect(model.nodes.some((n) => n.isCurrent)).toBe(false)
  })

  test('an undispatched milestone (no child) renders every node pending with nothing current', () => {
    const model = build(null, null, MILESTONE_STAGES)

    expect(model.nodes.every((n) => n.stateClass === 'is-pending')).toBe(true)
    expect(model.selectedIndex).toBe(0)
  })

  test('a node note is the recorded outcome, "done" when the note is blank, "current" or "—" otherwise', () => {
    const task = makeTask({ stageHistory: [event('planning', 'looks good'), event('dev', null)] })
    const model = build(task, 'cr')

    expect(model.nodes.find((n) => n.id === 'planning')?.note).toBe('looks good')
    expect(model.nodes.find((n) => n.id === 'dev')?.note).toBe('done')
    expect(model.nodes.find((n) => n.id === 'cr')?.note).toBe('current')
    expect(model.nodes.find((n) => n.id === 'merge')?.note).toBe('—')
  })

  test('the state word is current, done or a dash', () => {
    const task = makeTask({ stageHistory: [event('planning'), event('dev')] })
    const words = Object.fromEntries(build(task, 'cr').nodes.map((n) => [n.id, n.stateWord]))
    expect(words).toEqual({ planning: 'done', dev: 'done', cr: 'current', qa: '—', merge: '—' })
  })

  test('the newest entry for a repeated stage wins', () => {
    const task = makeTask({ stageHistory: [
      { stage: 'dev', at: '2026-01-01T00:00:00Z', note: 'first' },
      { stage: 'dev', at: '2026-01-02T00:00:00Z', note: 'second' },
    ] })
    expect(build(task, 'cr').nodes.find((n) => n.id === 'dev')?.note).toBe('second')
  })

  test('a node exposes the formatted time of its recorded stage, null when none', () => {
    const task = makeTask({ stageHistory: [event('dev')] })
    const model = build(task, 'cr')

    expect(model.nodes.find((n) => n.id === 'dev')?.when).toBe('at 2026-01-01T00:00:00Z')
    expect(model.nodes.find((n) => n.id === 'merge')?.when).toBeNull()
  })
})

describe('buildStageChainModel: edges', () => {
  test('an edge is traversed when the node it leaves is done or current', () => {
    const task = makeTask({ stageHistory: [event('planning'), event('dev')] })
    const model = build(task, 'dev')

    expect(model.edges).toEqual([
      { sourceId: 'planning', targetId: 'dev', isTraversed: true },
      { sourceId: 'dev', targetId: 'cr', isTraversed: true },
      { sourceId: 'cr', targetId: 'qa', isTraversed: false },
      { sourceId: 'qa', targetId: 'merge', isTraversed: false },
    ])
  })

  test('a single-node chain has no edges', () => {
    const model = build(makeTask(), 'dev', [MILESTONE_STAGES[0]])
    expect(model.edges).toEqual([])
  })
})

describe('buildStageChainModel: notes', () => {
  test('a dispatched task with no TIMELINE entries names the gap, including its inferred current stage', () => {
    const model = build(makeTask({ stageHistory: [] }), 'dev')
    expect(model.noDataNote).toEqual({ kind: 'inferred-current', currentLabel: 'Dev' })
  })

  test('a finished task with no TIMELINE says it finished with none written', () => {
    const model = build(makeTask({ status: 'done', stage: null, stageHistory: [] }), null)
    expect(model.noDataNote).toEqual({ kind: 'finished-unrecorded' })
  })

  test('an active task whose stage cannot be placed says so', () => {
    const model = build(makeTask({ stageHistory: [] }), null)
    expect(model.noDataNote).toEqual({ kind: 'unplaced' })
  })

  test('no note at all once anything is recorded, or when there is no child to describe', () => {
    expect(build(makeTask({ stageHistory: [event('dev')] }), 'dev').noDataNote).toBeNull()
    expect(build(null, null).noDataNote).toBeNull()
  })

  test('the selected-stage note reads "<label>: <note> · <when>", omitting the time when nothing is recorded', () => {
    const recorded = build(makeTask({ stageHistory: [event('dev', 'PR #1 open')] }), 'dev')
    expect(recorded.selectedNote).toBe('Dev: PR #1 open · at 2026-01-01T00:00:00Z')

    const empty = build(makeTask({ stageHistory: [] }), 'dev')
    expect(empty.selectedNote).toBe('Dev: current')
  })
})

describe('buildStageChainModel: empty stage list', () => {
  test('degrades to an empty model instead of throwing', () => {
    const model = build(makeTask(), 'dev', [])
    expect(model).toEqual({ nodes: [], edges: [], selectedIndex: 0, noDataNote: null, selectedNote: '' })
  })

  test('a chain whose every stage is folded away is empty too', () => {
    const model = buildStageChainModel({
      child: makeTask(),
      stages: [MILESTONE_STAGES[0]],
      groups: { dev: ['dev'] },
      resolvedTab: null,
      formatWhen,
    })
    expect(model.nodes).toEqual([])
  })
})
