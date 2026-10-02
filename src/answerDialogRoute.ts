import type { AnswerDialogRefusal } from './answerDialogGuard.js'
import type { AnswerDialogResponseBody, DialogChoice, DialogFailureReason, DialogRefusalReason } from './answerDialogWire.js'
import type { DialogAnswerResult } from './dialogAnswer.js'
import { SAFE_TMUX_SESSION_NAME } from './focusTab.js'

// The HTTP face of the answer-dialog route: every refusal is
// `{ reason, error }`, where `error` is one human sentence the card shows as-is.

export interface AnswerDialogResponse {
  status: number
  body: AnswerDialogResponseBody
}

const GUARD_REFUSALS: Record<AnswerDialogRefusal, AnswerDialogResponse> = {
  'not-json': { status: 415, body: { reason: 'not-json', error: 'The request must be JSON.' } },
  remote: { status: 403, body: { reason: 'remote', error: 'Answering is only available on this machine.' } },
  'bad-host': { status: 403, body: { reason: 'bad-host', error: 'The request was not made to a local address.' } },
  'cross-site': { status: 403, body: { reason: 'cross-site', error: 'The request did not come from the dashboard itself.' } },
}

const REFUSAL_RESPONSES: Record<DialogRefusalReason, AnswerDialogResponse> = {
  'no-dialog': { status: 409, body: { reason: 'no-dialog', error: 'The worker is no longer showing a dialog, so nothing was sent.' } },
  'dialog-changed': { status: 409, body: { reason: 'dialog-changed', error: 'The dialog changed since you last saw it, so nothing was sent.' } },
  busy: { status: 409, body: { reason: 'busy', error: 'Another answer to this worker is still in progress.' } },
  'session-not-owned': { status: 400, body: { reason: 'session-not-owned', error: 'That session is not an active task worker, so nothing was sent.' } },
  'unknown-option': { status: 400, body: { reason: 'unknown-option', error: 'That option is not on the dialog, so nothing was sent.' } },
}

const FAILURE_STATUS: Record<DialogFailureReason, number> = { 'capture-failed': 502, 'send-failed': 502, 'audit-failed': 500 }
const FAILURE_PREFIX: Record<DialogFailureReason, string> = {
  'capture-failed': 'Could not read the worker\'s terminal, so nothing was sent',
  'send-failed': 'Sending the key may have failed, so check the terminal before answering again',
  'audit-failed': 'Could not write the audit log, so nothing was sent',
}

export function responseForGuardRefusal(refusal: AnswerDialogRefusal): AnswerDialogResponse {
  return GUARD_REFUSALS[refusal]
}

export function responseForAnswerResult(result: DialogAnswerResult): AnswerDialogResponse {
  switch (result.outcome) {
    case 'answered':
      return { status: 200, body: { outcome: 'answered' } }
    case 'unconfirmed':
      return { status: 202, body: { outcome: 'unconfirmed', error: 'The key was sent, but the dialog is still showing. Check the terminal.' } }
    case 'refused':
      return REFUSAL_RESPONSES[result.reason]
    case 'failed':
      return { status: FAILURE_STATUS[result.reason], body: { reason: result.reason, error: `${FAILURE_PREFIX[result.reason]}: ${result.error}` } }
  }
}

const FINGERPRINT_FORMAT = /^[0-9a-f]{16}$/
const MIN_OPTION_NUMBER = 1
const MAX_OPTION_NUMBER = 9

export interface AnswerBody {
  session: string
  choice: DialogChoice
  fingerprint: string
}

// The client names an option or cancel, never key text.
export function parseAnswerBody(body: unknown): AnswerBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { session, option, fingerprint } = body as Record<string, unknown>
  if (typeof session !== 'string' || !SAFE_TMUX_SESSION_NAME.test(session)) return null
  if (typeof fingerprint !== 'string' || !FINGERPRINT_FORMAT.test(fingerprint)) return null
  const isOptionNumber = typeof option === 'number' && Number.isInteger(option) && option >= MIN_OPTION_NUMBER && option <= MAX_OPTION_NUMBER
  if (!isOptionNumber && option !== 'cancel') return null
  return { session, choice: option as DialogChoice, fingerprint }
}

export const BAD_REQUEST_RESPONSE: AnswerDialogResponse = {
  status: 400,
  body: { reason: 'bad-request', error: 'The request needs a session, an option from 1 to 9 or "cancel", and the dialog fingerprint.' },
}

export const UNKNOWN_TASK_RESPONSE: AnswerDialogResponse = { status: 404, body: { reason: 'unknown-task', error: 'No such task.' } }
