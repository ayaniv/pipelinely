import path from 'node:path'
import { findPrNumber, reposDir } from './taskParser.js'
import type { Stage, Task } from './types.js'

// A PR can only exist once dev has opened one, so earlier stages (and a
// finished task, whose stage is null) never need a GitHub round trip.
const STAGES_WITH_OPEN_PR: ReadonlySet<Stage | null> = new Set<Stage>([
  'code-review',
  'comment-fix',
  'qa',
  'qa-fixes',
  'merge',
])

export type PrNumberLookup = (repo: string, branch: string) => Promise<string | null>

// repo+branch -> PR number, for hits only. A miss is deliberately not
// remembered: the PR may simply not be open yet, and the next refresh should
// ask again.
export type PrNumberCache = Map<string, string>

export function createPrNumberCache(): PrNumberCache {
  return new Map()
}

// The TIMELINE's dev note is free text ("PR opened: <title>") and often
// carries no number, which left findPrNumber null and hid both the PR link
// and the Merge button (fix-header-ctx-progress-bar). GitHub is the source of
// truth for which PR a branch has, so ask it for exactly those tasks.
export async function attachResolvedPrNumbers(
  tasks: Task[],
  lookup: PrNumberLookup,
  cache: PrNumberCache,
): Promise<Task[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const needsLookup = STAGES_WITH_OPEN_PR.has(task.stage) && !!task.branch && !findPrNumber(task)
      if (!needsLookup) return task

      const cacheKey = `${task.repo}#${task.branch}`
      const prNumber = cache.get(cacheKey) ?? (await lookup(task.repo, task.branch))
      if (!prNumber) return task

      cache.set(cacheKey, prNumber)
      return { ...task, prNumber }
    }),
  )
}

// The production lookup: `gh` run from the task's repo checkout.
export function repoPrNumberLookup(
  findByBranch: (repoPath: string, branch: string) => Promise<string | null>,
): PrNumberLookup {
  return (repo, branch) => findByBranch(path.join(reposDir(), repo), branch)
}
