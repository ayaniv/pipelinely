import path from 'node:path'
import type { BranchPr } from './gitOps.js'
import { findPrNumber, parsePrNumberFromReviewRef, reposDir } from './taskParser.js'
import type { Stage, Task } from './types.js'

// A PR can only exist once dev has opened one, so earlier stages (and a
// finished task, whose stage is null) never need a GitHub round trip. That
// includes a task sent back to `dev` for rework: it deliberately relies on the
// strict note match in findPrNumber, not a lookup, until it reaches
// code-review again.
const STAGES_WITH_OPEN_PR: ReadonlySet<Stage | null> = new Set<Stage>([
  'code-review',
  'comment-fix',
  'qa',
  'qa-fixes',
  'merge',
])

export type PrNumberLookup = (repo: string, branch: string) => Promise<BranchPr | null>

// Bounds the gh cost of refreshTasks(), which runs on every watcher write and
// every 5 minutes. Every answer is remembered for a while — an OPEN PR longer,
// a miss / gh failure / merged-or-closed-only result briefly — so an offline
// or rate-limited gh doesn't fire a `gh pr list` per task per write, while a
// PR opened (or replaced) later is still picked up soon.
const OPEN_PR_TTL_MS = 10 * 60_000
const UNSETTLED_PR_TTL_MS = 60_000

interface CachedLookup {
  prNumber: string | null
  expiresAt: number
}

export interface PrNumberCache {
  entries: Map<string, CachedLookup>
  // Two tasks (or two overlapping refreshes) asking about one repo#branch share
  // a single gh call.
  inFlight: Map<string, Promise<string | null>>
}

export function createPrNumberCache(): PrNumberCache {
  return { entries: new Map(), inFlight: new Map() }
}

async function askGitHub(task: Task, lookup: PrNumberLookup, cache: PrNumberCache, now: () => number): Promise<string | null> {
  const cacheKey = `${task.repo}#${task.branch}`
  let found: BranchPr | null = null
  try {
    found = await lookup(task.repo, task.branch)
  } catch (err) {
    console.error(`Failed to resolve the PR for ${task.slug} (${task.branch}):`, err)
  }
  const ttlMs = found?.isOpen ? OPEN_PR_TTL_MS : UNSETTLED_PR_TTL_MS
  cache.entries.set(cacheKey, { prNumber: found?.prNumber ?? null, expiresAt: now() + ttlMs })
  return found?.prNumber ?? null
}

async function lookUpBranchPrNumber(task: Task, lookup: PrNumberLookup, cache: PrNumberCache, now: () => number): Promise<string | null> {
  const isLegacyReviewRefAuthoritative = !!parsePrNumberFromReviewRef(task.reviewRef)
  const shouldAskGitHub = STAGES_WITH_OPEN_PR.has(task.stage) && !!task.branch && !isLegacyReviewRefAuthoritative
  if (!shouldAskGitHub) return null

  const cacheKey = `${task.repo}#${task.branch}`
  const cached = cache.entries.get(cacheKey)
  if (cached && cached.expiresAt > now()) return cached.prNumber

  const pending = cache.inFlight.get(cacheKey) ?? askGitHub(task, lookup, cache, now).finally(() => cache.inFlight.delete(cacheKey))
  cache.inFlight.set(cacheKey, pending)
  return pending
}

// The TIMELINE's dev note is free text: it often carries no PR number, and
// when it carries one it may be a merged upstream PR the worker mentioned in
// passing (react-migration-m3/m4/m6 all pointed at #119). GitHub is the
// source of truth for which PR a branch has, so ask it for every post-dev
// task; findPrNumber then folds in reviewRef / a strict note match for
// whatever GitHub couldn't answer, so `prNumber` is the one final answer every
// client reads (see web/src/taskScope.ts).
export async function attachResolvedPrNumbers(
  tasks: Task[],
  lookup: PrNumberLookup,
  cache: PrNumberCache,
  now: () => number = Date.now,
): Promise<Task[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const branchPrNumber = await lookUpBranchPrNumber(task, lookup, cache, now)
      const prNumber = findPrNumber(branchPrNumber ? { ...task, prNumber: branchPrNumber } : task)
      return prNumber ? { ...task, prNumber } : task
    }),
  )
}

// The production lookup: `gh` run from the task's repo checkout.
export function repoPrNumberLookup(
  findByBranch: (repoPath: string, branch: string) => Promise<BranchPr | null>,
  tasksDir: string,
): PrNumberLookup {
  return (repo, branch) => findByBranch(path.join(reposDir(tasksDir), repo), branch)
}
