import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

// Start each worker's claude session inside its worktree (tech-design.md).
//
// Nothing here touches the dev server, dispatch-tab.sh, osascript, iTerm2, tmux
// or the developer's real HOME: every git repo, worktree, tasks dir and
// ~/.claude/projects folder is a scratch dir, HOME is a scratch dir whose
// Dev/pipelinely links to this checkout, and `claude` is a stub on PATH.
//
// Committed red (tagged @pending) during planning, before any implementation.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const PROMPT_PATH = path.join(REPO_ROOT, 'orchestrator-prompt.md')
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills')
const WRITE_METRICS = path.join(REPO_ROOT, 'scripts', 'write-metrics.sh')

const SLUG = 'demo-task'
const BRANCH = `claude/${SLUG}`
const REPO = 'demo-repo'
const FAILED_STATUS_PREFIX = 'waiting: worktree setup failed'

// Variables the spawned processes must not inherit from the developer's shell.
const SCRUBBED_ENV_KEYS = [
  'REPOS_DIR',
  'TASKS_DIR',
  'WORKTREES_DIR',
  'INIT_CWD',
  'COCKPIT_TASK_SLUG',
  'COCKPIT_STAGE',
  'CLAUDE_CODE_SESSION_ID',
  'GIT_DIR',
  'GIT_WORK_TREE',
]

const GIT_IDENTITY = ['-c', 'user.name=Pipelinely Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false']

async function makeScratchDir(prefix: string): Promise<string> {
  // realpath: macOS's tmpdir is itself a symlink.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !SCRUBBED_ENV_KEYS.includes(entry[0]),
    ),
  )
  return { ...base, ...extra }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', [...GIT_IDENTITY, ...args], { cwd })
  return stdout.trim()
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

interface Sandbox {
  home: string
  reposDir: string
  worktreesDir: string
  tasksDir: string
  taskDir: string
  repoPath: string
  originPath: string
  worktreePath: string
  env: Record<string, string>
}

// A bare origin with one commit on <defaultBranch>, cloned into
// <reposDir>/<repo> — the primary checkout a worker's worktree hangs off.
// The task dir holds the files every dispatch writes before launch.sh runs.
async function makeSandbox(defaultBranch = 'main'): Promise<Sandbox> {
  const home = await makeScratchDir('worker-start-home-')
  const reposDir = path.join(home, 'Dev')
  const worktreesDir = path.join(home, 'Dev', 'worktrees')
  const tasksDir = path.join(home, 'tasks')
  const taskDir = path.join(tasksDir, SLUG)
  const originPath = path.join(home, 'origin.git')
  const seedPath = path.join(home, 'seed')
  const repoPath = path.join(reposDir, REPO)

  await fs.mkdir(taskDir, { recursive: true })
  await fs.mkdir(worktreesDir, { recursive: true })
  // The launch template runs the tool from $HOME/Dev/pipelinely.
  await fs.symlink(REPO_ROOT, path.join(reposDir, 'pipelinely'))

  await execa('git', ['init', '--bare', '-b', defaultBranch, originPath])
  await execa('git', ['init', '-b', defaultBranch, seedPath])
  await fs.writeFile(path.join(seedPath, 'README.md'), 'seed\n')
  await git(seedPath, ['add', 'README.md'])
  await git(seedPath, ['commit', '-m', 'seed'])
  await git(seedPath, ['push', originPath, defaultBranch])
  await execa('git', ['clone', originPath, repoPath])

  await fs.writeFile(path.join(taskDir, 'TASK.md'), '# Demo task\n\n## Mode: implement\n')
  await fs.writeFile(path.join(taskDir, 'STATUS'), 'working\n')

  const env = cleanEnv({
    HOME: home,
    REPOS_DIR: reposDir,
    WORKTREES_DIR: worktreesDir,
    TASKS_DIR: tasksDir,
    COCKPIT_TASK_SLUG: SLUG,
    COCKPIT_STAGE: 'dev',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  })

  return {
    home,
    reposDir,
    worktreesDir,
    tasksDir,
    taskDir,
    repoPath,
    originPath,
    worktreePath: path.join(worktreesDir, SLUG),
    env,
  }
}

