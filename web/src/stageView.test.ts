import { describe, expect, test } from 'vitest'
import { STAGE_TONE_VARS, cardCtaPair, cardStageView, splitSummary, stagePillView } from './stageView'
import type { Stage } from '../../src/types'
import { makeTask } from './views/board/testTask'

describe('splitSummary', () => {
  test('splits at the first ". " keeping the period on the head', () => {
    expect(splitSummary('Plan reviewed. Two milestones, both ready.')).toEqual({ head: 'Plan reviewed.', rest: 'Two milestones, both ready.' })
  })

  test('splits only at the first sentence break', () => {
    expect(splitSummary('One. Two. Three.')).toEqual({ head: 'One.', rest: 'Two. Three.' })
  })

  test('a single sentence has an empty rest', () => {
    expect(splitSummary('plan reviewed, ready for dev')).toEqual({ head: 'plan reviewed, ready for dev', rest: '' })
  })

  test('a period not followed by a space is not a break', () => {
    expect(splitSummary('Ship v1.2 today')).toEqual({ head: 'Ship v1.2 today', rest: '' })
  })

  test('blank or missing text has no summary', () => {
    expect(splitSummary('')).toBeNull()
    expect(splitSummary('   ')).toBeNull()
    expect(splitSummary(undefined)).toBeNull()
  })
})

describe('cardStageView with a stage this build does not know', () => {
  // The wire is JSON: a stage a newer server adds must not take the whole board down.
  test('falls back to the planning tone instead of throwing', () => {
    const view = cardStageView(makeTask({ stage: 'brand-new-stage' as never }))
    expect(view.stageKey).toBe('planning')
    expect(view.tone).toBe('plan')
  })
})

describe('cardStageView', () => {
  test('tone folds the eight stages onto the five palette tones', () => {
    const toneAt = (stage: Stage) => cardStageView(makeTask({ stage })).tone
    expect(toneAt('planning')).toBe('plan')
    expect(toneAt('plan-review')).toBe('plan')
    expect(toneAt('dev')).toBe('dev')
    expect(toneAt('code-review')).toBe('cr')
    expect(toneAt('comment-fix')).toBe('cr')
    expect(toneAt('qa')).toBe('qa')
    expect(toneAt('qa-fixes')).toBe('qa')
    expect(toneAt('merge')).toBe('merge')
  })

  test('stageKey keeps the fixes stages distinct from their parents', () => {
    const keyAt = (stage: Stage) => cardStageView(makeTask({ stage })).stageKey
    expect(keyAt('plan-review')).toBe('planning')
    expect(keyAt('code-review')).toBe('cr')
    expect(keyAt('comment-fix')).toBe('crfix')
    expect(keyAt('qa')).toBe('qa')
    expect(keyAt('qa-fixes')).toBe('qareview')
  })

  test('a waiting reason that names the next stage wins over the lagging task.stage', () => {
    const view = cardStageView(makeTask({ status: 'waiting', stage: 'plan-review', waitingReason: 'plan reviewed, ready for dev' }))
    expect(view.stage).toBe('dev')
    expect(view.tone).toBe('dev')
    expect(view.stageKey).toBe('dev')
  })

  test('a CR-fixes handoff reads as crfix on the cr tone', () => {
    const view = cardStageView(makeTask({ status: 'waiting', stage: 'code-review', waitingReason: 'CR found 1 must-fix comments, triage and dispatch cr-fixes' }))
    expect(view.stageKey).toBe('crfix')
    expect(view.tone).toBe('cr')
  })

  test('a merge-ready task is at merge even though its stage still says qa', () => {
    const view = cardStageView(makeTask({ status: 'waiting', stage: 'qa', waitingReason: 'QA passed, ready to merge', prNumber: '42' }))
    expect(view.stageKey).toBe('merge')
    expect(view.tone).toBe('merge')
  })

  test('a working task with no waiting reason keeps its own stage', () => {
    expect(cardStageView(makeTask({ status: 'working', stage: 'qa' })).stageKey).toBe('qa')
  })

  test('a done task has no stage and falls back to the merge tone', () => {
    const view = cardStageView(makeTask({ status: 'done', stage: null }))
    expect(view.stage).toBeNull()
    expect(view.tone).toBe('merge')
    expect(view.attention).toBe('done')
  })

  test('a task with no stage at all falls back to planning rather than throwing', () => {
    const view = cardStageView(makeTask({ status: 'working', stage: null }))
    expect(view.tone).toBe('plan')
    expect(view.stageKey).toBe('planning')
  })

  test.each([
    ['needs-you attention', { status: 'waiting', attentionStatus: 'needs-you' }, 'needs-you'],
    ['an orphaned task', { status: 'working', attentionStatus: 'working', orphaned: true }, 'needs-you'],
    ['a working task', { status: 'working', attentionStatus: 'working' }, 'working'],
    ['a paused task', { status: 'paused', attentionStatus: 'paused' }, 'working'],
    ['a done task', { status: 'done' }, 'done'],
    ['a shelved task', { status: 'shelved' }, 'backlog'],
  ] as const)('attention for %s', (_label, overrides, expected) => {
    expect(cardStageView(makeTask(overrides)).attention).toBe(expected)
  })

  test('the summary is the waiting reason, falling back to the paused reason', () => {
    expect(cardStageView(makeTask({ status: 'waiting', waitingReason: 'Plan reviewed. Ready.' })).summary).toEqual({ head: 'Plan reviewed.', rest: 'Ready.' })
    expect(cardStageView(makeTask({ status: 'paused', pausedReason: 'parked pending the API contract' })).summary).toEqual({ head: 'parked pending the API contract', rest: '' })
    expect(cardStageView(makeTask({ status: 'working' })).summary).toBeNull()
  })

  test.each([
    ['merge', { status: 'waiting', stage: 'qa', waitingReason: 'QA passed, ready to merge', prNumber: '42' }, 'check'],
    ['crfix', { status: 'waiting', stage: 'code-review', waitingReason: 'CR found 1 must-fix comments, triage and dispatch cr-fixes' }, 'comment'],
    ['qareview', { status: 'waiting', stage: 'qa', waitingReason: 'QA found 2 issues, triage and dispatch qa-fixes' }, 'comment'],
    ['dev', { status: 'waiting', stage: 'dev', waitingReason: 'plan reviewed, ready for dev' }, 'dot'],
  ] as const)('summary icon for %s', (_key, overrides, expected) => {
    expect(cardStageView(makeTask(overrides)).summaryIcon).toBe(expected)
  })
})

