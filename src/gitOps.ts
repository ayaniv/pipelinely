import { execa } from 'execa'
import fs from 'node:fs/promises'

export type GitOpResult = { ok: true } | { ok: false; error: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Opens a PR in the developer's default browser via `gh` — same
// server-drives-the-`open`-call shape as focusTab.ts's openBrowserUrl, used
// here instead of a plain <a href> because there's no reliable owner/repo
// URL to build client-side (a task only knows its bare repo name, not the
// GitHub org it lives under); `gh` already knows.
export async function openPrInBrowser(repoPath: string, prNumber: string): Promise<GitOpResult> {
  try {
    await execa('gh', ['pr', 'view', prNumber, '--web'], { cwd: repoPath })
    return { ok: true }
  } catch (err) {
    console.error(`Failed to open PR #${prNumber} in ${repoPath}:`, err)
    return { ok: false, error: errorMessage(err) }
  }
}

const BRANCH_PR_LOOKUP_LIMIT = 20
// One hung gh must not stall the whole snapshot broadcast (refreshTasks awaits
// every lookup).
const BRANCH_PR_LOOKUP_TIMEOUT_MS = 15_000

export interface BranchPr {
  prNumber: string
  isOpen: boolean
}

// Asks GitHub which PR has `branch` as its head — the source of truth for a
// task's PR, ahead of anything a worker wrote in a TIMELINE note. A branch
// can carry several (an old merged one and a newer open one): OPEN wins,
// otherwise the most recently created. Fork PRs are ignored: `--head` matches
// the ref name only, so a fork branch with the same name would otherwise win.
// Returns null both for "no PR" and for a gh failure — the failure is logged,
// and the caller treats either as "nothing branch-derived" rather than
// breaking the board.
export async function findPrByBranch(repoPath: string, branch: string): Promise<BranchPr | null> {
  try {
    const { stdout } = await execa(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,createdAt,isCrossRepository', '--limit', String(BRANCH_PR_LOOKUP_LIMIT)],
      { cwd: repoPath, timeout: BRANCH_PR_LOOKUP_TIMEOUT_MS },
    )
    const prs: unknown = JSON.parse(stdout)
    if (!Array.isArray(prs)) return null

    const sameRepoPrs = prs.filter(
      (pr): pr is { number: number; state: string; createdAt: string; isCrossRepository: false } =>
        typeof pr?.number === 'number' &&
        typeof pr?.state === 'string' &&
        typeof pr?.createdAt === 'string' &&
        pr?.isCrossRepository === false,
    )
    const ranked = [...sameRepoPrs].sort(
      (a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.createdAt.localeCompare(a.createdAt),
    )
    if (ranked.length === 0) return null
    return { prNumber: String(ranked[0].number), isOpen: ranked[0].state === 'OPEN' }
  } catch (err) {
    console.error(`Failed to look up the PR for branch ${branch} in ${repoPath}:`, err)
    return null
  }
}

// Reads which branch a PR's head is on, so Open PR can refuse a PR that isn't
// the task's own, the same way the merge gate does.
export async function readPrHeadBranch(
  repoPath: string,
  prNumber: string,
): Promise<{ ok: true; headRefName: string; isCrossRepository: boolean } | { ok: false; error: string }> {
  try {
    const { stdout } = await execa('gh', ['pr', 'view', prNumber, '--json', 'headRefName,isCrossRepository'], { cwd: repoPath })
    const view: unknown = JSON.parse(stdout)
    const { headRefName, isCrossRepository } = (view ?? {}) as Record<string, unknown>
    if (typeof headRefName !== 'string' || !headRefName || typeof isCrossRepository !== 'boolean') {
      throw new Error('gh pr view returned data in an unexpected shape')
    }
    return { ok: true, headRefName, isCrossRepository }
  } catch (err) {
    console.error(`Failed to read PR #${prNumber}'s head branch in ${repoPath}:`, err)
    return { ok: false, error: errorMessage(err) }
  }
}

// Merges an already-open PR via `gh`, using the same merge-commit strategy
// (never squash/rebase) every PR in this repo's own history has been merged
// with — `git log --merges` is all "Merge pull request #N from ...".
// `repoPath` is the MAIN checkout (not a worktree) — gh needs a checkout
// whose remote matches the PR's repo, which any clone satisfies equally.
// `headSha` is required, not optional: every caller comes through
// mergeGate.ts's checkMergeReadiness first, so an unpinned merge is never
// available — `--match-head-commit` makes GitHub itself reject the merge if
// a commit landed on the branch after the gate read it.
export async function mergePullRequest(repoPath: string, prNumber: string, headSha: string): Promise<GitOpResult> {
  try {
    await execa('gh', ['pr', 'merge', prNumber, '--merge', '--match-head-commit', headSha], { cwd: repoPath })
    return { ok: true }
  } catch (err) {
    console.error(`Failed to merge PR #${prNumber} in ${repoPath}:`, err)
    return { ok: false, error: errorMessage(err) }
  }
}

// Deletes a merged PR's remote head branch, from `repoPath` (the main
// checkout) so gh resolves {owner}/{repo} from its own remote, the same cwd
// mergePullRequest uses. Not `gh pr merge --delete-branch`: that also tries
// to delete the LOCAL branch, which is still checked out in the worktree at
// the point mergeTask calls this (see taskCompletion.ts's own ordering
// comment). Idempotent by design, since a retry (or a second concurrent
// caller) must not treat an already-deleted branch as a failure:
//   1. `gh api -X DELETE .../git/refs/heads/<branch>` — success is success.
//   2. On failure, confirm with `gh api .../git/matching-refs/heads/<branch>`
//      (a PREFIX match, so an exact `ref` comparison is required — a
//      `<branch>-m0` sibling must not count as "still there"). No exact
//      match means the branch is already gone: also success. This is
//      structured, not string-parsing gh's own HTTP 422 stderr the way
//      mergeGate.ts avoids `gh pr checks`'s human-readable output.
//   3. Anything else (still present, or the confirming read itself fails or
//      isn't the expected JSON) is a real failure — both errors logged.
export async function deleteRemoteBranch(repoPath: string, branch: string): Promise<GitOpResult> {
  try {
    await execa('gh', ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`], { cwd: repoPath })
    return { ok: true }
  } catch (deleteErr) {
    let matchingRefs: unknown
    try {
      const { stdout } = await execa('gh', ['api', `repos/{owner}/{repo}/git/matching-refs/heads/${branch}`], { cwd: repoPath })
      matchingRefs = JSON.parse(stdout)
    } catch (confirmErr) {
      console.error(`Failed to delete remote branch ${branch} in ${repoPath}:`, deleteErr)
      console.error(`Failed to confirm remote branch ${branch} is gone in ${repoPath}:`, confirmErr)
      return { ok: false, error: `couldn't delete remote branch ${branch}: ${errorMessage(deleteErr)}` }
    }

    const exactRef = `refs/heads/${branch}`
    const stillPresent = Array.isArray(matchingRefs) && matchingRefs.some(
      (entry) => entry && typeof entry === 'object' && (entry as { ref?: unknown }).ref === exactRef,
    )
    if (!stillPresent) return { ok: true }

    console.error(`Failed to delete remote branch ${branch} in ${repoPath}:`, deleteErr)
    return { ok: false, error: `couldn't delete remote branch ${branch}: ${errorMessage(deleteErr)}` }
  }
}

// Removes a task's worktree, then deletes its now-unused branch — both via
// plain git, both deliberately non-forced: `git worktree remove` refuses on
// uncommitted changes, and `git branch -d` (never -D) refuses on a branch
// that isn't actually fully merged into the current HEAD. Either refusal is
// surfaced as an error rather than overridden — a branch/worktree that
// isn't safely removable is a signal something's wrong, not friction to
// force past. Runs from `repoPath` (the main checkout, never the worktree
// itself — git refuses to delete a branch that's still checked out
// somewhere, and the worktree has to go first for exactly that reason).
export async function removeWorktreeAndBranch(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<GitOpResult> {
  try {
    await execa('git', ['worktree', 'remove', worktreePath], { cwd: repoPath })
  } catch (err) {
    console.error(`Failed to remove worktree ${worktreePath}:`, err)
    return { ok: false, error: `couldn't remove worktree: ${errorMessage(err)}` }
  }
  try {
    await execa('git', ['branch', '-d', branch], { cwd: repoPath })
  } catch (err) {
    console.error(`Failed to delete branch ${branch}:`, err)
    return { ok: false, error: `worktree removed, but couldn't delete branch: ${errorMessage(err)}` }
  }
  return { ok: true }
}

// Commits whatever is still pending in a task's worktree, then removes the
// worktree — the teardown POST /shelve/:slug runs when a task leaves the
// board. Deliberately does NOT delete the branch, unlike
// removeWorktreeAndBranch above: a task being shelved is by definition
// unfinished, so its branch is very likely unmerged (`git branch -d` would
// refuse anyway), and that branch is the one thing shelving leaves behind on
// purpose — it's the durable record of the work, and the worktree is
// recreatable from it with a single command.
//
// Committing first is what makes the non-forced removal viable at all:
// `git worktree remove` refuses on uncommitted changes, and a task shelved
// mid-flight almost always has some. Never throws — returns a typed error at
// each of its two failure points, like every helper in this file, so the
// route can treat cleanup as best-effort without a failure blocking the
// shelve itself.
export async function commitAndRemoveWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<GitOpResult> {
  // `git add -A` acts on whatever repo encloses the cwd, not on the
  // directory itself — so a worktreePath that merely *sits inside* some
  // other checkout (a leftover directory, a fixture dir, a path pointing at
  // the wrong root) would stage and commit that repo's entire working tree.
  // Refuse unless this directory really is a worktree root of its own.
  try {
    const { stdout: toplevel } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: worktreePath })
    // realpath both sides: on macOS a worktree reached through /tmp or a
    // symlinked home resolves to a different literal string than git prints.
    const [gitRoot, wanted] = await Promise.all([
      fs.realpath(toplevel.trim()),
      fs.realpath(worktreePath),
    ])
    if (gitRoot !== wanted) {
      console.error(`Refused to commit in ${worktreePath}: it is not a worktree root (git reports ${gitRoot})`)
      return { ok: false, error: `couldn't commit pending work: ${worktreePath} is not the root of a git worktree` }
    }
  } catch (err) {
    console.error(`Failed to confirm ${worktreePath} is a worktree root:`, err)
    return { ok: false, error: `couldn't commit pending work: ${errorMessage(err)}` }
  }

  try {
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath })
    if (stdout.trim()) {
      await execa('git', ['add', '-A'], { cwd: worktreePath })
      await execa('git', ['commit', '-q', '-m', 'wip: shelved'], { cwd: worktreePath })
    }
  } catch (err) {
    console.error(`Failed to commit pending work in ${worktreePath}:`, err)
    return { ok: false, error: `couldn't commit pending work: ${errorMessage(err)}` }
  }

  try {
    await execa('git', ['worktree', 'remove', worktreePath], { cwd: repoPath })
  } catch (err) {
    console.error(`Failed to remove worktree ${worktreePath}:`, err)
    return { ok: false, error: `committed pending work, but couldn't remove worktree: ${errorMessage(err)}` }
  }

  return { ok: true }
}