// Pushes one more commit to origin's <branch> from a throwaway clone, so a
// fresh worktree can be checked against the remote tip rather than the
// primary checkout's stale local branch.
async function advanceOrigin(sandbox: Sandbox, branch: string): Promise<string> {
  const clonePath = await makeScratchDir('worker-start-advance-')
  await execa('git', ['clone', '--branch', branch, sandbox.originPath, clonePath])
  await fs.writeFile(path.join(clonePath, 'later.txt'), 'later\n')
  await git(clonePath, ['add', 'later.txt'])
  await git(clonePath, ['commit', '-m', 'later'])
  await git(clonePath, ['push', 'origin', branch])
  return git(clonePath, ['rev-parse', 'HEAD'])
}

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function startDir(sandbox: Sandbox, flags: string[]): Promise<CliResult> {
  const result = await execa(
    'npm',
    [
      '--prefix',
      REPO_ROOT,
      'run',
      '--silent',
      'worker-start-dir',
      '--',
      '--task-dir',
      sandbox.taskDir,
      '--repo',
      REPO,
      '--branch',
      BRANCH,
      ...flags,
    ],
    { env: sandbox.env, extendEnv: false, reject: false, cwd: sandbox.home },
  )
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? -1 }
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

async function expectSetupFailure(sandbox: Sandbox, result: CliResult): Promise<void> {
  expect(result.exitCode).not.toBe(0)
  expect(result.stdout.trim()).toBe('')
  expect(result.stderr).toMatch(/^worker-start-dir: /m)
  expect((await readText(path.join(sandbox.taskDir, 'STATUS'))).trim()).toMatch(new RegExp(`^${FAILED_STATUS_PREFIX}`))
  const timeline = await readText(path.join(sandbox.taskDir, 'TIMELINE'))
  expect(timeline).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ dev worktree setup failed: .+$/m)
}

