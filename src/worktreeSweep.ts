import path from 'node:path'
import { execa } from 'execa'
import { removeWorktreeAndBranch, resolveBaseRef, type GitOpResult } from './gitOps.js'
import { taskSessionNames } from './retireTaskSessions.js'
import { parseAllTasks, reposDir } from './taskParser.js'
import type { Task } from './types.js'

export type SweepVerdict = 'safe' | 'needs-developer'

export interface SweepEntry {
  slug: string
  repo: string
  repoPath: string
  worktree: string
  branch: string
  hasUncommittedWork: boolean
  isMerged: boolean
  // Report-only: the sweep never kills a session (merge/mark-done retire them, see retireTaskSessions.ts).
  tmuxSessions: string[]
  sizeBytes: number | null
  verdict: SweepVerdict
  // Why the entry is not safe; empty exactly when verdict is 'safe'.
  reasons: string[]
}

export interface SweepDeps {
  listTmuxSessions: () => Promise<string[]>
  measureSize: (dir: string) => Promise<number | null>
  removeWorktreeAndBranch?: (repoPath: string, worktreePath: string, branch: string) => Promise<GitOpResult>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Read-only. tmux exits non-zero when no server is running, which just means
// "no sessions" — anything else is logged so a broken tmux isn't mistaken for
// "none survive".
async function listTmuxSessions(): Promise<string[]> {
  const result = await execa('tmux', ['list-sessions', '-F', '#{session_name}'], { reject: false })
  if (result.exitCode === 0) return result.stdout.split('\n').filter(Boolean)
  const stderr = String(result.stderr ?? '')
  if (!/no server running|no sessions|error connecting/i.test(stderr)) {
    console.error(`worktree-sweep: tmux list-sessions failed, reporting no sessions: ${stderr || result.shortMessage}`)
  }
  return []
}

async function measureSize(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execa('du', ['-sk', dir])
    return Number.parseInt(stdout, 10) * 1024
  } catch (err) {
    console.error(`worktree-sweep: could not measure ${dir}:`, err)
    return null
  }
}

export const defaultSweepDeps: SweepDeps = { listTmuxSessions, measureSize }

// Gitignored dirs a build or install recreates; losing them costs time, not work.
const REGENERABLE_DIRS = new Set(['node_modules', 'dist'])
const MAX_LISTED_IGNORED_PATHS = 5

function isRegenerable(ignoredPath: string): boolean {
  return ignoredPath.split('/').some((segment) => REGENERABLE_DIRS.has(segment))
}

// 0 = ancestor, 1 = not; anything else is git failing, not an answer.
async function isAncestor(cwd: string, commit: string, ref: string): Promise<boolean> {
  const ancestry = await execa('git', ['merge-base', '--is-ancestor', commit, ref], { cwd, reject: false })
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) throw new Error(String(ancestry.stderr || ancestry.shortMessage))
  return ancestry.exitCode === 0
}

// What `git branch -d` compares against: the branch's upstream if it resolves,
// else the main checkout's HEAD. Checked up front so a worktree is never
// removed only to have its branch kept and the result reported as failed.
async function branchDeleteRef(repoPath: string, branch: string): Promise<string> {
  const upstream = await execa('git', ['rev-parse', '--verify', '--quiet', `${branch}@{upstream}`], { cwd: repoPath, reject: false })
  return upstream.exitCode === 0 ? `${branch}@{upstream}` : 'HEAD'
}

