import { useCallback, useState } from 'react'
import type { ActionOutcome } from '../../api/actions'
import { startTaskInClaude, type AgentActionOptions, type NewTaskRequest } from '../../api/agentActions'
import { PlusIcon } from '../../components/icons'
import type { Logger } from '../../log'
import { NewTaskModal } from './NewTaskModal'

// The toolbar's "+ New task": owns whether its modal is open. The modal is
// mounted only while open, so a reopened one starts empty.

export interface NewTaskPillProps {
  projectOptions: readonly string[]
  startTask?: (request: NewTaskRequest, options: AgentActionOptions) => Promise<ActionOutcome>
  log?: Logger
}

export function NewTaskPill({ projectOptions, startTask = startTaskInClaude, log = console.error }: NewTaskPillProps) {
  const [isOpen, setIsOpen] = useState(false)
  const close = useCallback(() => setIsOpen(false), [])

  const submit = useCallback(async (request: NewTaskRequest) => {
    const outcome = await startTask(request, { log })
    if (outcome.ok) close()
    return outcome
  }, [startTask, log, close])

  return (
    <>
      <button className="toolbar-pill new-task-pill" type="button" title="Start a new task in Claude" data-testid="new-task-pill" onClick={() => setIsOpen(true)}>
        <PlusIcon />
        <span>New task</span>
      </button>
      {isOpen && <NewTaskModal projectOptions={projectOptions} onCancel={close} onSubmit={submit} log={log} />}
    </>
  )
}
