import type { AnswerDialogRefusal } from './answerDialogGuard.js'

// The wire shape of POST /answer-dialog/:slug, shared with web/ the way
// approvalPrompt.ts is — so it holds types only and no node: imports. The
// server's response tables are typed against these unions, so a reason added
// or renamed there fails to compile here instead of drifting from the client.

export type DialogChoice = number | 'cancel'

export type DialogRefusalReason = 'session-not-owned' | 'no-dialog' | 'dialog-changed' | 'unknown-option' | 'busy'
export type DialogFailureReason = 'capture-failed' | 'audit-failed' | 'send-failed'

// Sent inline by the route in server.ts rather than from answerDialogRoute.ts's tables.
export type AnswerDialogRouteReason = 'not-canonical' | 'internal'

export type AnswerDialogReason = AnswerDialogRefusal | DialogRefusalReason | DialogFailureReason | AnswerDialogRouteReason | 'bad-request' | 'unknown-task'

// The client names an option or cancel, never key text.
export interface AnswerDialogRequestBody {
  session: string
  option: DialogChoice
  fingerprint: string
}

export interface AnswerDialogResponseBody {
  outcome?: 'answered' | 'unconfirmed'
  reason?: AnswerDialogReason
  error?: string
}
