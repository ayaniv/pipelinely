import type { Task } from '../../../src/types'
import { clientState, type ClientState } from '../data/clientState'
import type { Logger } from '../log'
import { findPrNumber } from '../taskScope'
import { postMergePr, type PostActionOptions } from './actions'

export interface MergeOutcome {
  merged: boolean
  cleanupError: string | null
}

export interface MergeDeps extends Partial<PostActionOptions> {
  log?: Logger
  // A destructive action against a shared remote, so it always confirms first.
  confirm?: (message: string) => boolean
  state?: ClientState
}

const NOT_MERGED: MergeOutcome = { merged: false, cleanupError: null }

function confirmationMessage(task: Task): string {
  let message = `Merge PR #${findPrNumber(task)} for "${task.title || task.slug}" and mark it done? This also deletes its branch on GitHub.`
  if (task.worktree) message += ` It also deletes its worktree and local branch (${task.branch}).`
  return message
}

// The one merge action, shared by the board card's merge footer and the Merge
// tab's button: the real preflight-gated POST /merge-pr/:slug, with its
// in-flight flag and persistent failure banner kept in the shared client
// state (not on the button) so a re-render can neither erase the disabled
// state nor lose a multi-line blocker list. Takes the task, not a button
// reference, for the same reason: holding a button across the request is never
// safe. Returns { merged, cleanupError } so a caller can decide whether to
// close the detail view without re-issuing the request.
export async function mergeTask(
  task: Task,
  { fetchImpl = fetch, log = console.error, confirm = (message) => window.confirm(message), state = clientState }: MergeDeps = {},
): Promise<MergeOutcome> {
  if (state.getMergeState(task.slug).isInFlight) return NOT_MERGED
  if (!confirm(confirmationMessage(task))) return NOT_MERGED

  state.beginMerge(task.slug)
  let banner = null
  try {
    const outcome = await postMergePr(task.slug, { fetchImpl, log })
    banner = outcome.banner
    return { merged: outcome.merged, cleanupError: outcome.cleanupError }
  } finally {
    // finally, not a trailing statement: a throw above must not strand the
    // button disabled forever.
    state.settleMerge(task.slug, banner)
  }
}
