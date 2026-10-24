import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tsxBin = path.resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')
// Each case cold-starts tsx in a child process; under a parallel full-suite run
// that outruns vitest's 5s default.
const CLI_TEST_TIMEOUT_MS = 30_000
const cliPath = path.resolve(import.meta.dirname, 'worktreeSweepCli.ts')

let sandbox: string
let tasksDir: string
let worktreesDir: string
let reposDir: string
let repoPath: string

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function makeDoneTask(slug: string) {
  const branch = `claude/${slug}`
  fs.mkdirSync(path.join(tasksDir, slug), { recursive: true })
  fs.writeFileSync(path.join(tasksDir, slug, 'STATUS'), 'done\n')
  fs.writeFileSync(path.join(tasksDir, slug, 'TASK.md'), `# ${slug}\n\n## Workspace\n- Repo: proj\n- Branch: ${branch}\n`)
  git(repoPath, 'worktree', 'add', '-q', '-b', branch, path.join(worktreesDir, slug))
  return path.join(worktreesDir, slug)
}

function runCli(args: string[], input = '') {
  const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: tasksDir, WORKTREES_DIR: worktreesDir, REPOS_DIR: reposDir }
  const result = spawnSync(tsxBin, [cliPath, ...args], { env, cwd: sandbox, input, encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-sweep-cli-')))
  tasksDir = path.join(sandbox, 'tasks')
  worktreesDir = path.join(sandbox, 'worktrees')
  reposDir = path.join(sandbox, 'repos')
  repoPath = path.join(reposDir, 'proj')
  fs.mkdirSync(tasksDir)
  fs.mkdirSync(worktreesDir)
  fs.mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-q', '-b', 'master')
  git(repoPath, 'config', 'user.email', 'test@example.com')
  git(repoPath, 'config', 'user.name', 'Test')
  git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

describe('worktree-sweep (report)', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('prints the resolved tasks dir and lists a removable worktree, exit 0', () => {
    makeDoneTask('clean-done')

    const result = runCli([])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`tasks dir: ${tasksDir}`)
    expect(result.stdout).toContain('clean-done')
    expect(result.stdout).toContain('safe to remove')
  })

  it('--json prints a machine-readable list and nothing else on stdout', () => {
    makeDoneTask('clean-done')

    const result = runCli(['--json'])

    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ tasksDir, entries: [{ slug: 'clean-done', verdict: 'safe' }] })
  })

  it('is read-only: the report never removes anything', () => {
    const worktree = makeDoneTask('clean-done')
    runCli([])
    expect(fs.existsSync(worktree)).toBe(true)
  })
})

describe('worktree-sweep --remove', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('removes after a "y" answer on stdin', () => {
    const worktree = makeDoneTask('clean-done')

    const result = runCli(['--remove', 'clean-done'], 'y\n')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('removed clean-done')
    expect(fs.existsSync(worktree)).toBe(false)
  })

  it('--json keeps stdout parseable when it has to ask: the prompt goes to stderr', () => {
    const worktree = makeDoneTask('clean-done')

    const result = runCli(['--json', '--remove', 'clean-done'], 'y\n')

    expect(JSON.parse(result.stdout)).toMatchObject({ tasksDir, outcomes: [{ slug: 'clean-done', result: 'removed' }] })
    expect(result.stderr).toContain('[y/N]')
    expect(fs.existsSync(worktree)).toBe(false)
  })

  it('removes nothing on any other answer', () => {
    const worktree = makeDoneTask('clean-done')

    const result = runCli(['--remove', 'clean-done'], 'n\n')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('declined clean-done')
    expect(fs.existsSync(worktree)).toBe(true)
  })

  it('removes without asking when --yes is given', () => {
    const worktree = makeDoneTask('clean-done')

    const result = runCli(['--remove', 'clean-done', '--yes'])

    expect(result.status).toBe(0)
    expect(fs.existsSync(worktree)).toBe(false)
  })

  it('refuses a dirty worktree with exit 2 and logs the reason', () => {
    const worktree = makeDoneTask('dirty-done')
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'wip\n')

    const result = runCli(['--remove', 'dirty-done', '--yes'])

    expect(result.status).toBe(2)
    expect(result.stdout).toContain('refused dirty-done')
    expect(result.stdout).toContain('uncommitted or untracked')
    expect(fs.existsSync(worktree)).toBe(true)
  })

  it('--all-clean removes every safe entry and leaves the dirty one', () => {
    const clean = makeDoneTask('clean-done')
    const dirty = makeDoneTask('dirty-done')
    fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'wip\n')

    const result = runCli(['--all-clean', '--yes'])

    expect(result.status).toBe(0)
    expect(fs.existsSync(clean)).toBe(false)
    expect(fs.existsSync(dirty)).toBe(true)
  })

  it('exits 1 with usage when --remove has no slug', () => {
    const result = runCli(['--remove'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage')
  })

  it('exits 1 with usage on an unknown flag', () => {
    const result = runCli(['--force'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage')
  })
})
