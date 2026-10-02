import { describe, expect, it } from 'vitest'
import type { Task } from '../../../../../src/types'
import { formatWhen } from '../../../format'
import { panelHeaderPill, stageNote } from './panelHeader'

const NOT_STARTED = { label: 'not started', bg: 'var(--surface2)', fg: 'var(--text2)' }
const SAGE = { bg: 'var(--sageSoft)', fg: 'var(--sageInk)' }
const AMBER = { bg: 'var(--amberSoft)', fg: 'var(--amberInk)' }
const ACCENT = { bg: 'var(--accentSoft)', fg: 'var(--accentInk)' }

function task(overrides: Partial<Task> = {}): Task {
  return { slug: 't', status: 'working', stage: null, stageHistory: [], findings: [], qaFailures: [], qaCases: [], ...overrides } as unknown as Task
}
const event = (stage: string, note = '', at = '2026-08-10T10:00:00Z') => ({ stage, at, note }) as Task['stageHistory'][number]

describe('stageNote', () => {
  it('is empty when the stage never recorded anything, or there is no task', () => {
    expect(stageNote(null, 'dev')).toBe('')
    expect(stageNote(task(), 'dev')).toBe('')
  })

  it('joins the recorded note and its time', () => {
    const child = task({ stageHistory: [event('plan-review', 'round 1: looks good')] })
    expect(stageNote(child, 'plan-review')).toBe(`round 1: looks good · ${formatWhen('2026-08-10T10:00:00Z')}`)
  })

  it('says "recorded" for an entry with no note, and reads the FIRST entry for the stage', () => {
    const child = task({ stageHistory: [event('dev', '', '2026-08-10T10:00:00Z'), event('dev', 'later', '2026-08-11T10:00:00Z')] })
    expect(stageNote(child, 'dev')).toBe(`recorded · ${formatWhen('2026-08-10T10:00:00Z')}`)
  })
})

describe('panelHeaderPill', () => {
  it('is "not started" for an undispatched milestone (no task) on every stage', () => {
    expect(panelHeaderPill(null, 'qa')).toEqual(NOT_STARTED)
    expect(panelHeaderPill(null, 'dev')).toEqual(NOT_STARTED)
  })

  it('planning and plan-review read their round count once reached', () => {
    const child = task({ stageHistory: [event('planning'), event('plan-review'), event('plan-review')] })
    expect(panelHeaderPill(child, 'planning')).toEqual({ label: 'round 1', ...SAGE })
    expect(panelHeaderPill(child, 'plan-review')).toEqual({ label: 'round 2', ...SAGE })
    expect(panelHeaderPill(task(), 'planning')).toEqual(NOT_STARTED)
  })

  describe('dev', () => {
    it('is done for a finished task, not started with no TIMELINE entry', () => {
      expect(panelHeaderPill(task({ status: 'done' }), 'dev')).toEqual({ label: 'done', ...SAGE })
      expect(panelHeaderPill(task(), 'dev')).toEqual(NOT_STARTED)
    })

    it('is in progress only while the task is still sitting on dev, otherwise done', () => {
      const reached = [event('dev')]
      expect(panelHeaderPill(task({ stage: 'dev', stageHistory: reached }), 'dev')).toEqual({ label: 'in progress', ...ACCENT })
      expect(panelHeaderPill(task({ stage: 'qa', stageHistory: reached }), 'dev')).toEqual({ label: 'done', ...SAGE })
    })
  })

  describe('cr', () => {
    const reached = [event('code-review')]
    it('is not started until code review is recorded', () => {
      expect(panelHeaderPill(task(), 'cr')).toEqual(NOT_STARTED)
    })
    it('counts findings, singular and plural, or reports none', () => {
      const one = { severity: 'must' } as Task['findings'][number]
      expect(panelHeaderPill(task({ stageHistory: reached, findings: [one] }), 'cr')).toEqual({ label: '1 finding', ...AMBER })
      expect(panelHeaderPill(task({ stageHistory: reached, findings: [one, one] }), 'cr')).toEqual({ label: '2 findings', ...AMBER })
      expect(panelHeaderPill(task({ stageHistory: reached }), 'cr')).toEqual({ label: 'no findings', ...SAGE })
    })
  })

  it('cr-fixes and qa-fixes read how many of their items are selected', () => {
    const findings = [{ selected: true }, { selected: false }] as Task['findings']
    const qaFailures = [{ selected: true }, { selected: true }] as Task['qaFailures']
    expect(panelHeaderPill(task({ findings }), 'cr-fixes')).toEqual({ label: '1 selected', ...AMBER })
    expect(panelHeaderPill(task({ findings: [] }), 'cr-fixes')).toEqual({ label: 'nothing selected', bg: 'var(--surface2)', fg: 'var(--text2)' })
    expect(panelHeaderPill(task({ qaFailures }), 'qa-fixes')).toEqual({ label: '2 selected', ...AMBER })
  })

  describe('qa', () => {
    it('reads passed of total, sage when all pass and amber otherwise', () => {
      const cases = (passed: boolean[]) => passed.map((p) => ({ passed: p })) as Task['qaCases']
      expect(panelHeaderPill(task({ qaCases: cases([true, true]) }), 'qa')).toEqual({ label: '2 of 2 passing', ...SAGE })
      expect(panelHeaderPill(task({ qaCases: cases([true, false, true]) }), 'qa')).toEqual({ label: '2 of 3 passing', ...AMBER })
    })
    it('with no cases: "no cases recorded" once QA ran, not started before', () => {
      expect(panelHeaderPill(task({ stageHistory: [event('qa')] }), 'qa')).toEqual({ label: 'no cases recorded', bg: 'var(--surface2)', fg: 'var(--text2)' })
      expect(panelHeaderPill(task(), 'qa')).toEqual(NOT_STARTED)
    })
  })

  describe('merge', () => {
    it('is done for a finished task', () => {
      expect(panelHeaderPill(task({ status: 'done' }), 'merge')).toEqual({ label: 'done', ...SAGE })
    })
    it('names the PR when one resolves, otherwise not started', () => {
      expect(panelHeaderPill(task({ prNumber: '904' }), 'merge')).toEqual({ label: 'ready · PR #904', ...ACCENT })
      expect(panelHeaderPill(task(), 'merge')).toEqual(NOT_STARTED)
    })
  })
})