describe('STAGE_TONE_VARS', () => {
  test('maps every tone to its three tokens, and is the only place that names them', () => {
    for (const tone of ['plan', 'dev', 'cr', 'qa', 'merge'] as const) {
      expect(STAGE_TONE_VARS[tone]).toEqual({ c: `var(--${tone}C)`, soft: `var(--${tone}Soft)`, ink: `var(--${tone}Ink)` })
    }
  })
})

describe('cardCtaPair for a working leaf', () => {
  test('is null: its session is running, so a Start or Run CTA would dispatch a second one', () => {
    expect(cardCtaPair(makeTask({ status: 'working', attentionStatus: 'needs-you' }))).toBeNull()
  })
})

describe('cardCtaPair', () => {
  const waiting = (waitingReason: string, extra: Partial<Parameters<typeof makeTask>[0]> = {}) =>
    makeTask({ status: 'waiting', attentionStatus: 'needs-you', waitingReason, ...extra })

  test('dev: Start dev plus Read plan on the plan tab', () => {
    expect(cardCtaPair(waiting('plan reviewed, ready for dev'))).toEqual({
      primary: { kind: 'stage-skill', stage: 'dev' },
      secondary: { kind: 'read-plan', taskStage: 'planning' },
    })
  })

  test('CR fixes with a selection: the run CTA plus Triage comments on the cr-fixes tab', () => {
    const task = waiting('CR found 1 must-fix comments, triage and dispatch cr-fixes', { findings: [{ selected: true }] as never })
    expect(cardCtaPair(task)).toEqual({
      primary: { kind: 'stage-skill', stage: 'comment-fix' },
      secondary: { kind: 'triage-comments', taskStage: 'cr-fixes' },
    })
  })

  test('QA fixes: the run CTA plus Triage comments on the qa-fixes tab', () => {
    expect(cardCtaPair(waiting('QA found 2 issues, triage and dispatch qa-fixes'))).toEqual({
      primary: { kind: 'stage-skill', stage: 'qa-fixes' },
      secondary: { kind: 'triage-comments', taskStage: 'qa-fixes' },
    })
  })

  test('CR fixes with nothing selected: a single Triage CR comments, no run button', () => {
    expect(cardCtaPair(waiting('CR found 1 must-fix comments, triage and dispatch cr-fixes', { findings: [{ selected: false }] as never }))).toEqual({
      primary: { kind: 'triage-first' },
      secondary: null,
    })
  })

  test('merge: Merge plus Open PR', () => {
    expect(cardCtaPair(waiting('QA passed, ready to merge', { stage: 'merge', prNumber: '42' }))).toEqual({
      primary: { kind: 'merge' },
      secondary: { kind: 'open-pr' },
    })
  })

  test('other next stages (plan review, code review, qa) get a single run button', () => {
    expect(cardCtaPair(waiting('PR open, ready for CR'))).toEqual({ primary: { kind: 'stage-skill', stage: 'code-review' }, secondary: null })
  })

  test('a research result awaiting review opens the result', () => {
    const task = waiting('audit ready for developer review',{ resultDoc: { path: 'r.md' } as never })
    expect(cardCtaPair(task)?.primary.kind).toBe('open-result')
  })

  test('no next step: a single Show task', () => {
    expect(cardCtaPair(waiting('need product sign-off on the empty state'))).toEqual({ primary: { kind: 'open-detail' }, secondary: null })
  })
})

