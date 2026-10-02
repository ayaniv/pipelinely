import type { Task } from '../../../src/types'
import { postMarkDone, type MarkDoneOutcome, type PostActionOptions } from '../api/actions'

// Mark-as-done, shared by the card menu and the Merge stage panel: a task
// with a worktree gets a confirm first (the server deletes the worktree and
// branch), and declining sends nothing. Resolves undefined when declined, so
// callers only flash and only close the detail view on a real outcome.
export async function markTaskDone(
  task: Pick<Task, 'slug' | 'title' | 'worktree' | 'branch'>,
  options: PostActionOptions,
): Promise<MarkDoneOutcome | undefined> {
  if (task.worktree) {
    const proceed = window.confirm(
      `Mark "${task.title || task.slug}" done and delete its worktree and branch (${task.branch})? This cannot be undone.`,
    )
    if (!proceed) return undefined
  }
  return postMarkDone(task.slug, options)
}
