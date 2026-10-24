import fs from 'node:fs/promises'
import path from 'node:path'
import { designApprovalBlocker } from './designApproval.js'
import { MERGED_FOR_ADOPT_MARKER } from './nextStageCta.js'
import { checkMergeReadiness, type MergeBlocker } from './mergeGate.js'
import { deleteRemoteBranch, mergePullRequest, removeWorktreeAndBranch } from './gitOps.js'
import { retireSessionsOfTask, type RetirementResult } from './retireTaskSessions.js'
import { findPrNumber, reposDir } from './taskParser.js'
import type { Task } from './types.js'

type CompletionTask = Pick<Task, 'slug' | 'repo' | 'branch' | 'worktree' | 'reviewRef' | 'stageHistory' | 'prNumber' | 'kind' | 'status' | 'waitingReason'> & { tmuxSession?: Task['tmuxSession'] }

// Extracted verbatim from POST /mark-done/:slug's own body — that route
// calls this directly, and mergeTask below calls it as its own step 5. It
// never touches the remote: /mark-done has no proof a branch was ever
// merged, only mergeTask does, because GitHub just said so.
//
// It is also the one place a finished task's tmux sessions are retired, so
// the Merge button, `pipelinely-merge` and Mark done all get it exactly once. A
// refused worktree cleanup does not skip it: the task is finished with its
// worktree either way.
//
// finalStatus is what STATUS ends up as: `done` for everything but a merged ds
// task, which hands off to adopt instead (see mergeTask).
export async function markTaskDone(
  tasksDir: string,
  task: CompletionTask,
  finalStatus = 'done',
): Promise<{ cleanupError: string | null; sessions: RetirementResult }> {
  await fs.writeFile(path.join(tasksDir, task.slug, 'STATUS'), `${finalStatus}\n`)

  let cleanupError: string | null = null
  if (task.worktree) {
    const repoPath = path.join(reposDir(tasksDir), task.repo)
    const result = await removeWorktreeAndBranch(repoPath, task.worktree, task.branch)
    if (!result.ok) cleanupError = result.error
  }
  const sessions = await retireSessionsOfTask(tasksDir, { slug: task.slug, tmuxSession: task.tmuxSession })
  return { cleanupError, sessions }
}

// Adopt is the ds pipeline's last stage and it is the one that marks the task
// done, so a merged ds task waits there rather than finishing.
function finalStatusAfterMerge(task: Pick<Task, 'kind'>): string {
  return task.kind === 'ds' ? `waiting: ${MERGED_FOR_ADOPT_MARKER}` : 'done'
}

export type MergeTaskOutcome =
  | { outcome: 'no-pr' }
  | { outcome: 'gate-unavailable'; error: string }
  | { outcome: 'blocked'; prNumber: string; blockers: MergeBlocker[] }
  | { outcome: 'branch-mismatch'; prNumber: string; expectedBranch: string; actualBranch: string }
  | { outcome: 'merge-failed'; prNumber: string; error: string }
  | { outcome: 'merged'; prNumber: string; cleanupError: string | null; sessions: RetirementResult }

// Gate → merge → finish, in that order, each step running only if the
// previous one succeeded — see the module comment on ordering guarantees
// below. Never throws for an expected outcome (no-pr, gate-unavailable,
// blocked, merge-failed); it only throws if recording an ALREADY-SUCCESSFUL
// merge fails, because that can't be reported as "not merged" — see the
// throw below.
export async function mergeTask(tasksDir: string, task: CompletionTask): Promise<MergeTaskOutcome> {
  const prNumber = findPrNumber(task)
  if (!prNumber) return { outcome: 'no-pr' }

  // Needs no gh call, so it runs first: a ds task is never merged — by the
  // Merge button or /pipelinely-merge, which both come through here — before the
  // designer has approved.
  const approvalBlocker = designApprovalBlocker(task)
  if (approvalBlocker) return { outcome: 'blocked', prNumber, blockers: [approvalBlocker] }

  const repoPath = path.join(reposDir(tasksDir), task.repo)
  const gate = await checkMergeReadiness(repoPath, prNumber)
  if (!gate.ok) return { outcome: 'gate-unavailable', error: gate.error }

  // Last line of defence against a mis-resolved PR number, checked BEFORE the
  // gate's own blockers: --match-head-commit pins the SHA but not whose branch
  // it is, so an open + green PR belonging to a different task would otherwise
  // be merged, and a wrong PR that is MERGED must say "wrong PR", not the
  // misleading "PR is not open".
  const actualBranch = gate.readiness.headRefName
  if (actualBranch && actualBranch !== task.branch) {
    return { outcome: 'branch-mismatch', prNumber, expectedBranch: task.branch, actualBranch }
  }
  if (!gate.readiness.ready) return { outcome: 'blocked', prNumber, blockers: gate.readiness.blockers }

  const { headSha, headRefName, isCrossRepository } = gate.readiness
  const mergeResult = await mergePullRequest(repoPath, prNumber, headSha)
  if (!mergeResult.ok) return { outcome: 'merge-failed', prNumber, error: mergeResult.error }

  // Nothing local was written before this point — a refused or failed merge
  // above leaves STATUS/TIMELINE/worktree/remote branch untouched. Past this
  // point the merge is real and irreversible, so a failure recording it
  // can't be reported as "not merged" (see the catch below).
  try {
    await fs.appendFile(
      path.join(tasksDir, task.slug, 'TIMELINE'),
      `${new Date().toISOString()} merge merged PR #${prNumber}\n`,
    )
    const { cleanupError: localCleanupError, sessions } = await markTaskDone(tasksDir, task, finalStatusAfterMerge(task))

    // The remote head is exactly the commit GitHub just merged (the
    // --match-head-commit pin above), so deleting it can't lose anything a
    // dirty or refused local cleanup is protecting — it runs regardless of
    // step 5's own outcome. Local-before-remote: `git branch -d` (inside
    // markTaskDone) only succeeds through the "merged into its upstream"
    // check, which reads the local refs/remotes/origin/<branch> — the
    // remote DELETE doesn't touch that ref, but a `git fetch --prune`
    // between the two could, so local goes first.
    let remoteCleanupError: string | null = null
    if (!isCrossRepository) {
      const remoteResult = await deleteRemoteBranch(repoPath, headRefName)
      if (!remoteResult.ok) remoteCleanupError = remoteResult.error
    }

    const cleanupError = [localCleanupError, remoteCleanupError].filter((e): e is string => e !== null).join('; ') || null
    return { outcome: 'merged', prNumber, cleanupError, sessions }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`PR #${prNumber} for ${task.slug} WAS merged, but recording it failed:`, err)
    throw new Error(`PR #${prNumber} WAS merged, but recording it failed: ${message}`)
  }
}
