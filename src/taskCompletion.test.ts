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
const { checkMergeReadinessMock, mergePullRequestMock, deleteRemoteBranchMock, retireSessionsOfTaskMock } = vi.hoisted(() => ({
  checkMergeReadinessMock: vi.fn(),
  mergePullRequestMock: vi.fn(),
  deleteRemoteBranchMock: vi.fn(),
  retireSessionsOfTaskMock: vi.fn(),
}))

// Never the real tmux server: retirement is always the injected fake here.
vi.mock('./retireTaskSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retireTaskSessions.js')>()
  return { ...actual, retireSessionsOfTask: retireSessionsOfTaskMock }
})

vi.mock('./mergeGate.js', () => ({ checkMergeReadiness: checkMergeReadinessMock }))
vi.mock('./gitOps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitOps.js')>()
  return { ...actual, mergePullRequest: mergePullRequestMock, deleteRemoteBranch: deleteRemoteBranchMock }
})

const NO_SESSIONS = { retired: [], wasAttached: [], failures: [], listError: null }
const SOME_SESSIONS = { retired: [`worker-merge-task-test`, `worker-merge-task-test-qa`], wasAttached: ['worker-merge-task-test-qa'], failures: [], listError: null }

const HEAD_SHA = 'a'.repeat(40)
const slug = 'merge-task-test'
const branch = 'claude/merge-task-test'

function readyResult(overrides: Record<string, unknown> = {}) {
  return { ready: true as const, headSha: HEAD_SHA, headRefName: branch, isCrossRepository: false, ...overrides }
}

function blockedResult(kind = 'conflicts') {
  return { ready: false as const, blockers: [{ kind, detail: `blocked: ${kind}` }], headRefName: branch }
}

function task(overrides: Partial<Task> = {}): Pick<Task, 'slug' | 'repo' | 'branch' | 'worktree' | 'reviewRef' | 'stageHistory' | 'kind' | 'status' | 'waitingReason'> {
  return {
    slug,
    repo: 'repo',
    branch,
    worktree: null,
    reviewRef: undefined,
    kind: 'dev',
    stageHistory: [{ stage: 'dev', at: '2026-01-01T00:00:00Z', note: 'PR #42 open' }],
    ...overrides,
  } as Pick<Task, 'slug' | 'repo' | 'branch' | 'worktree' | 'reviewRef' | 'stageHistory' | 'kind' | 'status' | 'waitingReason'>
}

