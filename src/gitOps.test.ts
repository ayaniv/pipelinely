import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mergePullRequest, deleteRemoteBranch, removeWorktreeAndBranch, commitAndRemoveWorktree } from './gitOps.js'

// Defaults to the REAL execa (every existing test above keeps shelling out
// to real git, unaffected) — a test that needs a deterministic `gh` result
// without touching a real remote queues one override with
// mockResolvedValueOnce/mockRejectedValueOnce, consumed for exactly that one
// call and never seen by any other test.
// vi.mock's factory is hoisted above any plain top-level `let`, so the real
// execa reference has to be stashed via vi.hoisted instead — a plain
// closure variable here would throw "Cannot access before initialization".
const { realExecaRef } = vi.hoisted(() => ({ realExecaRef: { current: undefined as unknown } }))
vi.mock('execa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('execa')>()
  realExecaRef.current = actual.execa
  return { ...actual, execa: vi.fn(actual.execa) }
})

// A test whose queued override is never consumed (e.g. the function under
// test throws before it gets that far) would otherwise leak that value into
// the next test's own, unrelated real `git` calls — reset the mock and
// restore the real-execa default after every test, not just the ones that
// queue anything.
afterEach(() => {
  vi.mocked(execa).mockReset()
  vi.mocked(execa).mockImplementation(realExecaRef.current as typeof import('execa').execa)
})

// removeWorktreeAndBranch shells out to real `git` against a throwaway repo
// built fresh per test — this is the safety-critical half of the merge
// feature (it deletes things), so it gets real git behavior exercised
// against it rather than a mock that could silently drift from what git
// actually does on a dirty worktree or an unmerged branch.
describe('removeWorktreeAndBranch', () => {
  let repoPath: string
  let worktreePath: string
  const branch = 'claude/scratch-branch'

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitops-test-'))
    repoPath = path.join(root, 'repo')
    worktreePath = path.join(root, 'worktree')
    await fs.mkdir(repoPath, { recursive: true })

    await execa('git', ['init', '-q', '-b', 'master'], { cwd: repoPath })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: repoPath })
    await fs.writeFile(path.join(repoPath, 'README.md'), 'init\n')
    await execa('git', ['add', 'README.md'], { cwd: repoPath })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath })

    await execa('git', ['worktree', 'add', '-q', '-b', branch, worktreePath], { cwd: repoPath })
  })

  afterEach(async () => {
    await fs.rm(path.dirname(repoPath), { recursive: true, force: true })
  })

  it('removes the worktree and deletes the branch once it is fully merged', async () => {
    await fs.writeFile(path.join(worktreePath, 'feature.txt'), 'feature\n')
    await execa('git', ['add', 'feature.txt'], { cwd: worktreePath })
    await execa('git', ['commit', '-q', '-m', 'add feature'], { cwd: worktreePath })
    await execa('git', ['merge', '-q', branch], { cwd: repoPath })

    const result = await removeWorktreeAndBranch(repoPath, worktreePath, branch)
    expect(result).toEqual({ ok: true })

    await expect(fs.access(worktreePath)).rejects.toThrow()
    const { stdout } = await execa('git', ['branch', '--list', branch], { cwd: repoPath })
    expect(stdout.trim()).toBe('')
  })

  it('refuses to remove a worktree with uncommitted changes, and leaves it in place', async () => {
    await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')

    const result = await removeWorktreeAndBranch(repoPath, worktreePath, branch)
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/couldn't remove worktree/)

    await expect(fs.access(worktreePath)).resolves.toBeUndefined()
    const { stdout } = await execa('git', ['branch', '--list', branch], { cwd: repoPath })
    expect(stdout.trim()).not.toBe('')
  })

  it('removes the worktree but refuses to delete a branch that was never merged', async () => {
    await fs.writeFile(path.join(worktreePath, 'unmerged.txt'), 'unmerged\n')
    await execa('git', ['add', 'unmerged.txt'], { cwd: worktreePath })
    await execa('git', ['commit', '-q', '-m', 'unmerged work'], { cwd: worktreePath })

    const result = await removeWorktreeAndBranch(repoPath, worktreePath, branch)
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/worktree removed, but couldn't delete branch/)

    await expect(fs.access(worktreePath)).rejects.toThrow()
    const { stdout } = await execa('git', ['branch', '--list', branch], { cwd: repoPath })
    expect(stdout.trim()).not.toBe('')
  })
})

// mergePullRequest's happy path needs a real PR + `gh` auth + network, none
// of which belong in an automated test — see resume-dead-session-fallback
// .spec.ts's own header comment for the same tradeoff on a different
// external dependency. Its failure path is still real and deterministic
// though: `gh pr merge` run outside any git repository fails immediately,
// offline, with no auth required.
describe('mergePullRequest', () => {
  it('fails with a clear error when the repo path is not a git repository', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitops-notarepo-'))
    try {
      const result = await mergePullRequest(notARepo, '9999', 'a'.repeat(40))
      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toMatch(/not a git repository/i)
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true })
    }
  })

  it('pins the merge to the exact head commit the gate checked', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never)
    const result = await mergePullRequest('/repo', '42', 'deadbeef'.repeat(5))
    expect(result).toEqual({ ok: true })
    expect(execa).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '42', '--merge', '--match-head-commit', 'deadbeef'.repeat(5)],
      { cwd: '/repo' },
    )
  })
})

