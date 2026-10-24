import type { Stage, Task } from '../../src/types'
import { hasConflictingPr, isAtMergeHandoff } from '../../src/nextStageCta'
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
  'merge-conflicts': 'Fix conflicts',
  'design-qa': 'Start design QA',
  'design-fixes': 'Run design fixes',
  adopt: 'Run adopt',
}

// What a card offers when it has no dispatchable next stage — a leaf waiting
// on a decision only a human can make.
export const SHOW_TASK_LABEL = 'Show task'

export const READ_PLAN_LABEL = 'Read plan'

// The outlined companion to a fixes run: opens the triage checklist.
export const TRIAGE_COMMENTS_LABEL = 'Triage comments'

export const OPEN_PR_LABEL = 'Open PR'

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
// The explicit "ready to merge" STATUS counts too: task.stage reads TIMELINE's
// last line, so a CR approval that lands after QA leaves the stage on
// code-review while the hand-off itself already says merge. A conflicting PR
// is never merge-ready: the conflict fix comes first (computeNextStageCta).
export function isCardMergeReady(task: Task): boolean {
  return isAtMergeHandoff(task) && !!findPrNumber(task) && !hasConflictingPr(task)
}
