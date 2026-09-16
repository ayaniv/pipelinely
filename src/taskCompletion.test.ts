import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { markTaskDone, mergeTask } from './taskCompletion.js'
import type { Task } from './types.js'

// checkMergeReadiness/mergePullRequest/deleteRemoteBranch all touch GitHub —
// mocked here, same as gitOps.test.ts mocks execa for its own gh-only
// tests. removeWorktreeAndBranch (markTaskDone's own cleanup step) is left
// real, against a throwaway git repo + worktree, matching gitOps.test.ts's
// own "real git, not a mock that could drift" reasoning — mergeTask's local
// cleanup half deserves the same treatment its extraction came from.
const { checkMergeReadinessMock, mergePullRequestMock, deleteRemoteBranchMock } = vi.hoisted(() => ({
  checkMergeReadinessMock: vi.fn(),
  mergePullRequestMock: vi.fn(),
  deleteRemoteBranchMock: vi.fn(),
}))

vi.mock('./mergeGate.js', () => ({ checkMergeReadiness: checkMergeReadinessMock }))
vi.mock('./gitOps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitOps.js')>()
  return { ...actual, mergePullRequest: mergePullRequestMock, deleteRemoteBranch: deleteRemoteBranchMock }
})

const HEAD_SHA = 'a'.repeat(40)
const slug = 'merge-task-test'
const branch = 'claude/merge-task-test'

function readyResult(overrides: Record<string, unknown> = {}) {
  return { ready: true as const, headSha: HEAD_SHA, headRefName: branch, isCrossRepository: false, ...overrides }
}

function blockedResult(kind = 'conflicts') {
  return { ready: false as const, blockers: [{ kind, detail: `blocked: ${kind}` }] }
}

function task(overrides: Partial<Task> = {}): Pick<Task, 'slug' | 'repo' | 'branch' | 'worktree' | 'reviewRef' | 'stageHistory'> {
  return {
    slug,
    repo: 'repo',
    branch,
    worktree: null,
    reviewRef: undefined,
    stageHistory: [{ stage: 'dev', at: '2026-01-01T00:00:00Z', note: 'PR #42 open' }],
    ...overrides,
  } as Pick<Task, 'slug' | 'repo' | 'branch' | 'worktree' | 'reviewRef' | 'stageHistory'>
}

