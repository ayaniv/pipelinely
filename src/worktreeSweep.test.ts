import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  collectSweepEntries,
  removeSweepEntries,
  formatSweepReport,
  type SweepDeps,
} from './worktreeSweep.js'

const REPO = 'proj'

let root: string
let tasksDir: string
let repoPath: string
let savedEnv: Record<string, string | undefined>

const noTmux: SweepDeps = { listTmuxSessions: async () => [], measureSize: async () => 1024 }

async function git(cwd: string, ...args: string[]) {
  return execa('git', args, { cwd })
}

// A task dir with the TASK.md/STATUS the parser reads, plus (unless
// withWorktree is false) a real git worktree under the fixture's own
// WORKTREES_DIR — never the developer's ~/Dev/worktrees.
async function makeTask(slug: string, status: string, opts: { withWorktree?: boolean } = {}) {
  const branch = `claude/${slug}`
  const taskDir = path.join(tasksDir, slug)
  await fs.mkdir(taskDir, { recursive: true })
  await fs.writeFile(path.join(taskDir, 'STATUS'), `${status}\n`)
  await fs.writeFile(path.join(taskDir, 'TASK.md'), `# ${slug}\n\n## Workspace\n- Repo: ${REPO}\n- Branch: ${branch}\n`)
  const worktree = path.join(process.env.WORKTREES_DIR!, slug)
  if (opts.withWorktree !== false) await git(repoPath, 'worktree', 'add', '-q', '-b', branch, worktree)
  return { slug, branch, worktree }
}

async function commitInWorktree(worktree: string, file: string) {
  await fs.writeFile(path.join(worktree, file), 'x\n')
  await git(worktree, 'add', file)
  await git(worktree, 'commit', '-q', '-m', `add ${file}`)
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-sweep-')))
  tasksDir = path.join(root, 'tasks')
  repoPath = path.join(root, 'repos', REPO)
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.mkdir(repoPath, { recursive: true })
  await fs.mkdir(path.join(root, 'worktrees'))
  savedEnv = { WORKTREES_DIR: process.env.WORKTREES_DIR, REPOS_DIR: process.env.REPOS_DIR }
  process.env.WORKTREES_DIR = path.join(root, 'worktrees')
  process.env.REPOS_DIR = path.join(root, 'repos')

  await git(repoPath, 'init', '-q', '-b', 'master')
  await git(repoPath, 'config', 'user.email', 'test@example.com')
  await git(repoPath, 'config', 'user.name', 'Test')
  await fs.writeFile(path.join(repoPath, 'README.md'), 'init\n')
  await git(repoPath, 'add', 'README.md')
  await git(repoPath, 'commit', '-q', '-m', 'init')
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

describe('collectSweepEntries', () => {
  it('lists a done task with a clean, merged worktree as safe to remove', async () => {
    const task = await makeTask('clean-done', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')
    await git(repoPath, 'merge', '-q', task.branch)

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry).toMatchObject({
      slug: 'clean-done',
      worktree: task.worktree,
      branch: task.branch,
      hasUncommittedWork: false,
      isMerged: true,
      tmuxSessions: [],
      sizeBytes: 1024,
      verdict: 'safe',
      reasons: [],
    })
  })

  it('treats a "done: <note>" STATUS as done', async () => {
    await makeTask('noted-done', 'done: merged via PR #7')
    const entries = await collectSweepEntries(tasksDir, noTmux)
    expect(entries.map((e) => e.slug)).toEqual(['noted-done'])
  })

  it('flags uncommitted and untracked files as needing the developer', async () => {
    const task = await makeTask('dirty-done', 'done')
    await fs.writeFile(path.join(task.worktree, 'untracked.txt'), 'wip\n')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.hasUncommittedWork).toBe(true)
    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons).toContain('uncommitted or untracked files')
  })

  it('flags a branch with commits not merged into the base as needing the developer', async () => {
    const task = await makeTask('unmerged-done', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.isMerged).toBe(false)
    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons).toContain('branch is not merged into the base')
  })

  it('never lists a task whose STATUS is not done', async () => {
    await makeTask('still-working', 'working')
    await makeTask('waiting-on-pr', 'waiting: PR open, ready for CR')
    expect(await collectSweepEntries(tasksDir, noTmux)).toEqual([])
  })

  it('never lists a done task whose worktree directory is already gone', async () => {
    await makeTask('already-swept', 'done', { withWorktree: false })
    expect(await collectSweepEntries(tasksDir, noTmux)).toEqual([])
  })

  it('reports surviving worker tmux sessions without touching them', async () => {
    await makeTask('has-session', 'done')
    const deps: SweepDeps = {
      ...noTmux,
      listTmuxSessions: async () => ['worker-has-session', 'worker-has-session-qa', 'worker-other', 'orchestrator'],
    }

    const [entry] = await collectSweepEntries(tasksDir, deps)

    expect(entry.tmuxSessions).toEqual(['worker-has-session', 'worker-has-session-qa'])
  })

  it('uses the retirement matcher: never credits another task\'s sessions or an unknown suffix', async () => {
    await makeTask('foo', 'done')
    const deps: SweepDeps = {
      ...noTmux,
      listTmuxSessions: async () => ['worker-foo', 'worker-foo-qa2', 'worker-foo-bar', 'worker-foo-m1-qa', 'worker-foo-unknown'],
    }

    const [entry] = await collectSweepEntries(tasksDir, deps)

    expect(entry.tmuxSessions).toEqual(['worker-foo', 'worker-foo-qa2'])
  })

  it('credits a suffix-shaped session to the longer slug that owns it, even when that task is not done', async () => {
    await makeTask('foo', 'done')
    await makeTask('foo-fix', 'working')
    const deps: SweepDeps = { ...noTmux, listTmuxSessions: async () => ['worker-foo', 'worker-foo-fix', 'worker-foo-s2'] }

    const [entry] = await collectSweepEntries(tasksDir, deps)

    expect(entry.slug).toBe('foo')
    expect(entry.tmuxSessions).toEqual(['worker-foo', 'worker-foo-s2'])
  })

  it('marks an entry as errored, with the reason, when a git read fails', async () => {
    const task = await makeTask('git-broken', 'done')
    await fs.rm(path.join(task.worktree, '.git'))

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons.join(' ')).toMatch(/could not read git state/)
  })
})

