import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseWorkerStartDirArgs,
  prepareStartDir,
  recordSetupFailure,
  StartDirError,
  type StartDirRequest,
} from './workerStartDir.js'

const BRANCH = 'claude/demo-task'
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false']

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', [...GIT_IDENTITY, ...args], { cwd, env: GIT_ENV })
  return stdout.trim()
}

describe('workerStartDir', () => {
  let root: string
  let originPath: string
  let repoPath: string
  let taskDir: string
  let worktreesDir: string
  let request: StartDirRequest

  async function pushToOrigin(branch: string, file: string): Promise<string> {
    const clone = fs.mkdtempSync(path.join(root, 'clone-'))
    await git(root, ['clone', originPath, clone])
    await git(clone, ['checkout', '-B', branch])
    fs.writeFileSync(path.join(clone, file), `${file}\n`)
    await git(clone, ['add', file])
    await git(clone, ['commit', '-m', file])
    await git(clone, ['push', 'origin', branch])
    return git(clone, ['rev-parse', 'HEAD'])
  }

  beforeEach(async () => {
    // A space in the root covers a --task-dir and worktree path with a space.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker start dir-')))
    originPath = path.join(root, 'origin.git')
    const seed = path.join(root, 'seed')
    await git(root, ['init', '--bare', '-b', 'main', originPath])
    await git(root, ['init', '-b', 'main', seed])
    fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n')
    await git(seed, ['add', 'README.md'])
    await git(seed, ['commit', '-m', 'seed'])
    await git(seed, ['push', originPath, 'main'])
    const reposDir = path.join(root, 'repos')
    repoPath = path.join(reposDir, 'demo-repo')
    await git(root, ['clone', originPath, repoPath])

    taskDir = path.join(root, 'tasks', 'demo-task')
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, 'TASK.md'), '# brief v1\n')
    fs.writeFileSync(path.join(taskDir, 'STATUS'), 'working\n')
    worktreesDir = path.join(root, 'worktrees')
    request = { taskDir, repo: 'demo-repo', branch: BRANCH, mode: 'create', copyTaskMd: false, reposDir, worktreesDir }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const worktreePath = (): string => path.join(worktreesDir, 'demo-task')

  describe('create', () => {
    it('forks a new branch from the fetched origin tip without touching the primary checkout', async () => {
      const primaryHead = await git(repoPath, ['rev-parse', 'HEAD'])
      const originTip = await pushToOrigin('main', 'later.txt')

      const startDir = await prepareStartDir({ ...request, copyTaskMd: true })

      expect(startDir).toBe(worktreePath())
      expect(await git(startDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
      expect(await git(startDir, ['rev-parse', 'HEAD'])).toBe(originTip)
      expect(fs.readFileSync(path.join(startDir, 'TASK.md'), 'utf-8')).toBe('# brief v1\n')
      expect(await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
      expect(await git(repoPath, ['rev-parse', 'HEAD'])).toBe(primaryHead)
    })

    it('checks out an existing local branch as it is', async () => {
      await git(repoPath, ['branch', BRANCH])
      const branchTip = await git(repoPath, ['rev-parse', BRANCH])
      await pushToOrigin('main', 'later.txt')

      const startDir = await prepareStartDir(request)

      expect(await git(startDir, ['rev-parse', 'HEAD'])).toBe(branchTip)
    })

    it('checks out a branch that exists only on origin', async () => {
      const remoteTip = await pushToOrigin(BRANCH, 'work.txt')

      const startDir = await prepareStartDir(request)

      expect(await git(startDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
      expect(await git(startDir, ['rev-parse', 'HEAD'])).toBe(remoteTip)
    })

    it('reuses a worktree already on the branch and refreshes its TASK.md', async () => {
      await prepareStartDir(request)
      const before = await git(repoPath, ['worktree', 'list', '--porcelain'])
      fs.writeFileSync(path.join(taskDir, 'TASK.md'), '# brief v2\n')

      const startDir = await prepareStartDir({ ...request, copyTaskMd: true })

      expect(startDir).toBe(worktreePath())
      expect(await git(repoPath, ['worktree', 'list', '--porcelain'])).toBe(before)
      expect(fs.readFileSync(path.join(startDir, 'TASK.md'), 'utf-8')).toBe('# brief v2\n')
    })

    it('refuses a worktree on another branch and leaves it alone', async () => {
      await git(repoPath, ['worktree', 'add', '-b', 'claude/other', worktreePath(), 'origin/main'])

      await expect(prepareStartDir(request)).rejects.toThrow(/claude\/other/)
      expect(await git(worktreePath(), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('claude/other')
    })

    it('refuses a plain directory in the worktree spot', async () => {
      fs.mkdirSync(worktreePath(), { recursive: true })
      fs.writeFileSync(path.join(worktreePath(), 'keep.txt'), 'keep\n')

      await expect(prepareStartDir(request)).rejects.toThrow(/not a worktree of/)
      expect(fs.readFileSync(path.join(worktreePath(), 'keep.txt'), 'utf-8')).toBe('keep\n')
    })

    it('stops when the fetch fails, and creates no worktree', async () => {
      fs.rmSync(originPath, { recursive: true })

      await expect(prepareStartDir(request)).rejects.toThrow(/fetch/)
      expect(fs.existsSync(worktreePath())).toBe(false)
    })

    it('stops when the repo checkout is missing', async () => {
      fs.rmSync(repoPath, { recursive: true })

      await expect(prepareStartDir(request)).rejects.toThrow(/no git checkout/)
    })
  })

  describe('reuse', () => {
    it('locates an existing worktree and leaves its TASK.md alone without --copy-task-md', async () => {
      await prepareStartDir({ ...request, copyTaskMd: true })
      fs.writeFileSync(path.join(taskDir, 'TASK.md'), '# brief v2\n')

      const startDir = await prepareStartDir({ ...request, mode: 'reuse' })

      expect(startDir).toBe(worktreePath())
      expect(fs.readFileSync(path.join(startDir, 'TASK.md'), 'utf-8')).toBe('# brief v1\n')
    })

    it('fails on a missing worktree and creates nothing', async () => {
      await expect(prepareStartDir({ ...request, mode: 'reuse' })).rejects.toThrow(StartDirError)
      expect(fs.existsSync(worktreePath())).toBe(false)
    })

    it('fails on a worktree on another branch', async () => {
      await git(repoPath, ['worktree', 'add', '-b', 'claude/other', worktreePath(), 'origin/main'])

      await expect(prepareStartDir({ ...request, mode: 'reuse' })).rejects.toThrow(/claude\/other/)
    })
  })

  describe('none', () => {
    it('returns the task dir and runs no git', async () => {
      fs.rmSync(repoPath, { recursive: true })

      expect(await prepareStartDir({ ...request, mode: 'none' })).toBe(taskDir)
    })
  })

  describe('recordSetupFailure', () => {
    const now = new Date('2026-11-10T08:09:10.123Z')

    it('writes a waiting STATUS and a TIMELINE line under the stage', async () => {
      await recordSetupFailure(taskDir, 'qa', 'no worktree', now)

      expect(fs.readFileSync(path.join(taskDir, 'STATUS'), 'utf-8')).toBe('waiting: worktree setup failed — no worktree\n')
      expect(fs.readFileSync(path.join(taskDir, 'TIMELINE'), 'utf-8')).toBe('2026-11-10T08:09:10Z qa worktree setup failed: no worktree\n')
    })

    it('falls back to the dispatch stage when COCKPIT_STAGE is empty', async () => {
      await recordSetupFailure(taskDir, '', 'boom', now)

      expect(fs.readFileSync(path.join(taskDir, 'TIMELINE'), 'utf-8')).toBe('2026-11-10T08:09:10Z dispatch worktree setup failed: boom\n')
    })

    it('keeps a multi-line cause on one line', async () => {
      await recordSetupFailure(taskDir, 'dev', 'fatal: a\nfatal: b', now)

      expect(fs.readFileSync(path.join(taskDir, 'TIMELINE'), 'utf-8')).toBe('2026-11-10T08:09:10Z dev worktree setup failed: fatal: a fatal: b\n')
    })
  })

  describe('parseWorkerStartDirArgs', () => {
    const base = ['--task-dir', '/abs/tasks/demo task', '--repo', 'r', '--branch', 'b']

    it('reads every flag', () => {
      expect(parseWorkerStartDirArgs([...base, '--worktree', 'reuse', '--copy-task-md'])).toEqual({
        ok: true,
        args: { taskDir: '/abs/tasks/demo task', repo: 'r', branch: 'b', mode: 'reuse', copyTaskMd: true },
      })
    })

    it('refuses an unknown --worktree value', () => {
      expect(parseWorkerStartDirArgs([...base, '--worktree', 'sideways'])).toMatchObject({ ok: false, error: expect.stringMatching(/sideways/) })
    })

    it('refuses a relative --task-dir', () => {
      expect(parseWorkerStartDirArgs(['--task-dir', 'tasks/x', '--repo', 'r', '--branch', 'b', '--worktree', 'none'])).toMatchObject({
        ok: false,
        error: expect.stringMatching(/absolute/),
      })
    })

    it('refuses a missing flag or a flag with no value', () => {
      expect(parseWorkerStartDirArgs(['--task-dir', '/abs/x', '--repo', 'r', '--worktree', 'none'])).toMatchObject({ ok: false })
      expect(parseWorkerStartDirArgs([...base, '--worktree'])).toMatchObject({ ok: false })
    })

    it('refuses an unknown flag', () => {
      expect(parseWorkerStartDirArgs([...base, '--worktree', 'none', '--force'])).toMatchObject({ ok: false, error: expect.stringMatching(/--force/) })
    })
  })
})
