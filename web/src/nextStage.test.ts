import { describe, expect, test } from 'vitest'
import { CARD_CTA_LABEL, isCardMergeReady } from './nextStage'
import { makeTask } from './views/board/testTask'

describe('isCardMergeReady', () => {
  test('needs both the merge stage and a resolvable PR — stricter than the Merge tab on purpose', () => {
    expect(isCardMergeReady(makeTask({ stage: 'merge', reviewRef: '42' }))).toBe(true)
    expect(isCardMergeReady(makeTask({ stage: 'qa', reviewRef: '42' }))).toBe(false)
    expect(isCardMergeReady(makeTask({ stage: 'merge' }))).toBe(false)
  })

  // task.stage lags a hand-off (it reads TIMELINE's last line), so the explicit
  // "ready to merge" STATUS is what says the task is at the merge gate.
  test('a "ready to merge" hand-off with a PR counts even while task.stage still lags', () => {
    const lagging = { status: 'waiting', stage: 'code-review', waitingReason: 'QA passed, ready to merge', reviewRef: '42' } as const
    expect(isCardMergeReady(makeTask(lagging))).toBe(true)
    expect(isCardMergeReady(makeTask({ ...lagging, reviewRef: undefined }))).toBe(false)
    expect(isCardMergeReady(makeTask({ ...lagging, status: 'working' }))).toBe(false)
    expect(isCardMergeReady(makeTask({ ...lagging, waitingReason: 'plan reviewed, ready for dev' }))).toBe(false)
  })

  // A bare substring match would read the negation as the hand-off.
  test.each(['not ready to merge: CR blocking', 'CR blocked, not ready to merge', 'ready to merge once CI is green'])('"%s" is not a merge hand-off', (waitingReason) => {
    expect(isCardMergeReady(makeTask({ status: 'waiting', stage: 'code-review', waitingReason, reviewRef: '42' }))).toBe(false)
  })

  test.each(['QA passed, ready to merge', 'no QA needed, ready to merge', 'ready to merge'])('"%s" is a merge hand-off', (waitingReason) => {
    expect(isCardMergeReady(makeTask({ status: 'waiting', stage: 'code-review', waitingReason, reviewRef: '42' }))).toBe(true)
  })
})

describe('isCardMergeReady with a conflicting PR', () => {
  test('a conflicting PR is never merge-ready, whatever the STATUS or stage says', () => {
    expect(isCardMergeReady(makeTask({ stage: 'merge', reviewRef: '42', prMergeState: 'conflicting' }))).toBe(false)
    expect(isCardMergeReady(makeTask({ status: 'waiting', stage: 'code-review', waitingReason: 'QA passed, ready to merge', reviewRef: '42', prMergeState: 'conflicting' }))).toBe(false)
  })

  test.each(['mergeable', 'unknown'] as const)('a %s PR changes nothing', (prMergeState) => {
    expect(isCardMergeReady(makeTask({ stage: 'merge', reviewRef: '42', prMergeState }))).toBe(true)
  })
})

describe('CARD_CTA_LABEL', () => {
  test('labels every stage a waiting reason or a conflicting PR can dispatch, and deliberately not merge', () => {
    expect(Object.keys(CARD_CTA_LABEL).sort()).toEqual(['adopt', 'code-review', 'comment-fix', 'design-fixes', 'design-qa', 'dev', 'merge-conflicts', 'plan-review', 'qa', 'qa-fixes'])
  })

  test('the conflict fix reads "Fix conflicts"', () => {
    expect(CARD_CTA_LABEL['merge-conflicts']).toBe('Fix conflicts')
  })
})

describe('isCardMergeReady for a ds task', () => {
  const approved = { kind: 'ds', status: 'waiting', stage: 'design-approval', waitingReason: 'design approved, ready to merge', reviewRef: '42' } as const

  test('is merge-ready only once the designer has approved', () => {
    expect(isCardMergeReady(makeTask(approved))).toBe(true)
    expect(isCardMergeReady(makeTask({ ...approved, waitingReason: 'QA passed, ready to merge' }))).toBe(false)
    expect(isCardMergeReady(makeTask({ ...approved, waitingReason: 'design QA done, ready for design approval' }))).toBe(false)
  })

  test('is not merge-ready at stage merge, which a merged task waiting for adopt also reads', () => {
    expect(isCardMergeReady(makeTask({ ...approved, stage: 'merge', waitingReason: 'merged, ready for adopt' }))).toBe(false)
  })

  test('is not merge-ready with a conflicting PR', () => {
    expect(isCardMergeReady(makeTask({ ...approved, prMergeState: 'conflicting' }))).toBe(false)
  })
})

describe('CARD_CTA_LABEL for the routed ds stages', () => {
  test('labels adopt, design QA and design fixes, and leaves the human gate without a button label', () => {
    expect(CARD_CTA_LABEL['design-qa']).toBe('Start design QA')
    expect(CARD_CTA_LABEL['design-fixes']).toBe('Run design fixes')
    expect(CARD_CTA_LABEL.adopt).toBe('Run adopt')
    expect(CARD_CTA_LABEL['design-approval']).toBeUndefined()
  })
})
