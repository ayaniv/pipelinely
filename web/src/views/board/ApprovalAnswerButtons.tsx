import { useId, useState } from 'react'
import { isNothingSent, postAnswerDialog, type AnswerDialogOutcome, type PostActionOptions } from '../../api/actions'
import { ERROR_FLASH_MS, useActionFlash } from '../../components/useActionFlash'
import { useTransientValue } from '../../components/useTransientValue'
import type { ApprovalPrompt } from '../../../../src/approvalPrompt'
import type { DialogChoice } from '../../../../src/answerDialogWire'

// The answer half of the approval callout: the dialog's question and one
// button per option, each naming the key it sends before any click. Nothing is
// sent except by a click. No button is primary and Cancel sits in the same row
// with the same style, so the UI never nudges toward "Yes".
//
// One instance answers one dialog: the parent keys it by the prompt's
// fingerprint, so a result line or a lock can never outlive the dialog it
// belongs to.

interface AnswerOption {
  dataKey: string
  keyCap: string
  label: string
  choice: DialogChoice
}

const CANCEL_OPTION: AnswerOption = { dataKey: 'Escape', keyCap: 'Esc', label: 'Cancel', choice: 'cancel' }

function optionsFor(prompt: ApprovalPrompt): AnswerOption[] {
  const numbered = prompt.options.map((option) => ({ dataKey: String(option.number), keyCap: String(option.number), label: option.label, choice: option.number }))
  return [...numbered, CANCEL_OPTION]
}

export interface ApprovalAnswerButtonsProps extends PostActionOptions {
  slug: string
  prompt: ApprovalPrompt
}

export function ApprovalAnswerButtons({ slug, prompt, fetchImpl, log }: ApprovalAnswerButtonsProps) {
  const questionId = useId()
  const targetId = useId()
  const { isPending, run } = useActionFlash(log)
  const [refusal, showRefusal] = useTransientValue<AnswerDialogOutcome>(ERROR_FLASH_MS)
  // Set once a key went out or may have. Another click on the same dialog
  // would pass the server's fingerprint check and type a second key, so the
  // buttons and the line stay until a different dialog replaces this instance.
  const [lockingResult, setLockingResult] = useState<AnswerDialogOutcome | null>(null)

  if (prompt.options.length === 0) return null

  const isLocked = isPending || lockingResult !== null
  const result = lockingResult ?? refusal

  const answer = (option: AnswerOption) => {
    if (isLocked) return
    void run(async () => {
      const outcome = await postAnswerDialog(slug, { session: prompt.session, option: option.choice, fingerprint: prompt.fingerprint }, { fetchImpl, log })
      if (isNothingSent(outcome.outcome)) showRefusal(outcome)
      else setLockingResult(outcome)
    })
  }

  return (
    <div className="approval-answer" data-testid="card-approval-answer">
      <span className="approval-answer-question" id={questionId} data-testid="card-approval-question">{prompt.question}</span>
      <span id={targetId} hidden>Sends to {prompt.session}</span>
      <div className="approval-answer-options" role="group" aria-labelledby={questionId} data-testid="card-approval-options">
        {optionsFor(prompt).map((option) => (
          <button
            key={option.dataKey}
            type="button"
            className="btn approval-answer-option"
            data-testid="card-approval-option"
            data-key={option.dataKey}
            title={`Sends the key ${option.keyCap} to ${prompt.session}`}
            aria-label={`Send key ${option.keyCap}: ${option.label}`}
            aria-describedby={targetId}
            // aria-disabled, not disabled: a disabled button drops keyboard
            // focus to <body>; the click handler ignores the click instead.
            aria-disabled={isLocked}
            onClick={() => answer(option)}
          >
            <kbd className="approval-answer-key" data-testid="card-approval-option-key">{option.keyCap}</kbd>
            <span className="approval-answer-label" data-testid="card-approval-option-label">{option.label}</span>
          </button>
        ))}
      </div>
      {/* Rendered empty up front: a live region that arrives already holding its text is often not announced. */}
      <div role="status" data-testid="card-approval-status">
        {result && <div className="card-note approval-answer-result" data-testid="card-approval-result" data-outcome={result.outcome}>{result.message}</div>}
      </div>
    </div>
  )
}