describe('deleteRemoteBranch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('succeeds on a clean DELETE, from the main checkout so gh resolves {owner}/{repo} from its remote', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never)
    const result = await deleteRemoteBranch('/repo', 'claude/some-task')
    expect(result).toEqual({ ok: true })
    expect(execa).toHaveBeenCalledWith(
      'gh',
      ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/git/refs/heads/claude/some-task'],
      { cwd: '/repo' },
    )
  })

  it('treats a DELETE failure as success once matching-refs confirms the branch is already gone', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('gh: Reference does not exist (HTTP 422)'))
      .mockResolvedValueOnce({ stdout: '[]' } as never)
    const result = await deleteRemoteBranch('/repo', 'claude/some-task')
    expect(result).toEqual({ ok: true })
  })

  it('treats a matching-refs prefix sibling (not an exact match) as the branch still being gone', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('gh: Reference does not exist (HTTP 422)'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ ref: 'refs/heads/claude/some-task-m0' }]) } as never)
    const result = await deleteRemoteBranch('/repo', 'claude/some-task')
    expect(result).toEqual({ ok: true })
  })

  it('fails when the DELETE fails and the exact ref is still listed by matching-refs', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('gh: some other DELETE failure'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ ref: 'refs/heads/claude/some-task' }]) } as never)
    const result = await deleteRemoteBranch('/repo', 'claude/some-task')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/couldn't delete remote branch claude\/some-task/)
    expect(console.error).toHaveBeenCalled()
  })

  it('fails when the DELETE fails and the confirming matching-refs read itself fails', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('gh: some other DELETE failure'))
      .mockRejectedValueOnce(new Error('gh: network error'))
    const result = await deleteRemoteBranch('/repo', 'claude/some-task')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/couldn't delete remote branch claude\/some-task/)
    expect(console.error).toHaveBeenCalled()
  })

  it('fails when the DELETE fails and matching-refs returns something that is not the expected JSON shape', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('gh: some other DELETE failure'))
      .mockResolvedValueOnce({ stdout: 'not json' } as never)
    const result = await deleteRemoteBranch('/repo', 'claude/some-task')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/couldn't delete remote branch claude\/some-task/)
    expect(console.error).toHaveBeenCalled()
  })
})

// commitAndRemoveWorktree is the teardown POST /shelve/:slug runs, and it is
// the only code in this repo that ever *commits* on the developer's behalf —
// so it gets the same real-git-against-a-throwaway-repo treatment its
// sibling above does, with the same setup, rather than a mock that could
// drift from what git actually does.
describe('commitAndRemoveWorktree', () => {
  let root: string
  let repoPath: string
  let worktreePath: string
  const branch = 'claude/scratch-branch'

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitops-shelve-test-'))
    repoPath = path.join(root, 'repo')
    worktreePath = path.join(root, 'worktree')
    await fs.mkdir(repoPath, { recursive: true })

    await execa('git', ['init', '-q', '-b', 'master'], { cwd: repoPath })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: repoPath })
    await fs.writeFile(path.join(repoPath, 'README.md'), 'init\n')
    await execa('git', ['add', 'README.md'], { cwd: repoPath })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath })

    await execa('git', ['worktree', 'add', '-q', '-b', branch, worktreePath], { cwd: repoPath })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function branchExists(): Promise<boolean> {
    const { stdout } = await execa('git', ['branch', '--list', branch], { cwd: repoPath })
    return stdout.trim() !== ''
  }

  it('commits pending work before removing the worktree, so nothing in flight is lost', async () => {
    await fs.writeFile(path.join(worktreePath, 'in-flight.txt'), 'half-written\n')

    const result = await commitAndRemoveWorktree(repoPath, worktreePath)
    expect(result).toEqual({ ok: true })

    await expect(fs.access(worktreePath)).rejects.toThrow()
    // The commit is reachable from the branch — the branch is the durable
    // record shelving deliberately leaves behind.
    const { stdout } = await execa('git', ['show', '--name-only', '--format=%s', branch], { cwd: repoPath })
    expect(stdout).toContain('wip: shelved')
    expect(stdout).toContain('in-flight.txt')
  })

  it('still removes a clean worktree, with nothing to commit', async () => {
    const before = await execa('git', ['rev-parse', branch], { cwd: repoPath })

    const result = await commitAndRemoveWorktree(repoPath, worktreePath)
    expect(result).toEqual({ ok: true })

    await expect(fs.access(worktreePath)).rejects.toThrow()
    // No empty throwaway commit was created.
    const after = await execa('git', ['rev-parse', branch], { cwd: repoPath })
    expect(after.stdout).toBe(before.stdout)
  })

  it('never deletes the branch — a shelved task is by definition unfinished', async () => {
    await fs.writeFile(path.join(worktreePath, 'in-flight.txt'), 'half-written\n')
    await commitAndRemoveWorktree(repoPath, worktreePath)
    expect(await branchExists()).toBe(true)
  })

  it('refuses to commit a directory that is not itself a worktree root', async () => {
    // `git add -A` acts on whatever repo encloses the cwd — so without this
    // guard, a stale or wrong worktree path that merely sits *inside*
    // another checkout would stage and commit that repo's entire working
    // tree. Reproduced for real: this is exactly what a nested fixture
    // directory did to the e2e suite's own repo.
    const nested = path.join(worktreePath, 'not-a-worktree-root')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(worktreePath, 'must-not-be-committed.txt'), 'still dirty\n')

    const result = await commitAndRemoveWorktree(repoPath, nested)
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/is not the root of a git worktree/)

    // The enclosing worktree is untouched: still dirty, still present.
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath })
    expect(stdout).toContain('must-not-be-committed.txt')
    await expect(fs.access(worktreePath)).resolves.toBeUndefined()
  })

  it('reports a clear error for a path that is not in a git repository at all', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitops-shelve-notarepo-'))
    try {
      const result = await commitAndRemoveWorktree(repoPath, notARepo)
      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toMatch(/couldn't commit pending work/)
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true })
    }
  })
})
