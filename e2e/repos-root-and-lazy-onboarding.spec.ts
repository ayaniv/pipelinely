import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

// Configurable repo root + lazy onboarding (tech-design.md, M1).
//
// Nothing here touches the dev server, dispatch-tab.sh, osascript, tmux or
// iTerm2: the CLI is spawned for real against an isolated HOME/TASKS_DIR, the
// launch-script templates are executed under bash with a stub `claude`, and
// the orchestrator's own instructions (the markdown files it is implemented
// in) are checked as contracts.
//
// Committed red (tagged @pending) before any implementation; the tag was
// removed once green.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const PROMPT_PATH = path.join(REPO_ROOT, 'orchestrator-prompt.md')
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills')

// Environment variables the spawned processes must not inherit from the
// developer's shell — the leak this feature has to be robust against.
const SCRUBBED_ENV_KEYS = ['REPOS_DIR', 'TASKS_DIR', 'WORKTREES_DIR', 'INIT_CWD']

async function makeScratchDir(prefix: string): Promise<string> {
  // realpath so assertions hold whether or not the implementation resolves
  // symlinks (macOS's tmpdir is itself a symlink).
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

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface Sandbox {
  home: string
  tasksDir: string
  elsewhere: string
  run(args: string[], options?: { env?: Record<string, string>; cwd?: string }): Promise<CliResult>
  json(args: string[], options?: { env?: Record<string, string>; cwd?: string }): Promise<{ reposDir: string; source: string }>
}

async function makeSandbox(): Promise<Sandbox> {
  const home = await makeScratchDir('repos-dir-home-')
  const tasksDir = await makeScratchDir('repos-dir-tasks-')
  const elsewhere = await makeScratchDir('repos-dir-cwd-')

  // The exact command the skills run: `npm --prefix <tool> run --silent repos-dir`.
  // cwd defaults to a directory that is NOT the tool checkout, since that is
  // where a user types it — npm then runs the script with cwd = the tool and
  // reports the caller's directory in INIT_CWD.
  async function run(args: string[], options: { env?: Record<string, string>; cwd?: string } = {}): Promise<CliResult> {
    const result = await execa('npm', ['--prefix', REPO_ROOT, 'run', '--silent', 'repos-dir', '--', ...args], {
      cwd: options.cwd ?? elsewhere,
      env: cleanEnv({ HOME: home, TASKS_DIR: tasksDir, ...options.env }),
      extendEnv: false,
      reject: false,
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? -1 }
  }

  async function json(args: string[], options: { env?: Record<string, string>; cwd?: string } = {}) {
    const result = await run(args, options)
    expect(result.exitCode, result.stderr).toBe(0)
    return JSON.parse(result.stdout) as { reposDir: string; source: string }
  }

  return { home, tasksDir, elsewhere, run, json }
}

test.describe('repos-dir CLI', () => {
  test('with nothing saved or exported it reports $HOME/Dev as the default', async () => {
    const sandbox = await makeSandbox()
    expect(await sandbox.json([])).toEqual({ reposDir: path.join(sandbox.home, 'Dev'), source: 'default' })
  })

  test('set persists the root and a later run re-reads it from the file', async () => {
    const sandbox = await makeSandbox()
    const root = await makeScratchDir('repos-dir-root-')

    expect(await sandbox.json(['set', root])).toEqual({ reposDir: root, source: 'file' })
    expect(await sandbox.json([])).toEqual({ reposDir: root, source: 'file' })
    expect((await fs.readFile(path.join(sandbox.tasksDir, 'REPOS_DIR'), 'utf-8')).trim()).toBe(root)
  })

  test('set again repoints the root', async () => {
    const sandbox = await makeSandbox()
    const first = await makeScratchDir('repos-dir-first-')
    const second = await makeScratchDir('repos-dir-second-')

    await sandbox.json(['set', first])
    await sandbox.json(['set', second])

    expect(await sandbox.json([])).toEqual({ reposDir: second, source: 'file' })
  })

  test('a relative path resolves against the directory the command was typed in, not the tool checkout', async () => {
    const sandbox = await makeSandbox()
    const typedIn = await makeScratchDir('repos-dir-typed-')
    await fs.mkdir(path.join(typedIn, 'projects'))

    const result = await sandbox.json(['set', 'projects'], { cwd: typedIn })

    expect(result).toEqual({ reposDir: path.join(typedIn, 'projects'), source: 'file' })
    expect((await fs.readFile(path.join(sandbox.tasksDir, 'REPOS_DIR'), 'utf-8')).trim()).toBe(path.join(typedIn, 'projects'))
  })

  test('an exported REPOS_DIR wins over the saved file', async () => {
    const sandbox = await makeSandbox()
    const saved = await makeScratchDir('repos-dir-saved-')
    const exported = await makeScratchDir('repos-dir-exported-')
    await sandbox.json(['set', saved])

    expect(await sandbox.json([], { env: { REPOS_DIR: exported } })).toEqual({ reposDir: exported, source: 'env' })
  })

  test('an exported REPOS_DIR that is not a directory still resolves but warns on stderr naming the path', async () => {
    const sandbox = await makeSandbox()
    const missing = path.join(sandbox.home, 'no-such-dir')

    const result = await sandbox.run([], { env: { REPOS_DIR: missing } })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ reposDir: missing, source: 'env' })
    expect(result.stderr).toContain(missing)
  })

  test('set refuses a path that does not exist and keeps the previous value', async () => {
    const sandbox = await makeSandbox()
    const root = await makeScratchDir('repos-dir-keep-')
    await sandbox.json(['set', root])

    const result = await sandbox.run(['set', path.join(sandbox.home, 'no-such-dir')])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toBe('')
    expect(await sandbox.json([])).toEqual({ reposDir: root, source: 'file' })
  })

  test('set refuses a regular file and keeps the previous value', async () => {
    const sandbox = await makeSandbox()
    const root = await makeScratchDir('repos-dir-keep-')
    const regularFile = path.join(sandbox.home, 'a-file.txt')
    await fs.writeFile(regularFile, 'not a directory')
    await sandbox.json(['set', root])

    const result = await sandbox.run(['set', regularFile])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toBe('')
    expect(await sandbox.json([])).toEqual({ reposDir: root, source: 'file' })
  })

  test('set accepts a path with a space and a path full of shell metacharacters, stored verbatim', async () => {
    const sandbox = await makeSandbox()
    for (const awkwardName of ['My Projects', "it's $(touch pwned); `id` & \"x\""]) {
      const awkwardRoot = path.join(sandbox.home, awkwardName)
      await fs.mkdir(awkwardRoot)

      expect(await sandbox.json(['set', awkwardRoot])).toEqual({ reposDir: awkwardRoot, source: 'file' })
      expect(await sandbox.json([])).toEqual({ reposDir: awkwardRoot, source: 'file' })
    }
  })

  test('set drops a trailing slash', async () => {
    const sandbox = await makeSandbox()
    const root = await makeScratchDir('repos-dir-root-')

    expect(await sandbox.json(['set', `${root}/`])).toEqual({ reposDir: root, source: 'file' })
  })

  test('set expands a quoted leading ~ to the home directory', async () => {
    const sandbox = await makeSandbox()
    await fs.mkdir(path.join(sandbox.home, 'Dev'))

    expect(await sandbox.json(['set', '~/Dev'])).toEqual({ reposDir: path.join(sandbox.home, 'Dev'), source: 'file' })
  })

  test('a saved root that has since been deleted falls back to the default and warns on stderr naming the path', async () => {
    const sandbox = await makeSandbox()
    const root = await makeScratchDir('repos-dir-gone-')
    await sandbox.json(['set', root])
    await fs.rm(root, { recursive: true })

    const result = await sandbox.run([])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ reposDir: path.join(sandbox.home, 'Dev'), source: 'default' })
    expect(result.stderr).toContain(root)
  })

  test('a hand-edited saved file holding a relative path is rejected, warned about and replaced by the default', async () => {
    const sandbox = await makeSandbox()
    await fs.writeFile(path.join(sandbox.tasksDir, 'REPOS_DIR'), 'projects\n')

    const result = await sandbox.run([], { cwd: sandbox.elsewhere })

    expect(JSON.parse(result.stdout)).toEqual({ reposDir: path.join(sandbox.home, 'Dev'), source: 'default' })
    expect(result.stderr).toContain('absolute')
  })

  test('an unreadable saved file falls back to the default and says why on stderr', async () => {
    const sandbox = await makeSandbox()
    await fs.mkdir(path.join(sandbox.tasksDir, 'REPOS_DIR'))

    const result = await sandbox.run([])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ reposDir: path.join(sandbox.home, 'Dev'), source: 'default' })
    expect(result.stderr).toContain('REPOS_DIR')
  })

  test('set with no path prints a usage line and exits 1', async () => {
    const sandbox = await makeSandbox()

    const result = await sandbox.run(['set'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/usage/i)
  })
})

