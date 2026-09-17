import fs from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'

export interface DetectedProject {
  isGitRepo: boolean
  repoRoot: string | null
  remoteUrl: string | null
  defaultBranch: string | null
  hasClaudeMd: boolean
  existingSkillDirs: string[]
  packageManager: 'npm' | 'yarn' | 'pnpm' | null
  scripts: { test: string | null; lint: string | null; typecheck: string | null }
  e2eFramework: 'playwright' | 'cypress' | null
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

async function detectPackageManager(dir: string): Promise<DetectedProject['packageManager']> {
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn'
  if (await exists(path.join(dir, 'package-lock.json'))) return 'npm'
  return null
}

async function detectScripts(dir: string): Promise<DetectedProject['scripts']> {
  const pkgPath = path.join(dir, 'package.json')
  if (!(await exists(pkgPath))) return { test: null, lint: null, typecheck: null }
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    return { test: scripts.test ?? null, lint: scripts.lint ?? null, typecheck: scripts.typecheck ?? null }
  } catch {
    return { test: null, lint: null, typecheck: null }
  }
}

async function detectGit(dir: string): Promise<{ isGitRepo: boolean; remoteUrl: string | null; defaultBranch: string | null; repoRoot: string | null }> {
  const result = await execa('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { reject: false })
  if (result.exitCode !== 0) return { isGitRepo: false, remoteUrl: null, defaultBranch: null, repoRoot: null }
  const repoRoot = result.stdout.trim()
  const remote = await execa('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { reject: false })
  const branch = await execa('git', ['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], { reject: false })
  return {
    isGitRepo: true,
    remoteUrl: remote.exitCode === 0 ? remote.stdout.trim() : null,
    defaultBranch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    repoRoot,
  }
}

async function detectE2EFramework(dir: string): Promise<DetectedProject['e2eFramework']> {
  if (await exists(path.join(dir, 'playwright.config.ts'))) return 'playwright'
  if (await exists(path.join(dir, 'playwright.config.js'))) return 'playwright'
  if (await exists(path.join(dir, 'cypress.config.ts'))) return 'cypress'
  return null
}

export async function detectProject(targetDir: string): Promise<DetectedProject> {
  const git = await detectGit(targetDir)
  const baseDir = git.repoRoot ?? targetDir
  const hasClaudeMd = await exists(path.join(baseDir, 'CLAUDE.md'))
  const skillsDir = path.join(baseDir, '.claude/skills')
  const existingSkillDirs = (await exists(skillsDir))
    ? (await fs.readdir(skillsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    : []

  return {
    ...git,
    hasClaudeMd,
    existingSkillDirs,
    packageManager: await detectPackageManager(baseDir),
    scripts: await detectScripts(baseDir),
    e2eFramework: await detectE2EFramework(baseDir),
  }
}
