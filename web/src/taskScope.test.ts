import { describe, expect, test } from 'vitest'
import type { Task } from '../../src/types'
import {
  isFanoutParent,
  findPrNumber,
  taskScope,
  scopeTotals,
  detailMetaPairs,
  pillStatusFor,
  CARD_STATUS_META,
  detailStatusInfo,
  miniStageNodes,
  cardStageLabel,
  activeTasksOf,
  sumScopeCost,
  scopeCost,
  milestoneScope,
  rollupScope,
  rowLabel,
} from './taskScope'
import { makeMilestone } from './testing/makeTask'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'demo-task',
    title: 'Demo task',
    mode: 'implement',
    repo: 'cockpit-ai',
    branch: 'claude/demo-task',
    worktree: null,
    devUrl: null,
    verifier: null,
    itermSessionId: null,
    tmuxSession: null,
    plan: null,
    stageHistory: [],
    stage: 'dev',
    findings: [],
    findingsParseMismatch: [],
    qaFailures: [],
    qaCases: [],
    qaCasesParseMismatch: [],
    showsOnBoard: true,
    attentionStatus: 'working',
    autoModeOverride: 'inherit',
    autoMode: true,
    status: 'working',
    updatedAt: new Date('2026-01-01'),
    completedAt: null,
    completedAtSource: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessions: [],
    ...overrides,
  } as Task
}

describe('isFanoutParent', () => {
  test('true for a task with at least one declared milestone', () => {
    expect(isFanoutParent(makeTask({ milestones: [{ id: 'M0', name: 'M0', needs: [], estimate: null, specFile: null, wave: 1, task: null, state: 'queued' }] }))).toBe(true)
  })
  test('false for a task with no milestones array', () => {
    expect(isFanoutParent(makeTask())).toBe(false)
  })
  test('false for a task with an empty milestones array', () => {
    expect(isFanoutParent(makeTask({ milestones: [] }))).toBe(false)
  })
})

describe('findPrNumber', () => {
  test('reads a bare number from reviewRef', () => {
    expect(findPrNumber(makeTask({ reviewRef: '42' }))).toBe('42')
  })
  test('reads a PR number from a reviewRef URL', () => {
    expect(findPrNumber(makeTask({ reviewRef: 'https://github.com/org/repo/pull/77' }))).toBe('77')
  })
  test('reads the server-resolved task.prNumber, which already folds in the branch lookup and strict note match', () => {
    expect(findPrNumber(makeTask({ prNumber: '99' }))).toBe('99')
  })
  test('does not re-scan TIMELINE notes itself — a note naming a merged upstream PR must not hijack the card', () => {
    const task = makeTask({
      prNumber: '117',
      stageHistory: [{ stage: 'dev', at: '2026-01-02T00:00:00Z', note: 'merged origin/master (M2, PR #119) into branch' }],
    })
    expect(findPrNumber(task)).toBe('117')
    expect(findPrNumber(makeTask({ stageHistory: task.stageHistory }))).toBeNull()
  })
  test('reviewRef still wins over task.prNumber', () => {
    expect(findPrNumber(makeTask({ reviewRef: '42', prNumber: '99' }))).toBe('42')
  })
  test('null when nothing names a PR', () => {
    expect(findPrNumber(makeTask())).toBeNull()
  })
})

describe('taskScope / scopeTotals / detailMetaPairs', () => {
  test('sums tokens and cost across every session at that session\'s own model rate', () => {
    const task = makeTask({
      model: 'claude-sonnet-5',
      contextPct: 33,
      sessions: [
        { n: 1, contextPct: 20, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: 'dev', sessionId: 's1', startedAt: null, updatedAt: null },
        { n: 2, contextPct: 33, inputTokens: 0, outputTokens: 1_000_000, current: true, stage: 'dev', sessionId: 's2', startedAt: null, updatedAt: null },
      ],
    })
    const scope = taskScope(task)
    expect(scope).toMatchObject({ ctx: 33, ctxLive: true, model: 'claude-sonnet-5' })

    const totals = scopeTotals(scope)
    expect(totals.inp).toBe(1_000_000)
    expect(totals.out).toBe(1_000_000)
    expect(totals.costStr).toBe('$12.00')
  })

  test('detailMetaPairs renders the four labeled mono pairs, formatted', () => {
    const task = makeTask({
      model: 'claude-sonnet-5',
      sessions: [
        { n: 1, contextPct: 10, inputTokens: 2_000_000, outputTokens: 500_000, current: false, stage: 'dev', sessionId: 's1', startedAt: null, updatedAt: null },
      ],
    })
    expect(detailMetaPairs(task)).toEqual([
      ['tok', '2.5M'],
      ['cost', '$9.00'],
      ['sessions', '1'],
      ['model', 'Sonnet'],
    ])
  })

  test('an unpriced model reports an em-dash cost, and zero sessions still reports 1', () => {
    const task = makeTask({ model: 'some-unknown-model', sessions: [] })
    expect(detailMetaPairs(task)).toEqual([
      ['tok', '0'],
      ['cost', '—'],
      ['sessions', '1'],
      ['model', 'some-unknown-model'],
    ])
  })
})

