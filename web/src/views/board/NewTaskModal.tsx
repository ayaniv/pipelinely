import { useId, useRef, useState } from 'react'
import type { ActionOutcome } from '../../api/actions'
import type { NewTaskRequest } from '../../api/agentActions'
import { CtaArrowIcon } from '../../components/icons'
import { ModalFrame } from '../../components/ModalFrame'
import type { Logger } from '../../log'

// "New task": a prompt and one project, handed to the start action. The
// project list is the board filter's own (the caller passes the same
// `options`), with the first selected. The dialog stays open on a failed
// start, so the prompt isn't lost.

const ERROR_FALLBACK_LABEL = 'failed'
const PROJECT_LABEL = 'Project'

export interface NewTaskModalProps {
  projectOptions: readonly string[]
  onCancel: () => void
  onSubmit: (request: NewTaskRequest) => Promise<ActionOutcome>
  log: Logger
}

export function NewTaskModal({ projectOptions, onCancel, onSubmit, log }: NewTaskModalProps) {
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const projectLabelId = useId()
  const [prompt, setPrompt] = useState('')
  const [pickedProject, setPickedProject] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorLabel, setErrorLabel] = useState<string | null>(null)
  // Synchronous guard against a second submit landing before React re-renders
  // with isSubmitting.
  const isSubmittingRef = useRef(false)

  // The list can change under an open modal (a project leaves the board), so
  // a pick that is no longer offered falls back to the first one.
  const project = pickedProject !== null && projectOptions.includes(pickedProject) ? pickedProject : projectOptions[0] ?? null
  const trimmedPrompt = prompt.trim()
  const canStart = trimmedPrompt !== '' && !isSubmitting

  const start = async () => {
    if (trimmedPrompt === '' || isSubmittingRef.current) return
    isSubmittingRef.current = true
    setIsSubmitting(true)
    setErrorLabel(null)
    try {
      const outcome = await onSubmit({ prompt: trimmedPrompt, project })
      if (!outcome.ok) setErrorLabel(outcome.label)
    } catch (err) {
      log('[agent-action] new task submit threw', err)
      setErrorLabel(ERROR_FALLBACK_LABEL)
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <ModalFrame
      scrimTestId="new-task-scrim"
      cardTestId="new-task-modal"
      labelledBy={titleId}
      onCancel={onCancel}
      initialFocusRef={promptRef}
      cardClassName="new-task-card"
    >
      <div className="confirm-modal-headline" id={titleId}>New task</div>
      <div className="confirm-modal-body">Opens a new Claude session and starts it at Planning.</div>
      <textarea
        ref={promptRef}
        className="new-task-prompt"
        data-testid="new-task-prompt"
        aria-label="Task prompt"
        rows={4}
        placeholder="What should the agent do?"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {projectOptions.length > 0 && (
        <>
          <div className="new-task-label" id={projectLabelId}>{PROJECT_LABEL}</div>
          <div className="filter-chips" role="group" aria-labelledby={projectLabelId} data-testid="new-task-project-group">
            {projectOptions.map((option) => (
              <button
                key={option}
                type="button"
                className={`filter-chip${option === project ? ' is-active' : ''}`}
                aria-pressed={option === project}
                data-testid="new-task-project-chip"
                data-project={option}
                onClick={() => setPickedProject(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </>
      )}
      {errorLabel !== null && <div className="new-task-error" role="alert" data-testid="new-task-error">{errorLabel}</div>}
      <div className="confirm-modal-actions">
        <button className="confirm-modal-cancel-btn" type="button" data-testid="new-task-cancel-btn" onClick={onCancel}>Cancel</button>
        <button className="new-task-start-btn" type="button" data-testid="new-task-start-btn" disabled={!canStart} onClick={start}>
          <span>Start in Claude</span>
          <CtaArrowIcon />
        </button>
      </div>
    </ModalFrame>
  )
}
