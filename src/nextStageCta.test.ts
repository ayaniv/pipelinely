import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { assessQaNeed, computeNextStageCta, DS_HANDOFFS, hasConflictingPr, HUMAN_GATE_STAGES, isAtMergeHandoff, isBlockedByMergeConflicts, NEXT_STAGE_BY_WAITING_REASON, isCrFixSelectionMissing, isMilestoneReadyForDev, isQaNotApplicable, isReadyForResultReview, matchWaitingReason } from './nextStageCta.js'
import * as taskParser from './taskParser.js'

// The behavior itself is covered where it has always been, in
// taskParser.test.ts (via the re-exports). What only this module owes is the
// reason it exists: the React client bundles it, so it must stay pure.

describe('nextStageCta module', () => {
  it('imports only types — no node: builtin or runtime dependency can leak into the web bundle', async () => {
    const source = await fs.readFile(new URL('./nextStageCta.ts', import.meta.url), 'utf-8')
    const importClauses = [...source.matchAll(/^import\s+(.+?)\s+from\s+'[^']+'/gm)].map((m) => m[1])

    expect(importClauses.length).toBeGreaterThan(0)
    expect(importClauses.every((clause) => clause.startsWith('type '))).toBe(true)
  })

  it('is the same implementation taskParser re-exports, not a second copy', () => {
    expect(taskParser.computeNextStageCta).toBe(computeNextStageCta)
    expect(taskParser.isMilestoneReadyForDev).toBe(isMilestoneReadyForDev)
    expect(taskParser.NEXT_STAGE_BY_WAITING_REASON.length).toBeGreaterThan(0)
  })

  it('matchWaitingReason names the marker that matched, and nothing for a non-waiting task', () => {
    expect(matchWaitingReason({ status: 'waiting', waitingReason: 'plan ready for review' })).toEqual({ marker: 'plan ready for review', stage: 'plan-review' })
    expect(matchWaitingReason({ status: 'working', waitingReason: 'plan ready for review' })).toBeNull()
  })
})

describe('isReadyForResultReview', () => {
  it.each([
    ['audit ready for developer review', true],
    ['design ready for developer review', true],
    ['anything ready for developer review', true],
    ['PR open, ready for CR', false],
    ['need a decision', false],
  ])('waiting: %s -> %s', (waitingReason, expected) => {
    expect(isReadyForResultReview({ status: 'waiting', waitingReason })).toBe(expected)
  })

  it('is false when the task is not waiting, even with matching text', () => {
    expect(isReadyForResultReview({ status: 'working', waitingReason: 'audit ready for developer review' })).toBe(false)
  })

  it('is false when there is no waiting reason', () => {
    expect(isReadyForResultReview({ status: 'waiting', waitingReason: undefined })).toBe(false)
  })
})

describe('assessQaNeed', () => {
  it.each([
    'npx playwright test e2e/foo.spec.ts',
    'npm run test:e2e:integration',
    'E2E suite: e2e/board.spec.ts',
  ])('needs QA when VERIFY names an e2e command: %s', (verifier) => {
    expect(assessQaNeed({ verifier, changedFiles: ['src/a.ts'] }).needsQa).toBe(true)
  })

  it.each(['e2e/board.spec.ts', 'web/e2e/x.ts', 'tests/login.spec.tsx'])('needs QA when the PR touches an e2e spec: %s', (specPath) => {
    const assessment = assessQaNeed({ verifier: 'npx vitest run', changedFiles: ['src/a.ts', specPath] })
    expect(assessment.needsQa).toBe(true)
  })

  it.each([
    ['unit tests only', 'npx tsc --noEmit && npx vitest run', ['src/a.ts', 'src/a.test.ts']],
    ['docs only', 'npx vitest run', ['README.md', 'orchestrator-prompt.md']],
  ])('QA is not applicable for %s, and says why', (_label, verifier, changedFiles) => {
    const assessment = assessQaNeed({ verifier, changedFiles })
    expect(assessment.needsQa).toBe(false)
    expect(assessment.reason).toMatch(/no e2e/i)
  })

  it.each([
    'manual QA only',
    '`manual QA only`',
    '"manual QA only"',
    'QA manually',
    'check in browser',
    'localhost:5173',
    'open the dashboard',
    'n/a',
    'none',
    'by hand',
    'visual check',
    'Manual verification in the browser',
    'https://localhost:5173/board',
    'npmish check by eye',
  ])('fails closed when VERIFY is not a runnable command: %s', (verifier) => {
    const assessment = assessQaNeed({ verifier, changedFiles: ['README.md'] })
    expect(assessment.needsQa).toBe(true)
    expect(assessment.reason).toMatch(/not a (test )?command/i)
  })

  it.each([
    'npx tsc --noEmit && npx vitest run',
    'npm test',
    'npx vitest run',
    'pnpm test',
    'yarn test',
    'vitest run',
    'jest --ci',
    'tsc --noEmit',
    'pytest -q',
    'go test ./...',
    'cargo test',
    'make test',
    'bash scripts/check.sh',
    'node --test',
  ])('a runnable test command with no e2e spec in the diff skips QA: %s', (verifier) => {
    expect(assessQaNeed({ verifier, changedFiles: ['src/a.ts'] }).needsQa).toBe(false)
  })

  it.each([
    'npm test && npx playwright test e2e/board.spec.ts',
    'npm run test:e2e',
    'bash scripts/e2e-integration/run.sh',
  ])('the e2e word wins over a runnable command prefix: %s', (verifier) => {
    const assessment = assessQaNeed({ verifier, changedFiles: ['src/a.ts'] })
    expect(assessment.needsQa).toBe(true)
    expect(assessment.reason).toMatch(/e2e/i)
  })

  it('fails closed when VERIFY is missing — cannot tell, so QA is still needed', () => {
    const assessment = assessQaNeed({ verifier: null, changedFiles: ['README.md'] })
    expect(assessment.needsQa).toBe(true)
    expect(assessment.reason).toMatch(/VERIFY/)
  })

  it('fails closed when the PR diff is unavailable', () => {
    const assessment = assessQaNeed({ verifier: 'npx vitest run', changedFiles: null })
    expect(assessment.needsQa).toBe(true)
    expect(assessment.reason).toMatch(/diff/i)
  })

  it('an e2e VERIFY still needs QA when the diff is unavailable', () => {
    expect(assessQaNeed({ verifier: 'npx playwright test', changedFiles: null }).needsQa).toBe(true)
  })
})

describe('QA not applicable gating', () => {
  const atQaMarker = (marker: string, qaSkipReason: string | null) => ({ status: 'waiting' as const, waitingReason: marker, qaSkipReason })

  it('is applicable only while waiting at a QA-entry marker with a skip reason', () => {
    expect(isQaNotApplicable(atQaMarker('CR approved, ready for QA', 'no e2e'))).toBe(true)
    expect(isQaNotApplicable(atQaMarker('comments addressed, ready for QA', 'no e2e'))).toBe(true)
    expect(isQaNotApplicable(atQaMarker('CR approved, ready for QA', null))).toBe(false)
    expect(isQaNotApplicable(atQaMarker('PR open, ready for CR', 'no e2e'))).toBe(false)
    expect(isQaNotApplicable({ status: 'working', waitingReason: 'CR approved, ready for QA', qaSkipReason: 'no e2e' })).toBe(false)
  })

  it('still sends an approved review with comments to comment-fix, not merge', () => {
    expect(isQaNotApplicable({ ...atQaMarker('CR approved, ready for QA', 'no e2e'), findings: [{}] })).toBe(false)
  })

  it('offers no stage CTA when QA is not applicable, and the normal one otherwise', () => {
    expect(computeNextStageCta(atQaMarker('CR approved, ready for QA', 'no e2e'))).toBeNull()
    expect(computeNextStageCta(atQaMarker('CR approved, ready for QA', null))).toEqual({ stage: 'qa' })
  })
})

// The gate that holds "Run CR fixes" back until a review comment is ticked, so
// the card cannot stage /pipelinely-cr-fixes with nothing selected (which would
// silently drop every comment).
describe('isCrFixSelectionMissing', () => {
  const finding = (isSelected: boolean) => ({ selected: isSelected }) as never

  it('is missing when no finding is selected, or there are none', () => {
    expect(isCrFixSelectionMissing({ findings: [finding(false)] }, 'comment-fix')).toBe(true)
    expect(isCrFixSelectionMissing({ findings: [] }, 'comment-fix')).toBe(true)
  })

  it('is satisfied once any finding is selected', () => {
    expect(isCrFixSelectionMissing({ findings: [finding(false), finding(true)] }, 'comment-fix')).toBe(false)
  })

  it('never applies to a stage other than comment-fix', () => {
    expect(isCrFixSelectionMissing({ findings: [finding(false)] }, 'qa')).toBe(false)
  })
})

describe('a conflicting PR comes first', () => {
  const HANDOFF_REASONS = [...NEXT_STAGE_BY_WAITING_REASON.map((m) => m.marker), 'QA passed, ready to merge', 'no QA needed, ready to merge']

  it.each(HANDOFF_REASONS)('waiting: %s with a conflicting PR -> Fix conflicts', (waitingReason) => {
    const task = { status: 'waiting' as const, waitingReason, prMergeState: 'conflicting' as const }
    expect(isBlockedByMergeConflicts(task)).toBe(true)
    expect(computeNextStageCta(task)).toEqual({ stage: 'merge-conflicts' })
  })

  it('covers a task the TIMELINE already put at merge, whatever its waiting reason says', () => {
    expect(computeNextStageCta({ status: 'waiting', waitingReason: 'anything', stage: 'merge', prMergeState: 'conflicting' })).toEqual({ stage: 'merge-conflicts' })
  })

  it('wins over the QA-not-applicable gate, which would otherwise record a skip toward merge', () => {
    const task = { status: 'waiting' as const, waitingReason: 'CR approved, ready for QA', qaSkipReason: 'no e2e', prMergeState: 'conflicting' as const }
    expect(computeNextStageCta(task)).toEqual({ stage: 'merge-conflicts' })
  })

  it('wins over an approved review still awaiting a comment decision', () => {
    const task = { status: 'waiting' as const, waitingReason: 'CR approved, ready for QA', findings: [{}], prMergeState: 'conflicting' as const }
    expect(computeNextStageCta(task)).toEqual({ stage: 'merge-conflicts' })
  })

  it.each(['mergeable', 'unknown', undefined] as const)('changes nothing when the merge state is %s', (prMergeState) => {
    for (const { marker, stage } of NEXT_STAGE_BY_WAITING_REASON) {
      expect(computeNextStageCta({ status: 'waiting', waitingReason: marker, prMergeState })).toEqual({ stage })
    }
    expect(isBlockedByMergeConflicts({ status: 'waiting', waitingReason: 'QA passed, ready to merge', prMergeState })).toBe(false)
  })

  it('never offers the fix to a task that is not waiting at a hand-off: working, done, shelved, or waiting on a question', () => {
    expect(computeNextStageCta({ status: 'working', prMergeState: 'conflicting' })).toBeNull()
    expect(computeNextStageCta({ status: 'done', prMergeState: 'conflicting' })).toBeNull()
    expect(computeNextStageCta({ status: 'shelved', waitingReason: 'PR open, ready for CR', prMergeState: 'conflicting' })).toBeNull()
    expect(computeNextStageCta({ status: 'waiting', waitingReason: 'which colour should the badge be?', prMergeState: 'conflicting' })).toBeNull()
  })

  it('does not read "not ready to merge" as the merge hand-off', () => {
    expect(isBlockedByMergeConflicts({ status: 'waiting', waitingReason: 'not ready to merge: CR blocking', prMergeState: 'conflicting' })).toBe(false)
  })

  it('hasConflictingPr is the merge state alone, for gates that must refuse whatever the STATUS says', () => {
    expect(hasConflictingPr({ prMergeState: 'conflicting' })).toBe(true)
    expect(hasConflictingPr({ prMergeState: 'mergeable' })).toBe(false)
    expect(hasConflictingPr({ prMergeState: 'unknown' })).toBe(false)
    expect(hasConflictingPr({})).toBe(false)
  })
})

describe('the ds hand-off overlay', () => {
  const ds = (waitingReason: string, extra: Record<string, unknown> = {}) => ({ status: 'waiting' as const, waitingReason, kind: 'ds' as const, ...extra })
  const dev = (waitingReason: string, extra: Record<string, unknown> = {}) => ({ status: 'waiting' as const, waitingReason, kind: 'dev' as const, ...extra })

  it.each([
    ['QA passed, ready to merge', 'design-qa'],
    ['no QA needed, ready to merge', 'design-qa'],
    ['design QA done, ready for design approval', 'design-approval'],
    ['design changes requested, triage and dispatch design-fixes', 'design-fixes'],
    ['design fixes pushed, ready to re-run design QA', 'design-qa'],
    ['merged, ready for adopt', 'adopt'],
  ])('a ds task waiting at "%s" hands off to %s', (reason, stage) => {
    expect(computeNextStageCta(ds(reason))).toEqual({ stage })
  })

  it('leaves the earlier ds hand-offs on the shared table', () => {
    expect(computeNextStageCta(ds('PR open, ready for CR'))).toEqual({ stage: 'code-review' })
    expect(computeNextStageCta(ds('CR approved, ready for QA'))).toEqual({ stage: 'qa' })
  })

  it('does not hand a design-approved ds task to any stage: the next step is Merge', () => {
    expect(computeNextStageCta(ds('design approved, ready to merge'))).toBeNull()
  })

  it('never consults the overlay for a dev task, or one with no kind', () => {
    expect(computeNextStageCta(dev('QA passed, ready to merge'))).toBeNull()
    expect(computeNextStageCta({ status: 'waiting', waitingReason: 'QA passed, ready to merge' })).toBeNull()
    expect(computeNextStageCta(dev('design QA done, ready for design approval'))).toBeNull()
  })

  it('lists the merged-for-adopt row, only for ds: a dev task never reads that marker', () => {
    expect(DS_HANDOFFS).toContainEqual({ marker: 'merged, ready for adopt', stage: 'adopt' })
    expect(computeNextStageCta(dev('merged, ready for adopt'))).toBeNull()
  })

  it('does not hand a merged ds task back to merge', () => {
    expect(computeNextStageCta(ds('merged, ready for adopt', { stage: 'merge' }))).toEqual({ stage: 'adopt' })
  })

  it('treats a ds task whose QA is not applicable as owing design QA, not as merge-ready', () => {
    const task = ds('CR approved, ready for QA', { qaSkipReason: 'no e2e' })
    expect(computeNextStageCta(task)).toEqual({ stage: 'design-qa' })
    expect(computeNextStageCta(dev('CR approved, ready for QA', { qaSkipReason: 'no e2e' }))).toBeNull()
  })

  it('names the design-approval gate as a human gate, not a dispatchable stage', () => {
    expect(HUMAN_GATE_STAGES).toEqual(['design-approval'])
  })
})

describe('isAtMergeHandoff', () => {
  it('for dev reduces to the old compound: stage merge', () => {
    expect(isAtMergeHandoff({ status: 'working', stage: 'merge' })).toBe(true)
  })

  it('for dev reduces to the old compound: QA not applicable', () => {
    expect(isAtMergeHandoff({ status: 'waiting', waitingReason: 'CR approved, ready for QA', qaSkipReason: 'no e2e' })).toBe(true)
  })

  it('for dev reduces to the old compound: a ready-to-merge reason', () => {
    expect(isAtMergeHandoff({ status: 'waiting', waitingReason: 'QA passed, ready to merge' })).toBe(true)
    expect(isAtMergeHandoff({ status: 'waiting', waitingReason: 'not ready to merge: CR blocking' })).toBe(false)
    expect(isAtMergeHandoff({ status: 'working', waitingReason: 'QA passed, ready to merge' })).toBe(false)
  })

  it('for ds is true only on the approved hand-off', () => {
    expect(isAtMergeHandoff({ kind: 'ds', status: 'waiting', waitingReason: 'design approved, ready to merge' })).toBe(true)
  })

  it('for ds is false at stage merge, so a merged task is not offered Merge again', () => {
    expect(isAtMergeHandoff({ kind: 'ds', status: 'waiting', waitingReason: 'merged, ready for adopt', stage: 'merge' })).toBe(false)
  })

  it('for ds is false when QA is not applicable or QA merely passed: design QA is still owed', () => {
    expect(isAtMergeHandoff({ kind: 'ds', status: 'waiting', waitingReason: 'CR approved, ready for QA', qaSkipReason: 'no e2e' })).toBe(false)
    expect(isAtMergeHandoff({ kind: 'ds', status: 'waiting', waitingReason: 'QA passed, ready to merge' })).toBe(false)
    expect(isAtMergeHandoff({ kind: 'ds', status: 'waiting', waitingReason: 'no QA needed, ready to merge' })).toBe(false)
  })

  it('for ds is false once the task is no longer waiting', () => {
    expect(isAtMergeHandoff({ kind: 'ds', status: 'working', waitingReason: 'design approved, ready to merge' })).toBe(false)
  })
})

describe('a conflicting ds PR', () => {
  it('comes first at the design-approval gate and at the approved hand-off, like dev', () => {
    const conflicting = { kind: 'ds' as const, status: 'waiting' as const, prMergeState: 'conflicting' as const }
    expect(isBlockedByMergeConflicts({ ...conflicting, waitingReason: 'design QA done, ready for design approval' })).toBe(true)
    expect(isBlockedByMergeConflicts({ ...conflicting, waitingReason: 'design approved, ready to merge' })).toBe(true)
    expect(isBlockedByMergeConflicts({ ...conflicting, waitingReason: 'merged, ready for adopt', stage: 'merge' })).toBe(false)
  })
})