describe('mergeTask / markTaskDone', () => {
  let root: string
  let repoPath: string
  let worktreePath: string
  let tasksDir: string
  let originalReposDir: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-completion-test-'))
    repoPath = path.join(root, 'repo')
    worktreePath = path.join(root, 'worktree')
    tasksDir = path.join(root, 'tasks')
    await fs.mkdir(repoPath, { recursive: true })

    await execa('git', ['init', '-q', '-b', 'master'], { cwd: repoPath })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: repoPath })
    await fs.writeFile(path.join(repoPath, 'README.md'), 'init\n')
    await execa('git', ['add', 'README.md'], { cwd: repoPath })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath })
    await execa('git', ['worktree', 'add', '-q', '-b', branch, worktreePath], { cwd: repoPath })
    // Merged into master up front so `git branch -d` (never -D) succeeds —
    // mirrors what a real GitHub-side merge means for the local branch.
    await execa('git', ['merge', '-q', branch], { cwd: repoPath })

    await fs.mkdir(path.join(tasksDir, slug), { recursive: true })
    await fs.writeFile(path.join(tasksDir, slug, 'STATUS'), 'waiting: QA passed, ready to merge\n')
    await fs.writeFile(path.join(tasksDir, slug, 'TIMELINE'), '2026-01-01T00:00:00Z qa all cases passed\n')

    originalReposDir = process.env.REPOS_DIR
    process.env.REPOS_DIR = root
  })

  afterEach(async () => {
    process.env.REPOS_DIR = originalReposDir
    await fs.rm(root, { recursive: true, force: true })
  })

  async function readStatus() {
    return fs.readFile(path.join(tasksDir, slug, 'STATUS'), 'utf-8')
  }
  async function readTimeline() {
    return fs.readFile(path.join(tasksDir, slug, 'TIMELINE'), 'utf-8')
  }

  describe('mergeTask', () => {
    it('returns no-pr and touches nothing when the task has no recorded PR', async () => {
      const result = await mergeTask(tasksDir, task({ stageHistory: [] }))
      expect(result).toEqual({ outcome: 'no-pr' })
      expect(checkMergeReadinessMock).not.toHaveBeenCalled()
      expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
    })

    it('returns gate-unavailable when gh pr view itself fails, and touches nothing', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: false, error: 'gh: network error' })
      const result = await mergeTask(tasksDir, task())
      expect(result).toEqual({ outcome: 'gate-unavailable', error: 'gh: network error' })
      expect(mergePullRequestMock).not.toHaveBeenCalled()
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
      expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
    })

    it('returns blocked and touches nothing (no merge call, no remote delete, STATUS/TIMELINE/worktree untouched) when the gate refuses', async () => {
      const timelineBefore = await readTimeline()
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: blockedResult() })
      const result = await mergeTask(tasksDir, task({ worktree: worktreePath }))
      expect(result).toEqual({ outcome: 'blocked', prNumber: '42', blockers: blockedResult().blockers })
      expect(mergePullRequestMock).not.toHaveBeenCalled()
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
      expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
      expect(await readTimeline()).toBe(timelineBefore)
      await expect(fs.access(worktreePath)).resolves.toBeUndefined()
    })

    it('returns merge-failed and touches nothing when gh pr merge itself fails', async () => {
      const timelineBefore = await readTimeline()
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: false, error: 'gh: Head branch was modified' })
      const result = await mergeTask(tasksDir, task())
      expect(result).toEqual({ outcome: 'merge-failed', prNumber: '42', error: 'gh: Head branch was modified' })
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
      expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
      expect(await readTimeline()).toBe(timelineBefore)
    })

    it('on a clean merge: records the TIMELINE line, marks done, removes the worktree/branch, then deletes the remote branch — in that order', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: true })

      const result = await mergeTask(tasksDir, task({ worktree: worktreePath }))
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null })

      expect(mergePullRequestMock).toHaveBeenCalledWith(repoPath, '42', HEAD_SHA)
      expect(deleteRemoteBranchMock).toHaveBeenCalledWith(repoPath, branch)
      // Local cleanup (git branch -d) genuinely ran — it isn't mocked.
      await expect(fs.access(worktreePath)).rejects.toThrow()

      expect(await readStatus()).toBe('done\n')
      expect(await readTimeline()).toMatch(/Z merge merged PR #42\n$/)

      const deleteRemoteCallOrder = deleteRemoteBranchMock.mock.invocationCallOrder[0]
      const mergeCallOrder = mergePullRequestMock.mock.invocationCallOrder[0]
      expect(deleteRemoteCallOrder).toBeGreaterThan(mergeCallOrder)
    })

    it('with a dirty worktree: surfaces the cleanup error but the remote delete still runs', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: true })
      await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')

      const result = await mergeTask(tasksDir, task({ worktree: worktreePath }))
      expect(result.outcome).toBe('merged')
      expect((result as { cleanupError: string }).cleanupError).toMatch(/couldn't remove worktree/)
      expect(deleteRemoteBranchMock).toHaveBeenCalledWith(repoPath, branch)
      expect(await readStatus()).toBe('done\n')
    })

    it('when the remote delete fails: cleanupError is exactly the remote message', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: false, error: `couldn't delete remote branch ${branch}: gh: 500` })

      const result = await mergeTask(tasksDir, task({ worktree: worktreePath }))
      expect(result.outcome).toBe('merged')
      expect((result as { cleanupError: string }).cleanupError).toBe(`couldn't delete remote branch ${branch}: gh: 500`)
    })

    it('when both local cleanup and the remote delete fail: both messages are joined by "; "', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: false, error: `couldn't delete remote branch ${branch}: gh: 500` })
      await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')

      const result = await mergeTask(tasksDir, task({ worktree: worktreePath }))
      expect(result.outcome).toBe('merged')
      const cleanupError = (result as { cleanupError: string }).cleanupError
      const parts = cleanupError.split('; ')
      expect(parts).toHaveLength(2)
      expect(parts[0]).toMatch(/^couldn't remove worktree/)
      expect(parts[1]).toBe(`couldn't delete remote branch ${branch}: gh: 500`)
    })

    it('skips the remote delete for a fork PR (isCrossRepository), and cleanupError stays null', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult({ isCrossRepository: true }) })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })

      const result = await mergeTask(tasksDir, task())
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null })
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
    })

    it('when a task has no worktree: markTaskDone still runs (git branch -d only) and the remote delete still fires', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: true })

      const result = await mergeTask(tasksDir, task({ worktree: null }))
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null })
      expect(deleteRemoteBranchMock).toHaveBeenCalledWith(repoPath, branch)
    })

    it('rethrows starting "PR #N WAS merged" when recording the merge fails after gh already merged it, and never deletes the remote branch', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      // Make the post-merge TIMELINE append fail: TIMELINE is now a directory.
      await fs.rm(path.join(tasksDir, slug, 'TIMELINE'))
      await fs.mkdir(path.join(tasksDir, slug, 'TIMELINE'))

      await expect(mergeTask(tasksDir, task())).rejects.toThrow(/^PR #42 WAS merged, but recording it failed:/)
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
    })
  })

  describe('markTaskDone', () => {
    it('keeps /mark-done\'s existing behavior: writes STATUS done and best-effort cleans the worktree/branch', async () => {
      const result = await markTaskDone(tasksDir, task({ worktree: worktreePath }))
      expect(result).toEqual({ cleanupError: null })
      expect(await readStatus()).toBe('done\n')
      await expect(fs.access(worktreePath)).rejects.toThrow()
    })

    it('never calls deleteRemoteBranch — it has no proof the branch was ever merged', async () => {
      await markTaskDone(tasksDir, task({ worktree: worktreePath }))
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
    })

    it('surfaces a cleanup failure without failing the STATUS write', async () => {
      await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')
      const result = await markTaskDone(tasksDir, task({ worktree: worktreePath }))
      expect(result.cleanupError).toMatch(/couldn't remove worktree/)
      expect(await readStatus()).toBe('done\n')
    })
  })
})
