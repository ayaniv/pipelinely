import fs from 'node:fs/promises'
import path from 'node:path'
import { checkMergeReadiness, type MergeBlocker } from './mergeGate.js'
import { deleteRemoteBranch, mergePullRequest, removeWorktreeAndBranch } from './gitOps.js'
import { findPrNumber, reposDir } from './taskParser.js'
import type { Task } from './types.js'

type CompletionTask = Pick<Task, 'slug' | 'repo' | 'branch' | 'worktree' | 'reviewRef' | 'stageHistory' | 'prNumber'>

// Extracted verbatim from POST /mark-done/:slug's own body — that route
// calls this directly, and mergeTask below calls it as its own step 5. It
// never touches the remote: /mark-done has no proof a branch was ever
// merged, only mergeTask does, because GitHub just said so.
export async function markTaskDone(tasksDir: string, task: CompletionTask): Promise<{ cleanupError: string | null }> {
  await fs.writeFile(path.join(tasksDir, task.slug, 'STATUS'), 'done\n')

  let cleanupError: string | null = null
  if (task.worktree) {
    const repoPath = path.join(reposDir(), task.repo)
    const result = await removeWorktreeAndBranch(repoPath, task.worktree, task.branch)
    if (!result.ok) cleanupError = result.error
  }
  return { cleanupError }
}

export type MergeTaskOutcome =
  | { outcome: 'no-pr' }
  | { outcome: 'gate-unavailable'; error: string }
  | { outcome: 'blocked'; prNumber: string; blockers: MergeBlocker[] }
  | { outcome: 'merge-failed'; prNumber: string; error: string }
  | { outcome: 'merged'; prNumber: string; cleanupError: string | null }

// Gate → merge → finish, in that order, each step running only if the
// previous one succeeded — see the module comment on ordering guarantees
// below. Never throws for an expected outcome (no-pr, gate-unavailable,
// blocked, merge-failed); it only throws if recording an ALREADY-SUCCESSFUL
// merge fails, because that can't be reported as "not merged" — see the
// throw below.
export async function mergeTask(tasksDir: string, task: CompletionTask): Promise<MergeTaskOutcome> {
  const prNumber = findPrNumber(task)
  if (!prNumber) return { outcome: 'no-pr' }

  const repoPath = path.join(reposDir(), task.repo)
  const gate = await checkMergeReadiness(repoPath, prNumber)
  if (!gate.ok) return { outcome: 'gate-unavailable', error: gate.error }
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
    const { cleanupError: localCleanupError } = await markTaskDone(tasksDir, task)

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
    return { outcome: 'merged', prNumber, cleanupError }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`PR #${prNumber} for ${task.slug} WAS merged, but recording it failed:`, err)
    throw new Error(`PR #${prNumber} WAS merged, but recording it failed: ${message}`)
  }
}