// --- Launch-script templates -------------------------------------------------

function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

// The fenced bash blocks of a markdown file, in order.
function bashBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1])
}

function findLaunchTemplate(markdown: string, marker: string): string {
  const block = bashBlocks(markdown).find((candidate) => candidate.includes('exec claude') && candidate.includes(marker))
  if (!block) throw new Error(`no bash launch template containing '${marker}' found`)
  return block
}

// Fills `<placeholder>` tokens the way the orchestrator does when it writes
// launch.sh with literal bytes.
function fillPlaceholders(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((filled, [name, value]) => filled.split(`<${name}>`).join(value), template)
}

interface WorkerView {
  reposDir: string
  prompt: string
}

// How the orchestrator fills `export REPOS_DIR='<resolved-repos-dir>'`: the
// template supplies the single quotes, so only an embedded single quote needs
// closing, escaping and reopening (orchestrator-prompt.md, step 4).
function escapeForSingleQuotes(value: string): string {
  return value.split("'").join(`'\\''`)
}

// Runs a filled launch script under bash with a stale REPOS_DIR in its
// environment and a stub `claude` that records what it inherited.
async function runLaunchScript(script: string, workDir: string, saved: string): Promise<WorkerView> {
  const binDir = path.join(workDir, 'bin')
  const recordPath = path.join(workDir, 'worker-env.txt')
  await fs.mkdir(binDir, { recursive: true })
  const promptPath = path.join(workDir, 'worker-prompt.txt')
  await fs.writeFile(
    path.join(binDir, 'claude'),
    `#!/bin/bash\nprintf '%s' "\${REPOS_DIR-<unset>}" > '${recordPath}'\nprintf '%s' "$1" > '${promptPath}'\n`,
    { mode: 0o755 },
  )
  const scriptPath = path.join(workDir, 'launch.sh')
  await fs.writeFile(scriptPath, script, { mode: 0o755 })

  const result = await execa('bash', [scriptPath], {
    env: cleanEnv({ PATH: `${binDir}:${process.env.PATH}`, REPOS_DIR: '/stale/e2e-fixture/repos' }),
    extendEnv: false,
    reject: false,
  })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(saved).not.toBe('/stale/e2e-fixture/repos')
  return { reposDir: await readText(recordPath), prompt: await readText(promptPath) }
}

