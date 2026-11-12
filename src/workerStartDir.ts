import fs from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import { resolveBaseRef } from './gitOps.js'

// The git half of a worker's launch.sh: get the task's worktree ready, then
// tell launch.sh which directory to start `claude` in (tech-design.md of
// pipelinely-worker-cwd-worktree). Runs in the worker's own tab, after
// dispatch-tab.sh's ack, so a failure here is reported in STATUS/TIMELINE.

export const WORKTREE_MODES = ['create', 'reuse', 'none'] as const
export type WorktreeMode = (typeof WORKTREE_MODES)[number]

export interface WorkerStartDirArgs {
  taskDir: string
  repo: string
  branch: string
  mode: WorktreeMode
  copyTaskMd: boolean
}

export interface StartDirRequest extends WorkerStartDirArgs {
  reposDir: string
  worktreesDir: string
}

export type ParsedArgs = { ok: true; args: WorkerStartDirArgs } | { ok: false; error: string }

// A setup problem a person must look at; its message is the one-line cause.
export class StartDirError extends Error {}

const VALUE_FLAGS = ['--task-dir', '--repo', '--branch', '--worktree'] as const
const USAGE =
  'usage: worker-start-dir --task-dir <abs dir> --repo <repo> --branch <branch> --worktree create|reuse|none [--copy-task-md]'

function isWorktreeMode(value: string): value is WorktreeMode {
  return (WORKTREE_MODES as readonly string[]).includes(value)
}

