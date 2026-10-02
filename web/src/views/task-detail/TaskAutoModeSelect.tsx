import type { Task } from '../../../../src/types'
import { postTaskAutoMode, type PostActionOptions } from '../../api/actions'

// This task's own auto-mode override. The 'inherit' option's label names what
// it currently resolves to, from the global switch, so the developer never has
// to hold that state in their head.

export interface TaskAutoModeSelectProps extends Partial<PostActionOptions> {
  task: Pick<Task, 'slug' | 'autoModeOverride'>
  isGlobalAutoMode: boolean
}

export function TaskAutoModeSelect({ task, isGlobalAutoMode, fetchImpl = fetch, log = console.error }: TaskAutoModeSelectProps) {
  const options = [
    { value: 'auto', label: 'Auto' },
    { value: 'manual', label: 'Manual' },
    { value: 'inherit', label: `Default (${isGlobalAutoMode ? 'auto' : 'manual'})` },
  ]
  return (
    // Uncontrolled, re-keyed on the stored value: the developer's pick stays
    // put until the snapshot confirms it, and a change from elsewhere (another
    // tab, the file on disk) replaces it.
    <select
      key={task.autoModeOverride}
      className="btn"
      data-testid="task-auto-mode"
      defaultValue={task.autoModeOverride}
      onChange={(event) => { void postTaskAutoMode(task.slug, event.target.value, { fetchImpl, log }) }}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}
