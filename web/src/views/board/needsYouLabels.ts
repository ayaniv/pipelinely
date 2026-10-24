import type { NeedsYouReason } from '../../../../src/nextAction'

// What the developer is being asked to decide, one phrase per reason the
// decision can raise. A Record, so a new reason cannot ship without a label.
export const NEEDS_YOU_LABELS: Record<NeedsYouReason, string> = {
  merge: 'Ready to merge',
  'merge-conflicts': 'Fix merge conflicts',
  'review-comments': 'Triage review comments',
  'qa-findings': 'Triage QA findings',
  'qa-consent': 'Start QA? (asks every time)',
  'qa-intent-brief': 'QA needs an intent brief',
  'review-intent-brief': 'Review needs an intent brief',
  'start-milestones': 'Start milestones',
  'result-review': 'Review the result',
  'design-approval': 'Approve the design',
  'ds-stage': 'Design-system stage',
  question: 'Answer an open question',
}
