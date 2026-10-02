import { describe, it, expect } from 'vitest'
import { parseAnswerBody, responseForAnswerResult, responseForGuardRefusal } from './answerDialogRoute.js'
import type { DialogAnswerResult, DialogFailureReason, DialogRefusalReason } from './dialogAnswer.js'

describe('responseForAnswerResult', () => {
  it('maps answered to 200', () => {
    expect(responseForAnswerResult({ outcome: 'answered' })).toMatchObject({ status: 200, body: { outcome: 'answered' } })
  })

  it('maps unconfirmed to 202 with a message that sends the user to the terminal', () => {
    const response = responseForAnswerResult({ outcome: 'unconfirmed' })
    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ outcome: 'unconfirmed' })
    expect(response.body.error).toMatch(/terminal/)
  })

  it.each<[DialogRefusalReason, number]>([
    ['no-dialog', 409], ['dialog-changed', 409], ['busy', 409],
    ['session-not-owned', 400], ['unknown-option', 400],
  ])('maps the refusal %s to %i with a reason and one human sentence', (reason, status) => {
    const response = responseForAnswerResult({ outcome: 'refused', reason })
    expect(response.status).toBe(status)
    expect(response.body.reason).toBe(reason)
    expect(response.body.error).toMatch(/^[A-Z].*\.$/)
  })

  it.each<[DialogFailureReason, number]>([['capture-failed', 502], ['send-failed', 502], ['audit-failed', 500]])(
    'maps the failure %s to %i and carries the underlying error',
    (reason, status) => {
      const result: DialogAnswerResult = { outcome: 'failed', reason, error: 'underlying detail' }
      const response = responseForAnswerResult(result)
      expect(response.status).toBe(status)
      expect(response.body.reason).toBe(reason)
      expect(response.body.error).toContain('underlying detail')
    },
  )
})

describe('responseForGuardRefusal', () => {
  it.each([['not-json', 415], ['remote', 403], ['bad-host', 403], ['cross-site', 403]] as const)('maps %s to %i', (reason, status) => {
    const response = responseForGuardRefusal(reason)
    expect(response.status).toBe(status)
    expect(response.body.reason).toBe(reason)
    expect(response.body.error).toMatch(/^[A-Z].*\.$/)
  })
})

describe('parseAnswerBody', () => {
  const FINGERPRINT = '0123456789abcdef'

  it('accepts a session, an option number and a fingerprint', () => {
    expect(parseAnswerBody({ session: 'worker-foo-cr2', option: 3, fingerprint: FINGERPRINT })).toEqual({ session: 'worker-foo-cr2', choice: 3, fingerprint: FINGERPRINT })
  })

  it('accepts cancel', () => {
    expect(parseAnswerBody({ session: 'worker-foo', option: 'cancel', fingerprint: FINGERPRINT })?.choice).toBe('cancel')
  })

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['an array', []],
    ['a missing fingerprint', { session: 'worker-foo', option: 1 }],
    ['an uppercase fingerprint', { session: 'worker-foo', option: 1, fingerprint: FINGERPRINT.toUpperCase() }],
    ['a fingerprint with a suffix', { session: 'worker-foo', option: 1, fingerprint: `${FINGERPRINT}0` }],
    ['option 0', { session: 'worker-foo', option: 0, fingerprint: FINGERPRINT }],
    ['option 10', { session: 'worker-foo', option: 10, fingerprint: FINGERPRINT }],
    ['a fractional option', { session: 'worker-foo', option: 2.5, fingerprint: FINGERPRINT }],
    ['a numeric string option', { session: 'worker-foo', option: '2', fingerprint: FINGERPRINT }],
    ['a key name', { session: 'worker-foo', option: 'Enter', fingerprint: FINGERPRINT }],
    ['a session with a space', { session: 'worker foo', option: 1, fingerprint: FINGERPRINT }],
    ['a session with a shell metacharacter', { session: 'worker;rm', option: 1, fingerprint: FINGERPRINT }],
    ['a non-string session', { session: 7, option: 1, fingerprint: FINGERPRINT }],
  ])('rejects %s', (_label, body) => {
    expect(parseAnswerBody(body)).toBeNull()
  })
})