test.describe('worker-start-dir CLI @pending', () => {
  test('create: a new branch gets a worktree from the fetched origin/main tip, and the primary checkout is untouched', async () => {
    const sandbox = await makeSandbox('main')
    const primaryHeadBefore = await git(sandbox.repoPath, ['rev-parse', 'HEAD'])
    const originTip = await advanceOrigin(sandbox, 'main')

    const result = await startDir(sandbox, ['--worktree', 'create', '--copy-task-md'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(sandbox.worktreePath)
    expect(await git(sandbox.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
    expect(await git(sandbox.worktreePath, ['rev-parse', 'HEAD'])).toBe(originTip)
    expect(await readText(path.join(sandbox.worktreePath, 'TASK.md'))).toBe(await readText(path.join(sandbox.taskDir, 'TASK.md')))
    expect(await git(sandbox.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    expect(await git(sandbox.repoPath, ['rev-parse', 'HEAD'])).toBe(primaryHeadBefore)
    expect((await readText(path.join(sandbox.taskDir, 'STATUS'))).trim()).toBe('working')
  })

  test('create: a repo whose default branch is master forks from origin/master', async () => {
    const sandbox = await makeSandbox('master')
    const originTip = await advanceOrigin(sandbox, 'master')

    const result = await startDir(sandbox, ['--worktree', 'create'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await git(sandbox.worktreePath, ['rev-parse', 'HEAD'])).toBe(originTip)
  })

  test('create: a clone with no origin/HEAD still finds origin/main', async () => {
    const sandbox = await makeSandbox('main')
    await git(sandbox.repoPath, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'])
    const originTip = await advanceOrigin(sandbox, 'main')

    const result = await startDir(sandbox, ['--worktree', 'create'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await git(sandbox.worktreePath, ['rev-parse', 'HEAD'])).toBe(originTip)
  })

  test('create: an existing local branch is checked out as is, not recreated', async () => {
    const sandbox = await makeSandbox('main')
    await git(sandbox.repoPath, ['branch', BRANCH])
    await advanceOrigin(sandbox, 'main')
    const branchTip = await git(sandbox.repoPath, ['rev-parse', BRANCH])

    const result = await startDir(sandbox, ['--worktree', 'create'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await git(sandbox.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
    expect(await git(sandbox.worktreePath, ['rev-parse', 'HEAD'])).toBe(branchTip)
  })

  test('create: a branch that exists only on origin is checked out from origin', async () => {
    const sandbox = await makeSandbox('main')
    const clonePath = await makeScratchDir('worker-start-remote-branch-')
    await execa('git', ['clone', sandbox.originPath, clonePath])
    await git(clonePath, ['checkout', '-b', BRANCH])
    await fs.writeFile(path.join(clonePath, 'work.txt'), 'work\n')
    await git(clonePath, ['add', 'work.txt'])
    await git(clonePath, ['commit', '-m', 'work'])
    await git(clonePath, ['push', 'origin', BRANCH])
    const remoteTip = await git(clonePath, ['rev-parse', 'HEAD'])

    const result = await startDir(sandbox, ['--worktree', 'create'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await git(sandbox.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
    expect(await git(sandbox.worktreePath, ['rev-parse', 'HEAD'])).toBe(remoteTip)
  })

  test('create: a worktree already on the branch is reused, with no new commits or worktrees', async () => {
    const sandbox = await makeSandbox('main')
    expect((await startDir(sandbox, ['--worktree', 'create'])).exitCode).toBe(0)
    const worktreesBefore = await git(sandbox.repoPath, ['worktree', 'list', '--porcelain'])
    await fs.writeFile(path.join(sandbox.taskDir, 'TASK.md'), '# Demo task\n\n## Mode: qa\n')

    const result = await startDir(sandbox, ['--worktree', 'create', '--copy-task-md'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(sandbox.worktreePath)
    expect(await git(sandbox.repoPath, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore)
    expect(await readText(path.join(sandbox.worktreePath, 'TASK.md'))).toContain('## Mode: qa')
  })

  test('reuse: an existing worktree is located; without --copy-task-md its own TASK.md is left alone', async () => {
    const sandbox = await makeSandbox('main')
    expect((await startDir(sandbox, ['--worktree', 'create', '--copy-task-md'])).exitCode).toBe(0)
    await fs.writeFile(path.join(sandbox.taskDir, 'TASK.md'), '# Demo task\n\n## Mode: something newer\n')

    const result = await startDir(sandbox, ['--worktree', 'reuse'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(sandbox.worktreePath)
    expect(await readText(path.join(sandbox.worktreePath, 'TASK.md'))).toContain('## Mode: implement')
  })

  test('reuse: a missing worktree fails visibly and creates nothing', async () => {
    const sandbox = await makeSandbox('main')

    const result = await startDir(sandbox, ['--worktree', 'reuse'])

    await expectSetupFailure(sandbox, result)
    expect(await exists(sandbox.worktreePath)).toBe(false)
  })

  test('none: a stage with no worktree starts in its task dir and runs no git', async () => {
    const sandbox = await makeSandbox('main')
    await fs.rm(sandbox.repoPath, { recursive: true })

    const result = await startDir(sandbox, ['--worktree', 'none'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(sandbox.taskDir)
    expect((await readText(path.join(sandbox.taskDir, 'STATUS'))).trim()).toBe('working')
  })

  test('create: a worktree dir on a different branch is refused, not hijacked', async () => {
    const sandbox = await makeSandbox('main')
    await git(sandbox.repoPath, ['worktree', 'add', '-b', 'claude/someone-else', sandbox.worktreePath, 'origin/main'])

    const result = await startDir(sandbox, ['--worktree', 'create'])

    await expectSetupFailure(sandbox, result)
    expect(await git(sandbox.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('claude/someone-else')
  })

  test('create: a plain directory in the worktree spot (not a worktree) is refused', async () => {
    const sandbox = await makeSandbox('main')
    await fs.mkdir(sandbox.worktreePath)
    await fs.writeFile(path.join(sandbox.worktreePath, 'keep.txt'), 'keep\n')

    const result = await startDir(sandbox, ['--worktree', 'create'])

    await expectSetupFailure(sandbox, result)
    expect(await readText(path.join(sandbox.worktreePath, 'keep.txt'))).toBe('keep\n')
  })

  test('create: a fetch failure stops with a visible error instead of forking from a stale base', async () => {
    const sandbox = await makeSandbox('main')
    await fs.rm(sandbox.originPath, { recursive: true })

    const result = await startDir(sandbox, ['--worktree', 'create'])

    await expectSetupFailure(sandbox, result)
    expect(await exists(sandbox.worktreePath)).toBe(false)
  })

  test('create: a missing repo checkout fails visibly', async () => {
    const sandbox = await makeSandbox('main')
    await fs.rm(sandbox.repoPath, { recursive: true })

    const result = await startDir(sandbox, ['--worktree', 'create'])

    await expectSetupFailure(sandbox, result)
  })

  test('bad arguments are refused before any git or STATUS write', async () => {
    const sandbox = await makeSandbox('main')

    const result = await startDir(sandbox, ['--worktree', 'sideways'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/^worker-start-dir: /m)
    expect((await readText(path.join(sandbox.taskDir, 'STATUS'))).trim()).toBe('working')
    expect(await exists(sandbox.worktreePath)).toBe(false)
  })
})

// --- Launch templates ---------------------------------------------------------
// The orchestrator writes launch.sh from orchestrator-prompt.md step 4's bash
// block with literal bytes, so the block itself is the behavior under test.

function bashBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1])
}

function findLaunchTemplate(markdown: string, marker: string): string {
  const block = bashBlocks(markdown).find((candidate) => candidate.includes('exec claude') && candidate.includes(marker))
  if (!block) throw new Error(`no bash launch template containing '${marker}' found`)
  return block
}

function fillPlaceholders(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((filled, [name, value]) => filled.split(`<${name}>`).join(value), template)
}

interface WorkerView {
  exitCode: number
  stderr: string
  claudeRan: boolean
  cwd: string
  prompt: string
}

// Runs a filled launch script under bash with a stub `claude` that records the
// directory it was started in and its prompt. stdin is empty, so the failure
// path's interactive shell exits at once instead of hanging the test.
async function runLaunchScript(sandbox: Sandbox, script: string): Promise<WorkerView> {
  const binDir = path.join(sandbox.home, 'bin')
  const cwdPath = path.join(sandbox.home, 'claude-cwd.txt')
  const promptPath = path.join(sandbox.home, 'claude-prompt.txt')
  await fs.mkdir(binDir, { recursive: true })
  await fs.writeFile(
    path.join(binDir, 'claude'),
    `#!/bin/bash\npwd -P > '${cwdPath}'\nfor arg in "$@"; do last="$arg"; done\nprintf '%s' "$last" > '${promptPath}'\n`,
    { mode: 0o755 },
  )
  const scriptPath = path.join(sandbox.taskDir, 'launch.sh')
  await fs.writeFile(scriptPath, script, { mode: 0o755 })

  // Stale values in the tab, the way a reused tab carries them: launch.sh's
  // unset must clear them, so the worktree still lands under $HOME/Dev/worktrees.
  const result = await execa('bash', [scriptPath], {
    env: cleanEnv({
      HOME: sandbox.home,
      PATH: `${binDir}:${process.env.PATH}`,
      WORKTREES_DIR: '/stale/e2e-fixture/worktrees',
      TASKS_DIR: '/stale/e2e-fixture/tasks',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }),
    extendEnv: false,
    reject: false,
    input: '',
    cwd: sandbox.home,
  })
  const claudeRan = await exists(cwdPath)
  return {
    exitCode: result.exitCode ?? -1,
    stderr: result.stderr,
    claudeRan,
    cwd: claudeRan ? (await readText(cwdPath)).trim() : '',
    prompt: claudeRan ? await readText(promptPath) : '',
  }
}

function orchestratorLaunchScript(sandbox: Sandbox, template: string, worktreeFlags: string, stage = 'dev'): string {
  return fillPlaceholders(template, {
    'resolved-tasks-dir': sandbox.tasksDir,
    'resolved-repos-dir': sandbox.reposDir,
    'task-slug': SLUG,
    stage,
    repo: REPO,
    branch: BRANCH,
    'worktree-flags': worktreeFlags,
  })
}

test.describe('launch.sh starts claude inside the worktree @pending', () => {
  test('a new-worktree dispatch creates the worktree, then starts claude in it with the brief by absolute path', async () => {
    const sandbox = await makeSandbox('main')
    const template = findLaunchTemplate(await readText(PROMPT_PATH), 'worker-start-dir')

    const view = await runLaunchScript(sandbox, orchestratorLaunchScript(sandbox, template, '--worktree create --copy-task-md'))

    expect(view.claudeRan, view.stderr).toBe(true)
    expect(view.cwd).toBe(await fs.realpath(sandbox.worktreePath))
    expect(await git(sandbox.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
    expect(view.prompt).toContain(path.join(sandbox.taskDir, 'TASK.md'))
    // The worker no longer creates or enters the worktree itself.
    expect(view.prompt).not.toContain('worktree add')
    expect(view.prompt).not.toMatch(/\bcd (to|into) /)
  })

  test('a failed worktree setup never starts claude and leaves STATUS saying why', async () => {
    const sandbox = await makeSandbox('main')
    const template = findLaunchTemplate(await readText(PROMPT_PATH), 'worker-start-dir')

    const view = await runLaunchScript(sandbox, orchestratorLaunchScript(sandbox, template, '--worktree reuse'))

    expect(view.claudeRan).toBe(false)
    expect(view.stderr).toMatch(/worker-start-dir: /)
    expect((await readText(path.join(sandbox.taskDir, 'STATUS'))).trim()).toMatch(new RegExp(`^${FAILED_STATUS_PREFIX}`))
  })

  test('a no-worktree dispatch (adopt) starts claude in the task dir', async () => {
    const sandbox = await makeSandbox('main')
    const template = findLaunchTemplate(await readText(PROMPT_PATH), 'worker-start-dir')

    const view = await runLaunchScript(sandbox, orchestratorLaunchScript(sandbox, template, '--worktree none', 'adopt'))

    expect(view.claudeRan, view.stderr).toBe(true)
    expect(view.cwd).toBe(await fs.realpath(sandbox.taskDir))
    expect(await exists(sandbox.worktreePath)).toBe(false)
  })

  test('the handover launch script starts its successor inside the existing worktree', async () => {
    const sandbox = await makeSandbox('main')
    expect((await startDir(sandbox, ['--worktree', 'create'])).exitCode).toBe(0)
    const template = findLaunchTemplate(await readText(path.join(SKILLS_DIR, 'pipelinely-handover', 'SKILL.md')), 'COCKPIT_TASK_SLUG')
    const script = fillPlaceholders(template, {
      'resolved-tasks-dir': sandbox.tasksDir,
      'resolved-repos-dir': sandbox.reposDir,
      slug: SLUG,
      repo: REPO,
      branch: BRANCH,
      N: '2',
    })

    const view = await runLaunchScript(sandbox, script)

    expect(view.claudeRan, view.stderr).toBe(true)
    expect(view.cwd).toBe(await fs.realpath(sandbox.worktreePath))
    expect(view.prompt).toContain(path.join(sandbox.taskDir, 'TASK.md'))
    expect(view.prompt).toContain(path.join(sandbox.taskDir, 'HANDOVER-2.md'))
  })
})

// --- Doc contracts ------------------------------------------------------------
// The skills are the orchestrator's implementation: their launch prompts must
// not tell a worker to cd into its worktree, because it now starts there.

const STAGE_SKILLS = [
  'pipelinely-planning',
  'pipelinely-plan-review',
  'pipelinely-dev',
  'pipelinely-qa',
  'pipelinely-design-qa',
  'pipelinely-adopt',
  'pipelinely-cr',
  'pipelinely-merge-conflicts',
  'pipelinely-handover',
]

test.describe('stage skills use the shared start-dir launch @pending', () => {
  test('no launch prompt tells the worker to create or cd into its worktree', async () => {
    const texts = [
      { name: 'orchestrator-prompt.md', text: await readText(PROMPT_PATH) },
      ...(await Promise.all(
        STAGE_SKILLS.map(async (name) => ({ name, text: await readText(path.join(SKILLS_DIR, name, 'SKILL.md')) })),
      )),
    ]

    for (const { name, text } of texts) {
      expect(text, name).not.toMatch(/cd (in)?to (the worktree|\$\{WORKTREES_DIR)/)
      expect(text, name).not.toMatch(/exec claude "[^"]*worktree add/)
    }
  })

  test('every stage skill names its --worktree mode for the shared template', async () => {
    const expectedMode: Record<string, string> = {
      'pipelinely-planning': '--worktree create',
      'pipelinely-dev': '--worktree create',
      'pipelinely-plan-review': '--worktree reuse',
      'pipelinely-qa': '--worktree reuse',
      'pipelinely-design-qa': '--worktree reuse',
      'pipelinely-cr': '--worktree reuse',
      'pipelinely-merge-conflicts': '--worktree reuse',
      'pipelinely-adopt': '--worktree none',
    }

    for (const [name, mode] of Object.entries(expectedMode)) {
      expect(await readText(path.join(SKILLS_DIR, name, 'SKILL.md')), name).toContain(mode)
    }
  })
})

// --- write-metrics.sh ---------------------------------------------------------
// Claude Code files a transcript under the folder for the dir the session
// started in, with every non-alphanumeric character turned into '-'. The
// script must find it from wherever the Bash tool's cwd is now.

test.describe('write-metrics.sh finds the transcript by session id @pending', () => {
  async function metricsSandbox(projectFolder: string): Promise<{ home: string; tasksDir: string; sessionId: string }> {
    const home = await makeScratchDir('worker-start-metrics-')
    const tasksDir = path.join(home, 'tasks')
    const sessionId = '11111111-2222-4333-8444-555555555555'
    await fs.mkdir(path.join(tasksDir, SLUG), { recursive: true })
    const transcriptDir = path.join(home, '.claude', 'projects', projectFolder)
    await fs.mkdir(transcriptDir, { recursive: true })
    const entry = {
      type: 'assistant',
      sessionId,
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }
    await fs.writeFile(path.join(transcriptDir, `${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`)
    return { home, tasksDir, sessionId }
  }

  async function runWriteMetrics(home: string, tasksDir: string, sessionId: string, cwd: string): Promise<CliResult> {
    const result = await execa('bash', [WRITE_METRICS], {
      env: cleanEnv({ HOME: home, TASKS_DIR: tasksDir, COCKPIT_TASK_SLUG: SLUG, COCKPIT_STAGE: 'dev', CLAUDE_CODE_SESSION_ID: sessionId }),
      extendEnv: false,
      reject: false,
      cwd,
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? -1 }
  }

  test('a session started in a worktree whose path has a dot, run from a subdir, still writes METRICS', async () => {
    const { home, tasksDir, sessionId } = await metricsSandbox('-Users-someone-Dev-repo--claude-worktrees-demo-task')
    const subdir = path.join(home, 'some', 'sub.dir')
    await fs.mkdir(subdir, { recursive: true })

    const result = await runWriteMetrics(home, tasksDir, sessionId, subdir)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await exists(path.join(tasksDir, SLUG, 'METRICS'))).toBe(true)
    expect(await exists(path.join(tasksDir, SLUG, `METRICS-${sessionId}.json`))).toBe(true)
  })

  test('a session id with no transcript anywhere fails with a clear error', async () => {
    const { home, tasksDir } = await metricsSandbox('-Users-someone-elsewhere')

    const result = await runWriteMetrics(home, tasksDir, '99999999-2222-4333-8444-555555555555', home)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/write-metrics\.sh: transcript not found/)
    expect(await exists(path.join(tasksDir, SLUG, 'METRICS'))).toBe(false)
  })
})
