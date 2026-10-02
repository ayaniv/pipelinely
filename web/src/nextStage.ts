import type { Stage, Task } from '../../src/types'
import { isQaNotApplicable } from '../../src/nextStageCta'
import { findPrNumber } from './taskScope'

// The waiting-reason → next-stage table itself (NEXT_STAGE_BY_WAITING_REASON /
// computeNextStageCta) is shared with the server via src/nextStageCta.ts; only
// the board card's own presentation lives here.

// The design's NEXT[stageKey] label map, adapted to this app's real stage
// names (no entry for 'merge', same reason as above).
export const CARD_CTA_LABEL: Partial<Record<Stage, string>> = {
  'plan-review': 'Run plan review',
  dev: 'Start dev',
  'code-review': 'Run code review',
  'comment-fix': 'Run CR fixes',
  qa: 'Start QA',
  'qa-fixes': 'Run QA fixes',
}

// What a card offers when it has no dispatchable next stage — a parent whose
// dev work is dispatched per milestone, or a leaf waiting on a decision only
// a human can make.
export const SEE_DETAILS_LABEL = 'See details'

// The card's label for a research task whose deliverable document awaits
// the developer — opens the task page on its Result tab.
export const READ_RESULT_LABEL = 'Read result'

// The card's label while an approved review's comments still need selecting.
export const TRIAGE_CR_COMMENTS_LABEL = 'Triage CR comments'

// Stricter than the Merge tab's own gate, on purpose: that tab renders Merge
// as soon as a PR number resolves, with no stage check. A board card is a
// glance, so it must not offer merge-and-mark-done to a task still
// mid-pipeline. A task whose QA is not applicable is past its last stage that
// has anything to run, so it counts as merge-ready before the skip is recorded.
export function isCardMergeReady(task: Task): boolean {
  return (task.stage === 'merge' || isQaNotApplicable(task)) && !!findPrNumber(task)
}
