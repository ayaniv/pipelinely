// A blocked worker's approval prompt (src/approvalPrompt.ts ApprovalPrompt),
// for specs that push it into a snapshot with pushSnapshot instead of waiting
// for the fixture tmux poll. Its session names no real pane, so the fixture
// server's /answer-dialog route can never type into anything.
export const PUSHED_APPROVAL_PROMPT = {
  session: 'worker-v3-pushed-approval',
  question: 'Do you want to proceed?',
  summary: 'Bash command — npx vitest run web/src/views/board',
  options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No, and tell Claude what to do differently' }],
  fingerprint: 'v3-pushed-approval-fixture',
}

// The numbered options plus the callout's own Cancel button.
export const PUSHED_APPROVAL_BUTTON_COUNT = PUSHED_APPROVAL_PROMPT.options.length + 1
