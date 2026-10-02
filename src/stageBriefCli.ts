import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveTaskDirArg } from './batchDispatch.js'
import { writeStageBrief } from './stageBrief.js'
import { worktreesDir } from './taskParser.js'
import { resolveTasksDir } from './tasksDir.js'

const SUPPORTED_STAGE = 'code-review'
const PR_NUMBER_RE = /^[1-9]\d*$/
const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills')

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fail(message: string): void {
  console.error(`stage-brief: ${message}`)
  process.exitCode = 1
}

// What `.claude/skills/pipelinely-cr/SKILL.md` tells the orchestrator to run
// (`npm --prefix $HOME/Dev/pipelinely run --silent stage-brief -- code-review
// <slug> <PR>`). Prints the written path on stdout; every failure is one
// stderr line and exit 1, so the skill can report it verbatim and stop.
async function main(): Promise<void> {
  const [stage, slug, pr] = process.argv.slice(2)
  if (stage !== SUPPORTED_STAGE) return fail(`usage: stage-brief ${SUPPORTED_STAGE} <slug> <PR number> — '${stage ?? ''}' is not a supported stage`)
  if (!slug) return fail(`usage: stage-brief ${SUPPORTED_STAGE} <slug> <PR number>`)
  if (!pr || !PR_NUMBER_RE.test(pr)) return fail(`'${pr ?? ''}' is not a PR number (a positive integer)`)

  const tasksDir = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)
  const taskDir = resolveTaskDirArg(tasksDir, slug)
  try {
    await fs.access(taskDir)
  } catch {
    return fail(`no task '${slug}' in ${tasksDir}`)
  }

  const briefPath = await writeStageBrief({
    stage: SUPPORTED_STAGE,
    slug,
    prNumber: Number(pr),
    tasksDir,
    worktreesDir: worktreesDir(),
    skillsDir: SKILLS_DIR,
  })
  console.log(briefPath)
}

// resolveTasksDir, resolveTaskDirArg and writeStageBrief can all throw (a
// worktree with no explicit TASKS_DIR, a template typo, an unwritable dir); a
// handler here keeps those as this file's own single stderr line instead of a
// raw unhandled-rejection stack trace.
main().catch((err) => fail(errorMessage(err)))
