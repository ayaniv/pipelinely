import type { ApprovalPrompt } from '../../../../src/approvalPrompt'
import type { PostActionOptions } from '../../api/actions'
import { ApprovalAnswerButtons } from './ApprovalAnswerButtons'

export interface ApprovalCalloutProps extends Partial<PostActionOptions> {
  slug: string
  prompt: ApprovalPrompt
}

// A worker's tmux session is stopped on a Claude Code dialog. Derived
// server-side (approvalPrompt on the task); this renders it and hands the
// answering to ApprovalAnswerButtons, so the callout itself stays a small
// self-contained row that doesn't depend on the card's layout.
export function ApprovalCallout({ slug, prompt, fetchImpl = fetch, log = console.error }: ApprovalCalloutProps) {
  return (
    <div
      className="ctx-warning approval-callout"
      data-testid="card-approval"
      data-session={prompt.session}
      title={`Waiting in tmux session ${prompt.session}`}
    >
      <span className="approval-callout-label" data-testid="card-approval-label">Needs you: waiting for approval</span>
      <span className="approval-callout-summary" data-testid="card-approval-summary">{prompt.summary}</span>
      <ApprovalAnswerButtons key={prompt.fingerprint} slug={slug} prompt={prompt} fetchImpl={fetchImpl} log={log} />
    </div>
  )
}