describe('collectSweepEntries — what removal would silently destroy', () => {
  // Fixture-local ignore rule: info/exclude lives in the shared git dir, so no
  // untracked .gitignore shows up as dirt itself.
  async function ignoreInFixture(pattern: string) {
    await fs.appendFile(path.join(repoPath, '.git', 'info', 'exclude'), `${pattern}\n`)
  }

  it('flags a gitignored file, which a non-forced worktree remove would delete without asking', async () => {
    const task = await makeTask('has-env', 'done')
    await ignoreInFixture('.env.local')
    await fs.writeFile(path.join(task.worktree, '.env.local'), 'SECRET=1\n')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons.join(' ')).toMatch(/gitignored.*\.env\.local/)
  })

  it('ignores regenerable gitignored dirs such as node_modules and dist', async () => {
    const task = await makeTask('has-build', 'done')
    await ignoreInFixture('node_modules/')
    await ignoreInFixture('dist/')
    await fs.mkdir(path.join(task.worktree, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(task.worktree, 'node_modules', 'pkg', 'index.js'), 'x\n')
    await fs.mkdir(path.join(task.worktree, 'dist'))
    await fs.writeFile(path.join(task.worktree, 'dist', 'out.js'), 'x\n')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.verdict).toBe('safe')
  })

  it('flags a detached HEAD carrying commits that task.branch does not have', async () => {
    const task = await makeTask('detached-done', 'done')
    await git(task.worktree, 'checkout', '-q', '--detach')
    await commitInWorktree(task.worktree, 'orphan.txt')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons.join(' ')).toMatch(/not on the task branch/)
  })

  it('flags a worktree that has a different branch checked out', async () => {
    const task = await makeTask('other-branch-done', 'done')
    await git(task.worktree, 'checkout', '-q', '-b', 'scratch')
    await commitInWorktree(task.worktree, 'scratch.txt')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons.join(' ')).toMatch(/not on the task branch/)
  })
})

