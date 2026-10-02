import { useState } from 'react'
import { postBacklogEdit } from '../../api/backlogActions'
import type { PostActionOptions } from '../../api/actions'
import type { BacklogItem } from '../../../../src/types'

// The inline edit form a backlog row swaps to. Its draft is component state
// seeded once from `original`, so an SSE refresh that re-renders the list
// underneath an open form can never discard what is being typed. `original`
// is also the concurrency guard posted back with the save: the server
// refuses (409) when the line at this index is no longer that item.

export interface BacklogEditFormProps extends PostActionOptions {
  index: number
  original: BacklogItem
  projectOptions: string[]
  onDone: () => void
}

export function BacklogEditForm({ index, original, projectOptions, onDone, fetchImpl, log }: BacklogEditFormProps) {
  const [description, setDescription] = useState(original.description)
  const [project, setProject] = useState(original.project ?? '')
  const [context, setContext] = useState(original.context ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const save = async () => {
    const trimmedDescription = description.trim()
    if (!trimmedDescription) {
      setErrorMessage('Description cannot be empty.')
      return
    }
    setErrorMessage(null)
    setIsSaving(true)
    const outcome = await postBacklogEdit(index, {
      description: trimmedDescription,
      // Date isn't editable from this form — pass the original through
      // unchanged rather than letting an edit touch it.
      date: original.date,
      context: context.trim() || null,
      project: project.trim() || null,
      original,
    }, { fetchImpl, log })
    if (outcome.ok) {
      onDone()
      return
    }
    setErrorMessage(outcome.message)
    setIsSaving(false)
  }

  return (
    <div className="backlog-edit-form" data-testid="backlog-edit-form">
      <input type="text" className="weekly-focus-input" data-testid="backlog-edit-desc-input" value={description} onChange={(event) => setDescription(event.target.value)} />
      <input
        type="text" className="weekly-focus-input" data-testid="backlog-edit-project-input" list="backlog-project-options"
        placeholder="project (optional)" value={project} onChange={(event) => setProject(event.target.value)}
      />
      <datalist id="backlog-project-options">
        {projectOptions.map((option) => <option key={option} value={option} />)}
      </datalist>
      <textarea className="weekly-focus-input" data-testid="backlog-edit-context-input" placeholder="context (optional)" rows={2} value={context} onChange={(event) => setContext(event.target.value)} />
      <div className="backlog-edit-error" data-testid="backlog-edit-error" hidden={errorMessage === null}>{errorMessage}</div>
      <div className="card-actions">
        <button type="button" className="btn" data-testid="backlog-edit-cancel-btn" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-primary" data-testid="backlog-edit-save-btn" disabled={isSaving} onClick={save}>Save</button>
      </div>
    </div>
  )
}