export function parseWorkerStartDirArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>()
  let copyTaskMd = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--copy-task-md') {
      copyTaskMd = true
      continue
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) return { ok: false, error: `unknown argument '${flag}' — ${USAGE}` }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} needs a value — ${USAGE}` }
    values.set(flag, value)
    i++
  }
  const missing = VALUE_FLAGS.filter((flag) => !values.get(flag))
  if (missing.length > 0) return { ok: false, error: `missing ${missing.join(', ')} — ${USAGE}` }

  const taskDir = values.get('--task-dir') as string
  const mode = values.get('--worktree') as string
  if (!path.isAbsolute(taskDir)) return { ok: false, error: `--task-dir must be an absolute path, got '${taskDir}'` }
  if (!isWorktreeMode(mode)) return { ok: false, error: `--worktree must be create, reuse or none, got '${mode}'` }
  return {
    ok: true,
    args: { taskDir, repo: values.get('--repo') as string, branch: values.get('--branch') as string, mode, copyTaskMd },
  }
}

// One place for the worktree path, so a repo-specific layout replaces only this.
export function worktreePathFor(worktreesDir: string, slug: string): string {
  return path.join(worktreesDir, slug)
}

async function runGit(args: string[], what: string): Promise<string> {
  const result = await execa('git', args, { reject: false })
  if (result.exitCode !== 0) {
    console.error(`worker-start-dir: git ${args.join(' ')} failed:\n${result.stderr}`)
    const lastLine = result.stderr.trim().split('\n').pop() ?? ''
    throw new StartDirError(`${what} failed: ${lastLine || `git exited ${result.exitCode}`}`)
  }
  return result.stdout.trim()
}

async function realpathOrSelf(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath)
  } catch {
    return filePath
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function assertCheckout(repoDir: string): Promise<void> {
  const topLevel = await execa('git', ['-C', repoDir, 'rev-parse', '--show-toplevel'], { reject: false })
  if (topLevel.exitCode !== 0 || (await realpathOrSelf(topLevel.stdout.trim())) !== (await realpathOrSelf(repoDir))) {
    throw new StartDirError(`no git checkout at ${repoDir}`)
  }
}

// The branch the repo's worktree at <worktreePath> has checked out: a
// `refs/heads/...` name, 'detached HEAD', or null when <worktreePath> is not
// one of the repo's worktrees.
async function worktreeBranch(repoDir: string, worktreePath: string): Promise<string | null> {
  const listing = await runGit(['-C', repoDir, 'worktree', 'list', '--porcelain'], 'git worktree list')
  const target = await realpathOrSelf(worktreePath)
  for (const entry of listing.split('\n\n')) {
    const lines = entry.split('\n')
    const pathLine = lines.find((line) => line.startsWith('worktree '))
    if (!pathLine || (await realpathOrSelf(pathLine.slice('worktree '.length))) !== target) continue
    const branchLine = lines.find((line) => line.startsWith('branch '))
    return branchLine ? branchLine.slice('branch refs/heads/'.length) : 'detached HEAD'
  }
  return null
}

async function assertWorktreeOnBranch(repoDir: string, worktreePath: string, branch: string): Promise<void> {
  const current = await worktreeBranch(repoDir, worktreePath)
  if (current === null) throw new StartDirError(`${worktreePath} is not a worktree of ${repoDir}`)
  if (current !== branch) throw new StartDirError(`worktree ${worktreePath} is on ${current}, not ${branch}`)
}

async function refExists(repoDir: string, ref: string): Promise<boolean> {
  const result = await execa('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', ref], { reject: false })
  return result.exitCode === 0
}

// Never checks anything out in the primary checkout: its branch and HEAD stay as they are.
export async function createWorktree(repoDir: string, worktreePath: string, branch: string): Promise<void> {
  await runGit(['-C', repoDir, 'fetch', 'origin'], 'git fetch origin')
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  if (await refExists(repoDir, `refs/heads/${branch}`)) {
    await runGit(['-C', repoDir, 'worktree', 'add', worktreePath, branch], 'git worktree add')
    return
  }
  if (await refExists(repoDir, `refs/remotes/origin/${branch}`)) {
    await runGit(['-C', repoDir, 'worktree', 'add', '-b', branch, worktreePath, `origin/${branch}`], 'git worktree add')
    return
  }
  const base = await resolveBaseRef(repoDir)
  if (!base) throw new StartDirError(`no base branch (origin/HEAD, origin/master, origin/main, master, main) in ${repoDir}`)
  await runGit(['-C', repoDir, 'worktree', 'add', '-b', branch, worktreePath, base], 'git worktree add')
}

// Returns the absolute directory the worker's `claude` starts in. Throws
// StartDirError with a one-line cause; nothing is changed on a refusal.
export async function prepareStartDir(request: StartDirRequest): Promise<string> {
  const { taskDir, repo, branch, mode, copyTaskMd, reposDir, worktreesDir } = request
  if (mode === 'none') return taskDir

  const repoDir = path.join(reposDir, repo)
  const worktreePath = worktreePathFor(worktreesDir, path.basename(taskDir))
  await assertCheckout(repoDir)

  if (mode === 'reuse') {
    if (!(await pathExists(worktreePath))) throw new StartDirError(`no worktree at ${worktreePath}`)
    await assertWorktreeOnBranch(repoDir, worktreePath, branch)
  } else if (await pathExists(worktreePath)) {
    await assertWorktreeOnBranch(repoDir, worktreePath, branch)
  } else {
    await createWorktree(repoDir, worktreePath, branch)
  }

  if (copyTaskMd) await fs.copyFile(path.join(taskDir, 'TASK.md'), path.join(worktreePath, 'TASK.md'))
  return worktreePath
}

// Same `<iso> <stage> <note>` shape workers write with `date -u +%Y-%m-%dT%H:%M:%SZ`.
export async function recordSetupFailure(taskDir: string, stage: string, cause: string, now: Date = new Date()): Promise<void> {
  const oneLine = cause.replace(/\s*\n\s*/g, ' ').trim()
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  await fs.writeFile(path.join(taskDir, 'STATUS'), `waiting: worktree setup failed — ${oneLine}\n`)
  await fs.appendFile(path.join(taskDir, 'TIMELINE'), `${timestamp} ${stage || 'dispatch'} worktree setup failed: ${oneLine}\n`)
}
