import { describe, expect, it } from 'vitest'
import { STAGES } from '../../src/taskParser'
import type { Task } from '../../src/types'
import { FLAT_CHAIN_STAGES, MILESTONE_CHAIN_STAGES, STAGE_CHAIN_GROUPS, STAGE_TO_CHAIN_ID, chainStagesFor, defaultStageTab, initialL1Tab, isChainStageId, isL1TabId, isStagePanelTabId, resolveSelectedStageTab, resolveStageTab } from './pipelineStages'

const stubTask = (overrides: Partial<Task>): Task => overrides as Task
const waiting = (waitingReason: string, stage: Task['stage'] = null): Task => stubTask({ status: 'waiting', waitingReason, stage })

describe('chain stage tables', () => {
  it('a flat task chain is planning + plan-review in front of the six shared milestone stages', () => {
    expect(FLAT_CHAIN_STAGES.map((s) => s.id)).toEqual(['planning', 'plan-review', 'dev', 'cr', 'cr-fixes', 'qa', 'qa-fixes', 'merge'])
    expect(FLAT_CHAIN_STAGES.slice(2)).toEqual(MILESTONE_CHAIN_STAGES)
  })

  // The chain and the server's own stage graph are two declarations of the
  // same pipeline; an edit to only one would desync what the server computes
  // from what the dashboard draws.
  it("the flat chain's stage order matches the server's STAGES exactly", () => {
    expect(FLAT_CHAIN_STAGES.map((s) => s.stage)).toEqual(STAGES)
  })

  it('maps the two stages whose chain id differs from the Stage value', () => {
    expect(STAGE_TO_CHAIN_ID['code-review']).toBe('cr')
    expect(STAGE_TO_CHAIN_ID['comment-fix']).toBe('cr-fixes')
    expect(STAGE_TO_CHAIN_ID.qa).toBe('qa')
  })
})

describe('isChainStageId', () => {
  it('accepts every chain id and rejects anything else', () => {
    expect(isChainStageId('cr-fixes')).toBe(true)
    expect(isChainStageId('planning')).toBe(true)
    expect(isChainStageId('bogus')).toBe(false)
    expect(isChainStageId('')).toBe(false)
  })
})

describe('defaultStageTab', () => {
  it('prefers the tab of the next actionable stage named by the waiting reason', () => {
    expect(defaultStageTab(waiting('plan ready for review'))).toBe('plan-review')
    expect(defaultStageTab(waiting('PR open, ready for CR'))).toBe('cr')
    expect(defaultStageTab(waiting('triage and dispatch cr-fixes'))).toBe('cr-fixes')
    expect(defaultStageTab(waiting('triage and dispatch qa-fixes'))).toBe('qa-fixes')
  })

  it('does not trust a stale stage over the waiting reason', () => {
    expect(defaultStageTab(waiting('plan reviewed, ready for dev', 'plan-review'))).toBe('dev')
  })

  it('falls back to planning for a task still genuinely in planning with no CTA', () => {
    expect(defaultStageTab(stubTask({ status: 'working', waitingReason: undefined, stage: 'planning' }))).toBe('planning')
  })

  it('falls back to dev for anything else, and for an undispatched milestone (no task)', () => {
    expect(defaultStageTab(stubTask({ status: 'working', waitingReason: undefined, stage: 'qa' }))).toBe('dev')
    expect(defaultStageTab(null)).toBe('dev')
  })
})

describe('isL1TabId / isStagePanelTabId', () => {
  it('knows the three L1 tabs', () => {
    expect(['plan', 'plan-review', 'dev'].every(isL1TabId)).toBe(true)
    expect(isL1TabId('qa')).toBe(false)
  })

  it('every chain stage but the two plan stages renders a stage panel', () => {
    expect(FLAT_CHAIN_STAGES.filter((s) => isStagePanelTabId(s.id)).map((s) => s.id)).toEqual(['dev', 'cr', 'cr-fixes', 'qa', 'qa-fixes', 'merge'])
  })
})

describe('resolveStageTab', () => {
  it('honours an explicit tab that belongs to the chain', () => {
    expect(resolveStageTab('qa', FLAT_CHAIN_STAGES, waiting('plan ready for review'))).toBe('qa')
    expect(resolveStageTab('planning', FLAT_CHAIN_STAGES, waiting('PR open, ready for CR'))).toBe('planning')
  })

  it('falls back to the default for nothing clicked yet', () => {
    expect(resolveStageTab(null, FLAT_CHAIN_STAGES, waiting('PR open, ready for CR'))).toBe('cr')
  })

  it('a milestone chain has no plan nodes: a plan tab (say, from a stale URL) falls back to the default instead of rendering the wrong panel', () => {
    expect(resolveStageTab('planning', MILESTONE_CHAIN_STAGES, waiting('PR open, ready for CR'))).toBe('cr')
  })

  it('a milestone child whose default would be a plan stage lands on dev instead', () => {
    expect(resolveStageTab(null, MILESTONE_CHAIN_STAGES, waiting('plan ready for review'))).toBe('dev')
  })
})

describe('STAGE_CHAIN_GROUPS', () => {
  it('folds plan-review into planning and each *-fixes stage into its review stage', () => {
    expect(STAGE_CHAIN_GROUPS).toEqual({ planning: ['plan-review'], cr: ['cr-fixes'], qa: ['qa-fixes'] })
  })
})

describe('chainStagesFor', () => {
  it('returns the eight-stage chain for a flat task and the six-stage chain for a milestone', () => {
    expect(chainStagesFor('flat')).toBe(FLAT_CHAIN_STAGES)
    expect(chainStagesFor('milestone')).toBe(MILESTONE_CHAIN_STAGES)
  })
})

describe('initialL1Tab', () => {
  it('opens a parent already in dev on the Dev tab', () => {
    expect(initialL1Tab(stubTask({ stage: 'dev', status: 'working' }))).toBe('dev')
  })

  it('opens a parent whose plan review just finished on Dev, even while task.stage still lags on plan-review', () => {
    expect(initialL1Tab(waiting('plan reviewed, ready for dev', 'plan-review'))).toBe('dev')
  })

  it('opens a parent still planning on the Plan tab', () => {
    expect(initialL1Tab(stubTask({ stage: 'planning', status: 'working' }))).toBe('plan')
  })

  it('opens a parent with no stage at all on the Plan tab', () => {
    expect(initialL1Tab(stubTask({ stage: null, status: 'paused' }))).toBe('plan')
  })
})

describe('resolveSelectedStageTab', () => {
  const dev = stubTask({ stage: 'dev', status: 'working' })

  it('highlights nothing for an undispatched milestone or a task with no stage', () => {
    expect(resolveSelectedStageTab(null, MILESTONE_CHAIN_STAGES, null)).toBeNull()
    expect(resolveSelectedStageTab(stubTask({ stage: null, status: 'done' }), FLAT_CHAIN_STAGES, null)).toBeNull()
  })

  it('honours an explicit selection that belongs to the chain', () => {
    expect(resolveSelectedStageTab(dev, MILESTONE_CHAIN_STAGES, 'qa')).toBe('qa')
  })

  it("ignores a selection the chain does not have (a plan tab on a milestone's six-stage chain)", () => {
    expect(resolveSelectedStageTab(dev, MILESTONE_CHAIN_STAGES, 'planning')).toBe('dev')
  })

  it('falls back to the default tab when nothing is selected', () => {
    expect(resolveSelectedStageTab(waiting('PR open, ready for CR', 'dev'), FLAT_CHAIN_STAGES, null)).toBe('cr')
  })
})