describe('collectSweepEntries — with an origin remote', () => {
  let remotePath: string

  async function addOrigin() {
    remotePath = path.join(root, 'origin.git')
    await git(root, 'init', '-q', '--bare', '-b', 'master', remotePath)
    await git(repoPath, 'remote', 'add', 'origin', remotePath)
    await git(repoPath, 'push', '-q', 'origin', 'master')
    await git(repoPath, 'remote', 'set-head', 'origin', 'master')
  }

  it('is safe when the branch is merged into origin/HEAD and the local base alike', async () => {
    await addOrigin()
    const task = await makeTask('merged-everywhere', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')
    await git(repoPath, 'merge', '-q', task.branch)
    await git(repoPath, 'push', '-q', 'origin', 'master')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry).toMatchObject({ isMerged: true, verdict: 'safe' })
  })

  it('does not call it safe when only origin has the merge, because branch -d would then refuse', async () => {
    await addOrigin()
    const task = await makeTask('merged-on-origin-only', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')
    await git(task.worktree, 'push', '-q', 'origin', `${task.branch}:master`)
    await git(repoPath, 'fetch', '-q', 'origin')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry.verdict).toBe('needs-developer')
    expect(entry.reasons.join(' ')).toMatch(/branch -d/)
  })

  it('judges by the branch upstream when one is set, the way branch -d does', async () => {
    await addOrigin()
    const task = await makeTask('upstream-merged', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')
    await git(task.worktree, 'push', '-q', '-u', 'origin', task.branch)
    await git(task.worktree, 'push', '-q', 'origin', `${task.branch}:master`)
    await git(repoPath, 'fetch', '-q', 'origin')

    const [entry] = await collectSweepEntries(tasksDir, noTmux)

    expect(entry).toMatchObject({ isMerged: true, verdict: 'safe' })
  })
})

describe('removeSweepEntries', () => {
  it('removes a safe entry non-forced and deletes its merged branch', async () => {
    const task = await makeTask('clean-done', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')
    await git(repoPath, 'merge', '-q', task.branch)

    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['clean-done'] }, noTmux)

    expect(outcome).toMatchObject({ slug: 'clean-done', result: 'removed' })
    await expect(fs.access(task.worktree)).rejects.toThrow()
    expect((await git(repoPath, 'branch', '--list', task.branch)).stdout.trim()).toBe('')
  })

  it('refuses a dirty worktree and leaves it on disk', async () => {
    const task = await makeTask('dirty-done', 'done')
    await fs.writeFile(path.join(task.worktree, 'untracked.txt'), 'wip\n')

    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['dirty-done'] }, noTmux)

    expect(outcome).toMatchObject({ slug: 'dirty-done', result: 'refused', reason: expect.stringMatching(/uncommitted or untracked/) })
    await expect(fs.access(task.worktree)).resolves.toBeUndefined()
  })

  it('refuses an unmerged branch and keeps both worktree and branch', async () => {
    const task = await makeTask('unmerged-done', 'done')
    await commitInWorktree(task.worktree, 'feature.txt')

    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['unmerged-done'] }, noTmux)

    expect(outcome).toMatchObject({ result: 'refused' })
    await expect(fs.access(task.worktree)).resolves.toBeUndefined()
    expect((await git(repoPath, 'branch', '--list', task.branch)).stdout.trim()).not.toBe('')
  })

  it('refuses a slug whose task is not done, even though its worktree exists', async () => {
    const task = await makeTask('still-working', 'working')

    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['still-working'] }, noTmux)

    expect(outcome).toMatchObject({ result: 'refused', reason: expect.stringMatching(/not a done task with a worktree/) })
    await expect(fs.access(task.worktree)).resolves.toBeUndefined()
  })

  it('refuses a slug that does not exist at all', async () => {
    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['no-such-task'] }, noTmux)
    expect(outcome).toMatchObject({ slug: 'no-such-task', result: 'refused' })
  })

  it('--all-clean removes only the safe entries', async () => {
    const clean = await makeTask('clean-done', 'done')
    const dirty = await makeTask('dirty-done', 'done')
    await fs.writeFile(path.join(dirty.worktree, 'untracked.txt'), 'wip\n')

    const outcomes = await removeSweepEntries(tasksDir, { allClean: true }, noTmux)

    expect(outcomes.map((o) => [o.slug, o.result])).toEqual([['clean-done', 'removed']])
    await expect(fs.access(clean.worktree)).rejects.toThrow()
    await expect(fs.access(dirty.worktree)).resolves.toBeUndefined()
  })

  it('reports a failing git removal instead of swallowing it', async () => {
    await makeTask('clean-done', 'done')
    const deps: SweepDeps = {
      ...noTmux,
      removeWorktreeAndBranch: async () => ({ ok: false, error: "couldn't remove worktree: boom" }),
    }

    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['clean-done'] }, deps)

    expect(outcome).toEqual({ slug: 'clean-done', result: 'failed', reason: "couldn't remove worktree: boom" })
  })

  it('does not remove an entry the confirm callback declines', async () => {
    const task = await makeTask('clean-done', 'done')

    const [outcome] = await removeSweepEntries(tasksDir, { slugs: ['clean-done'], confirm: async () => false }, noTmux)

    expect(outcome).toMatchObject({ result: 'declined' })
    await expect(fs.access(task.worktree)).resolves.toBeUndefined()
  })

  it('asks the confirm callback about the entries it is about to remove', async () => {
    await makeTask('clean-done', 'done')
    const asked: string[][] = []

    await removeSweepEntries(
      tasksDir,
      { slugs: ['clean-done'], confirm: async (entries) => (asked.push(entries.map((e) => e.slug)), true) },
      noTmux,
    )

    expect(asked).toEqual([['clean-done']])
  })
})

describe('formatSweepReport', () => {
  it('prints one block per entry with the safe/needs-developer verdict', async () => {
    await makeTask('clean-done', 'done')
    const dirty = await makeTask('dirty-done', 'done')
    await fs.writeFile(path.join(dirty.worktree, 'untracked.txt'), 'wip\n')

    const text = formatSweepReport(await collectSweepEntries(tasksDir, noTmux)).join('\n')

    expect(text).toContain('clean-done')
    expect(text).toContain('safe to remove')
    expect(text).toContain('needs the developer')
  })

  it('says so when there is nothing to sweep', () => {
    expect(formatSweepReport([]).join('\n')).toMatch(/nothing to sweep/i)
  })
})