describe('pillStatusFor / CARD_STATUS_META', () => {
  test('a done task always reports done, regardless of attentionStatus', () => {
    expect(pillStatusFor(makeTask({ status: 'done', attentionStatus: 'working' }))).toBe('done')
  })
  test('an orphaned task reports waiting even if working', () => {
    expect(pillStatusFor(makeTask({ status: 'working', orphaned: true, attentionStatus: 'working' }))).toBe('waiting')
  })
  test('otherwise defers to attentionStatus', () => {
    expect(pillStatusFor(makeTask({ attentionStatus: 'needs-you' }))).toBe('needs-you')
  })
  test('every pillStatusFor outcome has CARD_STATUS_META metadata', () => {
    for (const key of ['working', 'needs-you', 'paused', 'idle', 'waiting', 'done'] as const) {
      expect(CARD_STATUS_META[key].label).toBeTruthy()
    }
  })
})

describe('detailStatusInfo', () => {
  test('tags "off focus" when the task is off-focus and not done', () => {
    const info = detailStatusInfo(makeTask({ status: 'working' }), true)
    expect(info.tag).toEqual({ label: 'off focus', bg: 'var(--driftSoft)', fg: 'var(--driftInk)' })
  })
  test('tags "merged" for a done task with a recorded merge stage, when not off-focus', () => {
    const info = detailStatusInfo(makeTask({ status: 'done', stageHistory: [{ stage: 'merge', at: '2026-01-01T00:00:00Z', note: null }] }), false)
    expect(info.tag).toEqual({ label: 'merged', bg: 'var(--sageSoft)', fg: 'var(--sageInk)' })
  })
  test('no tag for a plain working task', () => {
    expect(detailStatusInfo(makeTask({ status: 'working' }), false).tag).toBeNull()
  })
  test('isWorking is true only for the working pill state', () => {
    expect(detailStatusInfo(makeTask({ attentionStatus: 'working' }), false).isWorking).toBe(true)
    expect(detailStatusInfo(makeTask({ attentionStatus: 'idle' }), false).isWorking).toBe(false)
  })
})

describe('miniStageNodes', () => {
  const STAGES = ['planning', 'dev', 'cr', 'qa', 'merge']

  test('marks every stage before the current one done, and the current one current', () => {
    const task = makeTask({ stage: 'code-review', status: 'working' })
    const nodes = miniStageNodes(task, STAGES)
    expect(nodes.map((n) => [n.label, n.isDone, n.isCurrent])).toEqual([
      ['planning', true, false],
      ['dev', true, false],
      ['cr', false, true],
      ['qa', false, false],
      ['merge', false, false],
    ])
  })

  test('folds a *-fixes stage into its parent node', () => {
    const task = makeTask({ stage: 'qa-fixes', status: 'working' })
    const nodes = miniStageNodes(task, STAGES)
    const qa = nodes.find((n) => n.label === 'qa')!
    expect(qa.isCurrent).toBe(true)
  })

  test('a done task marks every reached stage done via stageHistory, not by index', () => {
    const task = makeTask({
      status: 'done',
      stageHistory: [
        { stage: 'planning', at: '2026-01-01T00:00:00Z', note: null },
        { stage: 'dev', at: '2026-01-02T00:00:00Z', note: null },
      ],
    })
    const nodes = miniStageNodes(task, STAGES)
    expect(nodes.map((n) => n.isDone)).toEqual([true, true, false, false, false])
    expect(nodes.every((n) => !n.isCurrent)).toBe(true)
  })
})

describe('cardStageLabel', () => {
  const at = (stage: string | null) => ({ stage }) as Task

  test('names the design\'s five buckets', () => {
    expect(cardStageLabel(at('planning'))).toBe('Planning')
    expect(cardStageLabel(at('dev'))).toBe('Dev')
    expect(cardStageLabel(at('code-review'))).toBe('Code review')
    expect(cardStageLabel(at('qa'))).toBe('QA')
    expect(cardStageLabel(at('merge'))).toBe('Merge')
  })

  test('folds plan-review and the two *-fixes stages into their parent bucket', () => {
    expect(cardStageLabel(at('plan-review'))).toBe('Planning')
    expect(cardStageLabel(at('comment-fix'))).toBe('Code review')
    expect(cardStageLabel(at('qa-fixes'))).toBe('QA')
  })

  test('is null for a task with no stage, so the caller falls back to the status label', () => {
    expect(cardStageLabel(at(null))).toBeNull()
  })
})

const PRICED_SESSION: Task['sessions'][number] = { n: 1, contextPct: 10, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: 'dev', sessionId: 's1', startedAt: null, updatedAt: null }