async function readGitState(
  repoPath: string,
  worktree: string,
  branch: string,
): Promise<{ hasUncommittedWork: boolean; isMerged: boolean; reasons: string[] }> {
  const reasons: string[] = []
  try {
    // --ignored: a non-forced `git worktree remove` deletes gitignored files
    // (.env.local, notes, a local db) without asking, so they count as work.
    const { stdout } = await execa('git', ['status', '--porcelain', '--ignored'], { cwd: worktree })
    const statusLines = stdout.split('\n').filter(Boolean)
    const hasUncommittedWork = statusLines.some((line) => !line.startsWith('!! '))
    if (hasUncommittedWork) reasons.push('uncommitted or untracked files')
    const ignoredPaths = statusLines.filter((line) => line.startsWith('!! ')).map((line) => line.slice(3)).filter((p) => !isRegenerable(p))
    if (ignoredPaths.length > 0) {
      const listed = ignoredPaths.slice(0, MAX_LISTED_IGNORED_PATHS).join(', ')
      const more = ignoredPaths.length > MAX_LISTED_IGNORED_PATHS ? ` and ${ignoredPaths.length - MAX_LISTED_IGNORED_PATHS} more` : ''
      reasons.push(`gitignored files that removal would delete: ${listed}${more}`)
    }

    // The worktree's own HEAD, not just the recorded branch: commits made on a
    // detached HEAD or another branch would be orphaned by the removal.
    const head = await execa('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: worktree, reject: false })
    if (head.stdout.trim() !== `refs/heads/${branch}`) reasons.push(`worktree HEAD is not on the task branch ${branch}`)

    const baseRef = await resolveBaseRef(worktree)
    if (!baseRef) {
      reasons.push('no base ref (master/main) to check the branch against')
      return { hasUncommittedWork, isMerged: false, reasons }
    }
    const isMerged = await isAncestor(repoPath, branch, baseRef)
    if (!isMerged) {
      reasons.push('branch is not merged into the base')
      return { hasUncommittedWork, isMerged, reasons }
    }
    const deleteRef = await branchDeleteRef(repoPath, branch)
    if (!(await isAncestor(repoPath, branch, deleteRef))) {
      reasons.push(`git branch -d would refuse: branch is not merged into ${deleteRef === 'HEAD' ? "the main checkout's HEAD (update it first)" : 'its upstream'}`)
    }
    return { hasUncommittedWork, isMerged, reasons }
  } catch (err) {
    console.error(`worktree-sweep: could not read git state of ${worktree}:`, err)
    return { hasUncommittedWork: false, isMerged: false, reasons: [`could not read git state: ${errorMessage(err)}`] }
  }
}

async function buildEntry(task: Task, tasksDir: string, tmuxSessions: string[], deps: SweepDeps): Promise<SweepEntry> {
  const worktree = task.worktree as string
  const repoPath = path.join(reposDir(tasksDir), task.repo)
  const [gitState, sizeBytes] = await Promise.all([
    task.branch ? readGitState(repoPath, worktree, task.branch) : Promise.resolve(null),
    deps.measureSize(worktree),
  ])
  const reasons = gitState ? gitState.reasons : ['no branch recorded in TASK.md']
  return {
    slug: task.slug,
    repo: task.repo,
    repoPath,
    worktree,
    branch: task.branch,
    hasUncommittedWork: gitState?.hasUncommittedWork ?? false,
    isMerged: gitState?.isMerged ?? false,
    tmuxSessions,
    sizeBytes,
    verdict: reasons.length === 0 ? 'safe' : 'needs-developer',
    reasons,
  }
}

// Every task whose STATUS is done (or "done: ...") and whose worktree
// directory still exists. Strictly read-only.
export async function collectSweepEntries(tasksDir: string, deps: SweepDeps = defaultSweepDeps): Promise<SweepEntry[]> {
  const tasks = await parseAllTasks(tasksDir)
  const doneTasks = tasks.filter((task) => task.status === 'done' && task.worktree)
  if (doneTasks.length === 0) return []

  // The same matcher the merge-time retirement uses, against every task (not
  // just done ones): the report previews exactly what retirement would kill,
  // so a session of "foo-fix" is never credited to "foo".
  const allSessions = await deps.listTmuxSessions()
  const allSlugs = tasks.map((task) => task.slug)
  const sessionsOf = (task: Task) => taskSessionNames(task, allSessions, allSlugs)
  const entries = await Promise.all(doneTasks.map((task) => buildEntry(task, tasksDir, sessionsOf(task), deps)))
  return entries.sort((a, b) => a.slug.localeCompare(b.slug))
}

export type SweepOutcome =
  | { slug: string; result: 'removed' }
  | { slug: string; result: 'refused' | 'declined' | 'failed'; reason: string }

export interface RemoveRequest {
  slugs?: string[]
  allClean?: boolean
  // Asked once, with everything about to be removed. Omitted means "yes" —
  // the CLI passes one unless --yes was given.
  confirm?: (entries: SweepEntry[]) => Promise<boolean>
}

// Removes only what the report marks safe, via the same non-forced
// removeWorktreeAndBranch that markTaskDone uses: no --force, no -D, no
// remote branch, no tmux. Every request gets exactly one outcome.
export async function removeSweepEntries(
  tasksDir: string,
  request: RemoveRequest,
  deps: SweepDeps = defaultSweepDeps,
): Promise<SweepOutcome[]> {
  const entries = await collectSweepEntries(tasksDir, deps)
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]))
  const requested = request.allClean
    ? entries.filter((entry) => entry.verdict === 'safe').map((entry) => entry.slug)
    : [...new Set(request.slugs ?? [])]

  const outcomes: SweepOutcome[] = []
  const toRemove: SweepEntry[] = []
  for (const slug of requested) {
    const entry = bySlug.get(slug)
    if (!entry) {
      outcomes.push({ slug, result: 'refused', reason: 'not a done task with a worktree on disk' })
    } else if (entry.verdict !== 'safe') {
      outcomes.push({ slug, result: 'refused', reason: entry.reasons.join('; ') })
    } else {
      toRemove.push(entry)
    }
  }
  if (toRemove.length === 0) return outcomes

  if (request.confirm && !(await request.confirm(toRemove))) {
    return [...outcomes, ...toRemove.map((entry): SweepOutcome => ({ slug: entry.slug, result: 'declined', reason: 'not confirmed' }))]
  }

  const remove = deps.removeWorktreeAndBranch ?? removeWorktreeAndBranch
  for (const entry of toRemove) {
    const result = await remove(entry.repoPath, entry.worktree, entry.branch)
    outcomes.push(result.ok ? { slug: entry.slug, result: 'removed' } : { slug: entry.slug, result: 'failed', reason: result.error })
  }
  return outcomes
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return 'size unknown'
  const mib = sizeBytes / (1024 * 1024)
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib.toFixed(0)} MiB`
}

export function formatSweepReport(entries: SweepEntry[]): string[] {
  if (entries.length === 0) return ['Nothing to sweep: no done task has a worktree on disk.']
  const lines = entries.flatMap((entry) => [
    `${entry.slug} — ${entry.verdict === 'safe' ? 'safe to remove' : 'needs the developer'}`,
    `  worktree: ${entry.worktree} (${formatSize(entry.sizeBytes)})`,
    `  branch:   ${entry.branch || '(none recorded)'} — ${entry.isMerged ? 'merged into the base' : 'not merged'}`,
    `  work:     ${entry.hasUncommittedWork ? 'uncommitted or untracked files present' : 'clean'}`,
    `  tmux:     ${entry.tmuxSessions.length ? entry.tmuxSessions.join(', ') : 'no worker session'}`,
    ...entry.reasons.map((reason) => `  ! ${reason}`),
  ])
  const safeCount = entries.filter((entry) => entry.verdict === 'safe').length
  return [...lines, '', `${entries.length} done task(s) still have a worktree; ${safeCount} safe to remove.`]
}
