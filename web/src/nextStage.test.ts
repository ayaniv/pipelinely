import { describe, expect, test } from 'vitest'
import { CARD_CTA_LABEL, isCardMergeReady } from './nextStage'
import { makeTask } from './views/board/testTask'

describe('isCardMergeReady', () => {
  test('needs both the merge stage and a resolvable PR — stricter than the Merge tab on purpose', () => {
    expect(isCardMergeReady(makeTask({ stage: 'merge', reviewRef: '42' }))).toBe(true)
    expect(isCardMergeReady(makeTask({ stage: 'qa', reviewRef: '42' }))).toBe(false)
    expect(isCardMergeReady(makeTask({ stage: 'merge' }))).toBe(false)
  })
})

describe('CARD_CTA_LABEL', () => {
  test('labels every stage a waiting reason can dispatch, and deliberately not merge', () => {
    expect(Object.keys(CARD_CTA_LABEL).sort()).toEqual(['code-review', 'comment-fix', 'dev', 'plan-review', 'qa', 'qa-fixes'])
  })
})
