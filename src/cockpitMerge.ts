import { findPrByBranch } from './gitOps.js'
import { formatBranchMismatch, formatMergeBlockers } from './mergeGate.js'
import { attachResolvedPrNumbers, createPrNumberCache, repoPrNumberLookup, type PrNumberLookup } from './prLookup.js'
import { mergeTask, type MergeTaskOutcome } from './taskCompletion.js'
import type { Task } from './types.js'

// parseTask alone carries no branch-derived PR; resolve it from GitHub the
// same way the dashboard does, so the CLI can't merge a note-scraped PR.
export async function mergeResolvingPr(
  tasksDir: string,
  task: Task,
  lookup: PrNumberLookup = repoPrNumberLookup(findPrByBranch, tasksDir),
): Promise<MergeTaskOutcome> {
  const [resolvedTask] = await attachResolvedPrNumbers([task], lookup, createPrNumberCache())
  return mergeTask(tasksDir, resolvedTask)
}

export interface MergeCliReport {
  exitCode: number
  lines: Array<{ stream: 'log' | 'error'; text: string }>
}

// Exit codes let the pipelinely-merge skill tell "gate refused" (2) apart from
// "something broke" (1) without parsing stdout text.
export function describeMergeOutcome(result: MergeTaskOutcome): MergeCliReport {
  switch (result.outcome) {
    case 'no-pr':
      return { exitCode: 1, lines: [{ stream: 'error', text: 'No PR recorded for this task yet' }] }
    case 'gate-unavailable':
    case 'merge-failed':
      return { exitCode: 1, lines: [{ stream: 'error', text: result.error }] }
    case 'blocked':
      return { exitCode: 2, lines: [{ stream: 'error', text: formatMergeBlockers(result.blockers) }] }
    case 'branch-mismatch':
      return { exitCode: 2, lines: [{ stream: 'error', text: formatBranchMismatch(result) }] }
    case 'merged': {
      const lines: MergeCliReport['lines'] = [{ stream: 'log', text: `PR #${result.prNumber} merged, task marked done` }]
      if (result.cleanupError) lines.push({ stream: 'error', text: `cleanup: ${result.cleanupError}` })
      return { exitCode: 0, lines }
    }
  }
}