describe('stagePillView', () => {
  test('a Needs-you task is a stage pill in its stage tone, labelled with the stage the card is at', () => {
    const pill = stagePillView(makeTask({ status: 'waiting', attentionStatus: 'needs-you', stage: 'plan-review', waitingReason: 'plan reviewed, ready for dev' }))
    expect(pill).toMatchObject({ variant: 'stage', tone: 'dev', label: 'Dev', bg: 'var(--devSoft)', dot: 'var(--devC)', ink: 'var(--devInk)', isLive: false })
  })

  test('a Working task stays on the accent and is live', () => {
    const pill = stagePillView(makeTask({ status: 'working', attentionStatus: 'working', stage: 'qa' }))
    expect(pill).toMatchObject({ variant: 'stage', tone: 'qa', label: 'QA', bg: 'var(--accentSoft)', halo: 'var(--accent)', isLive: true })
  })

  test('a done task is a sage "Merged" pill', () => {
    expect(stagePillView(makeTask({ status: 'done', stage: null }))).toMatchObject({ variant: 'merged', label: 'Merged', bg: 'var(--sageSoft)', isLive: false })
  })

  test('a shelved task is a neutral "Backlog" pill', () => {
    expect(stagePillView(makeTask({ status: 'shelved', attentionStatus: 'idle' }))).toMatchObject({ variant: 'backlog', label: 'Backlog', bg: 'var(--surface2)', isLive: false })
  })

  test('a stage-less task falls back to its attention label', () => {
    expect(stagePillView(makeTask({ stage: null, attentionStatus: 'needs-you' })).label).toBe('Needs you')
  })
})

describe('cardCtaPair with a conflicting PR', () => {
  const conflicting = (overrides: Parameters<typeof makeTask>[0] = {}) =>
    makeTask({ status: 'waiting', attentionStatus: 'needs-you', reviewRef: '149', prMergeState: 'conflicting', ...overrides })

  test.each([
    ['fixes pushed, ready to re-run QA', 'qa'],
    ['PR open, ready for CR', 'code-review'],
    ['CR approved, ready for QA', 'qa'],
  ])('waiting: %s offers Fix conflicts instead of the %s stage', (waitingReason) => {
    expect(cardCtaPair(conflicting({ waitingReason }))).toEqual({ primary: { kind: 'stage-skill', stage: 'merge-conflicts' }, secondary: null })
  })

  test('a merge-ready task offers Fix conflicts, not Merge', () => {
    expect(cardCtaPair(conflicting({ stage: 'merge', waitingReason: 'QA passed, ready to merge' }))).toEqual({ primary: { kind: 'stage-skill', stage: 'merge-conflicts' }, secondary: null })
  })

  test.each(['mergeable', 'unknown'] as const)('a %s PR keeps the normal next stage', (prMergeState) => {
    expect(cardCtaPair(conflicting({ waitingReason: 'fixes pushed, ready to re-run QA', prMergeState }))?.primary).toEqual({ kind: 'stage-skill', stage: 'qa' })
    expect(cardCtaPair(conflicting({ stage: 'merge', waitingReason: 'QA passed, ready to merge', prMergeState }))?.primary).toEqual({ kind: 'merge' })
  })

  test('the stage the card reads as being at is the conflict fix, in the merge tone', () => {
    const view = cardStageView(conflicting({ waitingReason: 'fixes pushed, ready to re-run QA' }))
    expect(view.stage).toBe('merge-conflicts')
    expect(view.tone).toBe('merge')
  })
})

describe('cardCtaPair along the ds chain', () => {
  const ds = { kind: 'ds', status: 'waiting', reviewRef: '42' } as const

  test('a passed QA offers design QA, never Merge', () => {
    const pair = cardCtaPair(makeTask({ ...ds, stage: 'design-qa', waitingReason: 'QA passed, ready to merge' }))
    expect(pair?.primary).toEqual({ kind: 'stage-skill', stage: 'design-qa' })
  })

  test('the design-approval gate opens the task instead of staging a skill', () => {
    const pair = cardCtaPair(makeTask({ ...ds, stage: 'design-qa', waitingReason: 'design QA done, ready for design approval' }))
    expect(pair?.primary).toEqual({ kind: 'open-detail' })
  })

  test('requested design changes offer the design-fixes run', () => {
    const pair = cardCtaPair(makeTask({ ...ds, stage: 'design-approval', waitingReason: 'design changes requested, triage and dispatch design-fixes' }))
    expect(pair?.primary).toEqual({ kind: 'stage-skill', stage: 'design-fixes' })
  })

  test('an approved design offers Merge', () => {
    const pair = cardCtaPair(makeTask({ ...ds, stage: 'design-approval', waitingReason: 'design approved, ready to merge' }))
    expect(pair?.primary).toEqual({ kind: 'merge' })
  })

  test('a dev task with the same STATUS as a passed ds QA still offers Merge', () => {
    const pair = cardCtaPair(makeTask({ kind: 'dev', status: 'waiting', reviewRef: '42', stage: 'qa', waitingReason: 'QA passed, ready to merge' }))
    expect(pair?.primary).toEqual({ kind: 'merge' })
  })
})
