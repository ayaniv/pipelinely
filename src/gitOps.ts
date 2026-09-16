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