describe('mergeTask / markTaskDone', () => {
  let root: string
  let repoPath: string
  let worktreePath: string
  let tasksDir: string
  let originalReposDir: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    retireSessionsOfTaskMock.mockResolvedValue(NO_SESSIONS)
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

    describe('a ds task', () => {
      const PR_OPEN = { stage: 'dev' as const, at: '2026-01-01T00:00:00Z', note: 'PR #42 open' }
      const designQa = { stage: 'design-qa' as const, at: '2026-01-02T00:00:00Z', note: '4 stories compared' }
      const approved = { stage: 'design-approval' as const, at: '2026-01-03T00:00:00Z', note: 'approved' }
      const APPROVED_STATUS = { status: 'waiting' as const, waitingReason: 'design approved, ready to merge' }

      it('is refused before gh is called when the designer has not approved, with the design-approval-required blocker', async () => {
        const result = await mergeTask(tasksDir, task({ kind: 'ds', stageHistory: [PR_OPEN, designQa] }))

        expect(result).toMatchObject({ outcome: 'blocked', prNumber: '42', blockers: [{ kind: 'design-approval-required' }] })
        expect(checkMergeReadinessMock).not.toHaveBeenCalled()
        expect(mergePullRequestMock).not.toHaveBeenCalled()
        expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
      })

      it('is refused when the approval predates the latest design QA run', async () => {
        const rerun = { ...designQa, at: '2026-01-04T00:00:00Z' }
        const result = await mergeTask(tasksDir, task({ kind: 'ds', stageHistory: [PR_OPEN, designQa, approved, rerun], ...APPROVED_STATUS }))

        expect(result).toMatchObject({ outcome: 'blocked', blockers: [{ kind: 'design-approval-required' }] })
        expect(mergePullRequestMock).not.toHaveBeenCalled()
      })

      it('is refused when the approval line landed but STATUS never did, with no gh call', async () => {
        const result = await mergeTask(tasksDir, task({ kind: 'ds', stageHistory: [PR_OPEN, designQa, approved], status: 'waiting', waitingReason: 'design QA done, ready for design approval' }))

        expect(result).toMatchObject({ outcome: 'blocked', blockers: [{ kind: 'design-approval-required' }] })
        expect(checkMergeReadinessMock).not.toHaveBeenCalled()
      })

      it('goes through the normal gate once approved after the latest design QA', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: blockedResult() })
        const result = await mergeTask(tasksDir, task({ kind: 'ds', stageHistory: [PR_OPEN, designQa, approved], ...APPROVED_STATUS }))

        expect(checkMergeReadinessMock).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({ outcome: 'blocked', blockers: blockedResult().blockers })
      })

      it('on a clean merge: waits for adopt instead of done, with the same TIMELINE line and the same cleanup', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
        mergePullRequestMock.mockResolvedValueOnce({ ok: true })
        deleteRemoteBranchMock.mockResolvedValueOnce({ ok: true })

        const result = await mergeTask(tasksDir, task({ kind: 'ds', worktree: worktreePath, stageHistory: [PR_OPEN, designQa, approved], ...APPROVED_STATUS }))

        expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null, sessions: NO_SESSIONS })
        expect(await readStatus()).toBe('waiting: merged, ready for adopt\n')
        expect(await readTimeline()).toMatch(/Z merge merged PR #42\n$/)
        await expect(fs.access(worktreePath)).rejects.toThrow()
        expect(deleteRemoteBranchMock).toHaveBeenCalledWith(repoPath, branch)
        expect(retireSessionsOfTaskMock).toHaveBeenCalledTimes(1)
      })

      it('leaves STATUS alone when the merge itself fails, so the task is not stranded at adopt', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
        mergePullRequestMock.mockResolvedValueOnce({ ok: false, error: 'boom' })

        const result = await mergeTask(tasksDir, task({ kind: 'ds', stageHistory: [PR_OPEN, designQa, approved], ...APPROVED_STATUS }))

        expect(result).toMatchObject({ outcome: 'merge-failed' })
        expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
      })

      it('is not asked for approval when a dev task has the same history', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: blockedResult() })
        await mergeTask(tasksDir, task({ kind: 'dev', stageHistory: [PR_OPEN, designQa] }))

        expect(checkMergeReadinessMock).toHaveBeenCalledTimes(1)
      })
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

    it('refuses with branch-mismatch, merging and touching nothing, when the ready PR\'s head branch is not the task\'s own branch', async () => {
      const timelineBefore = await readTimeline()
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult({ headRefName: 'claude/some-other-task' }) })
      const result = await mergeTask(tasksDir, task({ worktree: worktreePath }))
      expect(result).toEqual({ outcome: 'branch-mismatch', prNumber: '42', expectedBranch: branch, actualBranch: 'claude/some-other-task' })
      expect(mergePullRequestMock).not.toHaveBeenCalled()
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
      expect(await readStatus()).toBe('waiting: QA passed, ready to merge\n')
      expect(await readTimeline()).toBe(timelineBefore)
    })

    it('reports branch-mismatch, not the misleading "not open", when a wrong PR is MERGED', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({
        ok: true,
        readiness: { ...blockedResult('not-open'), headRefName: 'claude/some-other-task' },
      })
      const result = await mergeTask(tasksDir, task())
      expect(result).toEqual({ outcome: 'branch-mismatch', prNumber: '42', expectedBranch: branch, actualBranch: 'claude/some-other-task' })
      expect(mergePullRequestMock).not.toHaveBeenCalled()
    })

    it('still reports the gate\'s own blockers when the not-ready PR is the task\'s own branch', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: blockedResult('conflicts') })
      expect((await mergeTask(tasksDir, task())).outcome).toBe('blocked')
    })

    it('falls through to blocked when a malformed read gives no head branch to compare', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: { ...blockedResult('malformed'), headRefName: null } })
      expect((await mergeTask(tasksDir, task())).outcome).toBe('blocked')
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
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null, sessions: NO_SESSIONS })

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
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null, sessions: NO_SESSIONS })
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
    })

    it('when a task has no worktree: markTaskDone still runs (git branch -d only) and the remote delete still fires', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: true })

      const result = await mergeTask(tasksDir, task({ worktree: null }))
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null, sessions: NO_SESSIONS })
      expect(deleteRemoteBranchMock).toHaveBeenCalledWith(repoPath, branch)
    })

    it('retires the task sessions exactly once on a merge and returns the summary', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      deleteRemoteBranchMock.mockResolvedValueOnce({ ok: true })
      retireSessionsOfTaskMock.mockResolvedValueOnce(SOME_SESSIONS)

      const result = await mergeTask(tasksDir, task({ worktree: worktreePath, tmuxSession: 'worker-merge-task-test-s2' }))

      expect(retireSessionsOfTaskMock).toHaveBeenCalledTimes(1)
      expect(retireSessionsOfTaskMock).toHaveBeenCalledWith(tasksDir, { slug, tmuxSession: 'worker-merge-task-test-s2' })
      expect(result).toEqual({ outcome: 'merged', prNumber: '42', cleanupError: null, sessions: SOME_SESSIONS })
      // After the worktree cleanup, not before it.
      await expect(fs.access(worktreePath)).rejects.toThrow()
    })

    it.each([
      ['no PR', async () => mergeTask(tasksDir, task({ stageHistory: [] }))],
      ['a gate that is unavailable', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: false, error: 'gh: network error' })
        return mergeTask(tasksDir, task())
      }],
      ['a blocked gate', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: blockedResult() })
        return mergeTask(tasksDir, task())
      }],
      ['a branch mismatch', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult({ headRefName: 'claude/other' }) })
        return mergeTask(tasksDir, task())
      }],
      ['a merge that fails', async () => {
        checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
        mergePullRequestMock.mockResolvedValueOnce({ ok: false, error: 'gh: nope' })
        return mergeTask(tasksDir, task())
      }],
    ])('never retires a session for %s', async (_label, run) => {
      await run()
      expect(retireSessionsOfTaskMock).not.toHaveBeenCalled()
    })

    it('does not retire sessions when recording the merge fails before markTaskDone', async () => {
      checkMergeReadinessMock.mockResolvedValueOnce({ ok: true, readiness: readyResult() })
      mergePullRequestMock.mockResolvedValueOnce({ ok: true })
      await fs.rm(path.join(tasksDir, slug, 'TIMELINE'))
      await fs.mkdir(path.join(tasksDir, slug, 'TIMELINE'))

      await expect(mergeTask(tasksDir, task())).rejects.toThrow()
      expect(retireSessionsOfTaskMock).not.toHaveBeenCalled()
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
      expect(result).toEqual({ cleanupError: null, sessions: NO_SESSIONS })
      expect(await readStatus()).toBe('done\n')
      await expect(fs.access(worktreePath)).rejects.toThrow()
    })

    it('still writes done for a merged ds task: /mark-done is the manual way out of the adopt hand-off', async () => {
      await fs.writeFile(path.join(tasksDir, slug, 'STATUS'), 'waiting: merged, ready for adopt\n')
      await markTaskDone(tasksDir, task({ kind: 'ds' }))
      expect(await readStatus()).toBe('done\n')
    })

    it('writes the given final STATUS instead of done, with the same cleanup', async () => {
      const result = await markTaskDone(tasksDir, task({ worktree: worktreePath }), 'waiting: merged, ready for adopt')
      expect(result).toEqual({ cleanupError: null, sessions: NO_SESSIONS })
      expect(await readStatus()).toBe('waiting: merged, ready for adopt\n')
      await expect(fs.access(worktreePath)).rejects.toThrow()
      expect(retireSessionsOfTaskMock).toHaveBeenCalledTimes(1)
    })

    it('never calls deleteRemoteBranch — it has no proof the branch was ever merged', async () => {
      await markTaskDone(tasksDir, task({ worktree: worktreePath }))
      expect(deleteRemoteBranchMock).not.toHaveBeenCalled()
    })

    it('retires the task sessions once, after the worktree cleanup, and returns the summary', async () => {
      retireSessionsOfTaskMock.mockResolvedValueOnce(SOME_SESSIONS)
      const result = await markTaskDone(tasksDir, task({ worktree: worktreePath, tmuxSession: 'worker-merge-task-test-s2' }))
      expect(retireSessionsOfTaskMock).toHaveBeenCalledTimes(1)
      expect(retireSessionsOfTaskMock).toHaveBeenCalledWith(tasksDir, { slug, tmuxSession: 'worker-merge-task-test-s2' })
      expect(result.sessions).toEqual(SOME_SESSIONS)
    })

    it('still retires sessions when the worktree cleanup is refused, since the task is done either way', async () => {
      await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')
      const result = await markTaskDone(tasksDir, task({ worktree: worktreePath }))
      expect(result.cleanupError).toMatch(/couldn't remove worktree/)
      expect(retireSessionsOfTaskMock).toHaveBeenCalledTimes(1)
    })

    it('does not retire sessions when writing STATUS done fails', async () => {
      await fs.rm(path.join(tasksDir, slug), { recursive: true })
      await expect(markTaskDone(tasksDir, task())).rejects.toThrow()
      expect(retireSessionsOfTaskMock).not.toHaveBeenCalled()
    })

    it('surfaces a cleanup failure without failing the STATUS write', async () => {
      await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'uncommitted\n')
      const result = await markTaskDone(tasksDir, task({ worktree: worktreePath }))
      expect(result.cleanupError).toMatch(/couldn't remove worktree/)
      expect(await readStatus()).toBe('done\n')
    })
  })
})