// Refs a task branch might have forked from, most authoritative first.
const BASE_REF_CANDIDATES = ['origin/HEAD', 'origin/master', 'origin/main', 'master', 'main']

// A dashboard refresh reads every task waiting at a QA-entry marker, and a
// task that needs QA stays there for days. The diff only changes when the
// branch's HEAD does, so it is cached per worktree keyed on that sha.
const changedFilesCache = new Map<string, { headSha: string; files: string[] }>()

// The files a task's branch changes relative to the base it forked from — the
// PR's file list, read locally so a dashboard refresh needs no network call.
// null (logged) when the list cannot be read, kept distinct from [] ("changed
// nothing") so a caller never mistakes an unreadable diff for an empty one.
export async function listBranchChangedFiles(worktreePath: string): Promise<string[] | null> {
  try {
    const { stdout: headSha } = await execa('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
    const cached = changedFilesCache.get(worktreePath)
    if (cached?.headSha === headSha) return cached.files

    for (const baseRef of BASE_REF_CANDIDATES) {
      const hasBaseRef = await execa('git', ['-C', worktreePath, 'rev-parse', '--verify', '--quiet', baseRef], { reject: false })
      if (hasBaseRef.exitCode !== 0) continue
      const { stdout } = await execa('git', ['-C', worktreePath, 'diff', '--name-only', `${baseRef}...HEAD`])
      const files = stdout.split('\n').filter(Boolean)
      changedFilesCache.set(worktreePath, { headSha, files })
      return files
    }
    console.error(`No base ref found to diff ${worktreePath} against`)
    return null
  } catch (err) {
    console.error(`Failed to list changed files in ${worktreePath}:`, err)
    return null
  }
}