test.describe('worker launch scripts keep the saved repo root through the unset', () => {
  test('orchestrator-prompt step 4 launch.sh hands the worker the saved root, not the stale inherited one', async () => {
    const workDir = await makeScratchDir('launch-orchestrator-')
    const savedRoot = await makeScratchDir('launch-saved-root-')
    const template = findLaunchTemplate(await readText(PROMPT_PATH), 'unset REPOS_DIR')
    const script = fillPlaceholders(template, {
      'resolved-tasks-dir': workDir,
      'resolved-repos-dir': savedRoot,
      'task-slug': 'demo-task',
      stage: 'dev',
      repo: 'demo-repo',
      branch: 'claude/demo-task',
    })
    await fs.mkdir(path.join(workDir, 'demo-task'), { recursive: true })

    expect((await runLaunchScript(script, workDir, savedRoot)).reposDir).toBe(savedRoot)
  })

  test('a repo root with spaces and shell metacharacters reaches the worker intact and runs nothing', async () => {
    const parentDir = await makeScratchDir('launch-awkward-')
    const awkwardRoot = path.join(parentDir, "My Projects; it's $(touch pwned) `id` & \"x\"")
    await fs.mkdir(awkwardRoot)
    const workDir = path.join(parentDir, 'work')
    await fs.mkdir(path.join(workDir, 'demo-task'), { recursive: true })
    const orchestratorTemplate = findLaunchTemplate(await readText(PROMPT_PATH), 'unset REPOS_DIR')
    const handoverTemplate = findLaunchTemplate(await readText(path.join(SKILLS_DIR, 'handover', 'SKILL.md')), 'COCKPIT_TASK_SLUG')

    for (const template of [orchestratorTemplate, handoverTemplate]) {
      const script = fillPlaceholders(template, {
        'resolved-tasks-dir': workDir,
        'resolved-repos-dir': escapeForSingleQuotes(awkwardRoot),
        'task-slug': 'demo-task',
        slug: 'demo-task',
        N: '2',
        stage: 'dev',
        repo: 'demo-repo',
        branch: 'claude/demo-task',
      })

      expect((await runLaunchScript(script, workDir, awkwardRoot)).reposDir).toBe(awkwardRoot)
    }
    await expect(fs.access(path.join(workDir, 'pwned'))).rejects.toThrow()
  })

  test('the worker prompt quotes every repo-root expansion so a root with a space still works', async () => {
    const workDir = await makeScratchDir('launch-prompt-')
    const savedRoot = await makeScratchDir('launch-saved-root-')
    await fs.mkdir(path.join(workDir, 'demo-task'), { recursive: true })
    const template = findLaunchTemplate(await readText(PROMPT_PATH), 'unset REPOS_DIR')
    const script = fillPlaceholders(template, {
      'resolved-tasks-dir': workDir,
      'resolved-repos-dir': escapeForSingleQuotes(savedRoot),
      'task-slug': 'demo-task',
      stage: 'dev',
      repo: 'demo-repo',
      branch: 'claude/demo-task',
    })

    const { prompt } = await runLaunchScript(script, workDir, savedRoot)

    expect(prompt).toContain('git -C ')
    expect(prompt).not.toMatch(/git -C \$\{REPOS_DIR/)
    expect(prompt).toMatch(/git -C "\$\{REPOS_DIR:-\$HOME\/Dev\}\/demo-repo"/)
  })

  test('the export comes after the unset, so the unset still clears a stale value first', async () => {
    const template = findLaunchTemplate(await readText(PROMPT_PATH), 'unset REPOS_DIR')
    const unsetAt = template.indexOf('unset REPOS_DIR')
    const exportAt = template.indexOf('export REPOS_DIR=')

    expect(exportAt).toBeGreaterThan(unsetAt)
  })

  test('handover launch script hands the successor the saved root', async () => {
    const workDir = await makeScratchDir('launch-handover-')
    const savedRoot = await makeScratchDir('launch-saved-root-')
    const template = findLaunchTemplate(await readText(path.join(SKILLS_DIR, 'handover', 'SKILL.md')), 'COCKPIT_TASK_SLUG')
    const script = fillPlaceholders(template, {
      'resolved-tasks-dir': workDir,
      'resolved-repos-dir': savedRoot,
      slug: 'demo-task',
      N: '2',
    })
    await fs.mkdir(path.join(workDir, 'demo-task'), { recursive: true })

    expect((await runLaunchScript(script, workDir, savedRoot)).reposDir).toBe(savedRoot)
  })
})

// --- Doc contracts -------------------------------------------------------------
// The skills and the orchestrator prompt are the orchestrator's implementation,
// so what they instruct is the behavior under test.

const TOOL_PATH_VIA_REPOS_DIR = '${REPOS_DIR:-$HOME/Dev}/pipelinely'

async function skillText(name: string): Promise<string> {
  return readText(path.join(SKILLS_DIR, name, 'SKILL.md'))
}

test.describe('lazy onboarding and repo-root docs', () => {
  test('/pipelinely no longer runs onboarding or gates on a target project', async () => {
    const pipelinely = await skillText('pipelinely')

    expect(pipelinely).not.toContain('pipelinely-onboard')
    expect(pipelinely).not.toMatch(/Resolve the target project/i)
    expect(pipelinely).toContain('orchestrator-prompt.md')
  })

  test('the Onboarding offer is defined once in orchestrator-prompt.md', async () => {
    const prompt = await readText(PROMPT_PATH)

    expect(prompt).toContain('### Onboarding offer')
    expect(prompt).toContain('alreadyOnboarded')
    expect(prompt).toContain('validation.failures')
    expect(prompt).toContain('pipelinely-onboard')
  })

  test('pipelinely-planning and pipelinely-dev point at the Onboarding offer instead of copying it', async () => {
    const planning = await skillText('pipelinely-planning')
    const dev = await skillText('pipelinely-dev')

    expect(planning).toContain('Onboarding offer')
    expect(dev).toContain('Onboarding offer')
    expect(planning).not.toContain('alreadyOnboarded')
    expect(dev).not.toContain('alreadyOnboarded')
  })

  test('pipelinely-dev offers onboarding only in the brand-new flat task branch, after the weekly-focus check', async () => {
    const dev = await skillText('pipelinely-dev')
    const weeklyFocusAt = dev.indexOf('Weekly-focus check')
    const offerAt = dev.indexOf('Onboarding offer')

    expect(weeklyFocusAt).toBeGreaterThan(-1)
    expect(offerAt).toBeGreaterThan(weeklyFocusAt)
  })

  test('the prompt resolves <resolved-repos-dir> through the repos-dir CLI', async () => {
    const prompt = await readText(PROMPT_PATH)

    expect(prompt).toContain('run --silent repos-dir')
    expect(prompt).toContain('<resolved-repos-dir>')
  })

  test('no skill or prompt still locates the tool checkout under the configurable repo root', async () => {
    const skillNames = (await fs.readdir(SKILLS_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    const offenders: string[] = []
    const files = [PROMPT_PATH, ...skillNames.map((name) => path.join(SKILLS_DIR, name, 'SKILL.md'))]
    for (const file of files) {
      const text = await readText(file).catch(() => '')
      if (text.includes(TOOL_PATH_VIA_REPOS_DIR)) offenders.push(path.relative(REPO_ROOT, file))
    }

    expect(offenders).toEqual([])
  })
})
