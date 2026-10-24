import path from 'node:path'
import type { BranchPr } from './gitOps.js'
import { findPrNumber, parsePrNumberFromReviewRef, reposDir } from './taskParser.js'
import { createTtlCache, readThrough, type TtlCache } from './ttlCache.js'
import type { PrMergeState, Stage, Task } from './types.js'

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

export type PrNumberCache = TtlCache<string | null>

export function createPrNumberCache(): PrNumberCache {
  return createTtlCache()
}

async function askGitHub(task: Task, lookup: PrNumberLookup): Promise<{ value: string | null; ttlMs: number }> {
  let found: BranchPr | null = null
  try {
    found = await lookup(task.repo, task.branch)
  } catch (err) {
    console.error(`Failed to resolve the PR for ${task.slug} (${task.branch}):`, err)
  }
  return { value: found?.prNumber ?? null, ttlMs: found?.isOpen ? OPEN_PR_TTL_MS : UNSETTLED_PR_TTL_MS }
}

async function lookUpBranchPrNumber(task: Task, lookup: PrNumberLookup, cache: PrNumberCache, now: () => number): Promise<string | null> {
  const isLegacyReviewRefAuthoritative = !!parsePrNumberFromReviewRef(task.reviewRef)
  const shouldAskGitHub = STAGES_WITH_OPEN_PR.has(task.stage) && !!task.branch && !isLegacyReviewRefAuthoritative
  if (!shouldAskGitHub) return null
  return readThrough(cache, `${task.repo}#${task.branch}`, now, () => askGitHub(task, lookup))
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
  const resolved = await Promise.all(
    tasks.map(async (task) => {
      const branchPrNumber = await lookUpBranchPrNumber(task, lookup, cache, now)
      const prNumber = findPrNumber(branchPrNumber ? { ...task, prNumber: branchPrNumber } : task)
      return prNumber ? { ...task, prNumber } : task
    }),
  )
  return relinkMilestoneChildren(resolved)
}

// parseAllTasks stitches each dispatched milestone child onto its parent as
// the very same object as the top-level task. The attach steps here copy a
// task to add a field, which would leave the parent pointing at the stale,
// pre-resolution child — so a milestone card would read no PR number and no
// merge state. Re-point each milestone at the resolved top-level copy.
function relinkMilestoneChildren(tasks: Task[]): Task[] {
  const bySlug = new Map(tasks.map((task) => [task.slug, task]))
  return tasks.map((task) => {
    if (!task.milestones?.some((milestone) => milestone.task)) return task
    const milestones = task.milestones.map((milestone) => {
      const resolvedChild = milestone.task ? bySlug.get(milestone.task.slug) : undefined
      return resolvedChild ? { ...milestone, task: resolvedChild } : milestone
    })
    return { ...task, milestones }
  })
}

// The production lookup: `gh` run from the task's repo checkout.
export function repoPrNumberLookup(
  findByBranch: (repoPath: string, branch: string) => Promise<BranchPr | null>,
  tasksDir: string,
): PrNumberLookup {
  return (repo, branch) => findByBranch(path.join(reposDir(tasksDir), repo), branch)
}

// Asks whether a task's open PR can merge: null when that PR is not open (see
// mergeGate.ts's readPrMergeState, the production implementation).
export type PrMergeStateLookup = (repo: string, prNumber: string, branch: string) => Promise<PrMergeState | null>

export type PrMergeStateCache = TtlCache<PrMergeState | null>

export function createPrMergeStateCache(): PrMergeStateCache {
  return createTtlCache()
}

const DEFAULT_PR_MERGE_STATE_TTL_MS = 60_000

// Short on purpose: a conflict appears when another PR merges and clears when
// the fix is pushed, and the card should follow both within a refresh or two.
// Read lazily so the e2e server (fakeGhEnv) can shorten it, the same
// precedent as COCKPIT_MERGEABILITY_RETRY_DELAY_MS.
export function prMergeStateTtlMs(): number {
  const override = process.env.COCKPIT_PR_MERGE_STATE_TTL_MS
  if (override === undefined) return DEFAULT_PR_MERGE_STATE_TTL_MS
  const parsed = Number(override)
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  console.error(`Ignoring COCKPIT_PR_MERGE_STATE_TTL_MS=${override}: not a non-negative number of milliseconds`)
  return DEFAULT_PR_MERGE_STATE_TTL_MS
}

const STATUSES_WITHOUT_MERGE_STATE: ReadonlySet<Task['status']> = new Set<Task['status']>(['done', 'shelved'])

async function lookUpPrMergeState(task: Task, prNumber: string, lookup: PrMergeStateLookup): Promise<{ value: PrMergeState | null; ttlMs: number }> {
  let state: PrMergeState | null
  try {
    state = await lookup(task.repo, prNumber, task.branch)
  } catch (err) {
    console.error(`Failed to read the merge state of PR #${prNumber} for ${task.slug}:`, err)
    state = 'unknown'
  }
  return { value: state, ttlMs: prMergeStateTtlMs() }
}

// Runs after attachResolvedPrNumbers, on the PR number it settled on — so this
// adds no second way of finding a task's PR. Only an in-flight task with a PR
// is asked about; a merged/closed PR leaves the field off.
export async function attachPrMergeStates(
  tasks: Task[],
  lookup: PrMergeStateLookup,
  cache: PrMergeStateCache,
  now: () => number = Date.now,
): Promise<Task[]> {
  const resolved = await Promise.all(
    tasks.map(async (task) => {
      const prNumber = findPrNumber(task)
      if (!prNumber || STATUSES_WITHOUT_MERGE_STATE.has(task.status)) return task
      const prMergeState = await readThrough(cache, `${task.repo}#${prNumber}#${task.branch}`, now, () => lookUpPrMergeState(task, prNumber, lookup))
      return prMergeState ? { ...task, prMergeState } : task
    }),
  )
  return relinkMilestoneChildren(resolved)
}

// The production lookup: `gh` run from the task's repo checkout.
export function repoPrMergeStateLookup(
  readMergeState: (repoPath: string, prNumber: string, branch: string) => Promise<PrMergeState | null>,
  tasksDir: string,
): PrMergeStateLookup {
  return (repo, prNumber, branch) => readMergeState(path.join(reposDir(tasksDir), repo), prNumber, branch)
}