describe('activeTasksOf / sumScopeCost (the header spend pill)', () => {
  test('activeTasksOf keeps only non-done tasks that show on the board', () => {
    const active = makeTask({ slug: 'active' })
    const done = makeTask({ slug: 'done', status: 'done' })
    const offBoard = makeTask({ slug: 'off-board', showsOnBoard: false })
    expect(activeTasksOf([active, done, offBoard]).map((t) => t.slug)).toEqual(['active'])
  })

  test('sumScopeCost adds each task\'s priced cost at its own model rate', () => {
    const sonnet = makeTask({ model: 'claude-sonnet-5', sessions: [PRICED_SESSION] })
    const opus = makeTask({ model: 'claude-opus-5', sessions: [PRICED_SESSION] })
    expect(sumScopeCost([sonnet, opus])).toBe(7)
  })

  test('a task with no priced metrics contributes nothing rather than NaN', () => {
    const unpriced = makeTask({ model: 'some-unknown-model', sessions: [PRICED_SESSION] })
    const noSessions = makeTask({ sessions: [] })
    expect(sumScopeCost([unpriced, noSessions])).toBe(0)
    expect(sumScopeCost([])).toBe(0)
  })
})

const session = (overrides: Partial<Task['sessions'][number]> = {}): Task['sessions'][number] => ({
  n: 1, contextPct: 40, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: null, sessionId: null, startedAt: null, updatedAt: null, ...overrides,
})

describe('scopeCost', () => {
  test('prices each row at its own model rate and sums them', () => {
    const rows = [
      { s: session({ inputTokens: 1_000_000 }), slug: 'a', prefix: null, model: 'claude-sonnet-5' },
      { s: session({ inputTokens: 1_000_000 }), slug: 'b', prefix: null, model: 'claude-opus-5' },
    ]
    expect(scopeCost(rows)).toBe(2 + 5)
  })

  test('is null when no row has a priced model, never a fabricated zero', () => {
    expect(scopeCost([{ s: session(), slug: 'a', prefix: null, model: 'unpriced' }])).toBeNull()
    expect(scopeCost([])).toBeNull()
  })
})

describe('rowLabel', () => {
  test('prefers the stage a session ran, with dashes spelled as spaces', () => {
    expect(rowLabel({ s: session({ stage: 'code-review' }), slug: 'a', prefix: null, model: undefined })).toBe('code review')
  })

  test('falls back to the handover index for a session with no recorded stage', () => {
    expect(rowLabel({ s: session({ n: 3, stage: null }), slug: 'a', prefix: null, model: undefined })).toBe('#3')
  })

  test('leads with the milestone id in a roll-up', () => {
    expect(rowLabel({ s: session({ stage: 'qa' }), slug: 'a', prefix: 'M2', model: undefined })).toBe('M2 · qa')
  })
})

describe('milestoneScope', () => {
  test('is empty for a milestone with no dispatched child', () => {
    expect(milestoneScope(makeMilestone({ id: 'M0' }))).toEqual({ rows: [], ctx: null, ctxLive: false, model: undefined, ctxSub: null })
  })

  test("reads the child's own newest-session ctx, not the hottest one ever recorded", () => {
    const child = makeTask({ contextPct: 15, model: 'claude-sonnet-5', sessions: [session({ contextPct: 90 }), session({ n: 2, contextPct: 15, current: true })] })
    const scope = milestoneScope(makeMilestone({ id: 'M0', task: child }))
    expect(scope.ctx).toBe(15)
    expect(scope.ctxLive).toBe(true)
    expect(scope.model).toBe('claude-sonnet-5')
  })
})

describe('rollupScope', () => {
  test("sums the parent's sessions and every dispatched milestone's, labelling rows by milestone", () => {
    const child = makeTask({ slug: 'p-m0', model: 'claude-sonnet-5', sessions: [session({ stage: 'dev', contextPct: 70 })] })
    const parent = makeTask({ slug: 'p', model: 'claude-sonnet-5', sessions: [session({ stage: 'planning', contextPct: 30 })], milestones: [makeMilestone({ id: 'M0', task: child }), makeMilestone({ id: 'M1' })] })
    const scope = rollupScope(parent)
    expect(scope.rows.map((row) => row.prefix)).toEqual([null, 'M0'])
    expect(scope.ctx).toBe(70)
    expect(scope.ctxSub).toBe('last known · M0 · dev')
  })

  test('a live session beats a hotter idle one, and the sub-label says live', () => {
    const parent = makeTask({ sessions: [session({ contextPct: 92 }), session({ n: 2, contextPct: 55, current: true, stage: 'qa' })] })
    const scope = rollupScope(parent)
    expect(scope.ctx).toBe(55)
    expect(scope.ctxLive).toBe(true)
    expect(scope.ctxSub).toBe('hottest live · qa')
  })

  test('has no ctx and no sub-label when no session ever recorded one', () => {
    const scope = rollupScope(makeTask({ sessions: [session({ contextPct: null })] }))
    expect(scope.ctx).toBeNull()
    expect(scope.ctxSub).toBeNull()
  })
})
