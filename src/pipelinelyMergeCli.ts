import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveTasksDir } from './tasksDir.js'
import { parseTask } from './taskParser.js'
import { SAFE_TOKEN } from './batchDispatch.js'
import { mergeTask } from './taskCompletion.js'
import { formatMergeBlockers } from './mergeGate.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// What `.claude/skills/pipelinely-merge/SKILL.md` tells the orchestrator to run
// (`npm --prefix <repo> run --silent pipelinely-merge -- <slug>`) — the other
// human trigger for mergeTask (src/taskCompletion.ts), alongside the Merge
// button's own POST /merge-pr/:slug. Exit codes let the skill tell "gate
// refused" (2) apart from "something broke" (1) without parsing stdout text.
async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug || !SAFE_TOKEN.test(slug)) {
    console.error(`Usage: pipelinely-merge <slug>${slug ? ` — '${slug}' is not a safe task slug` : ''}`)
    process.exitCode = 1
    return
  }

  // Env leak: iTerm2 tabs have been seen inheriting stale e2e-fixture
  // TASKS_DIR/REPOS_DIR/WORKTREES_DIR — printing the resolved path first
  // makes that visible to whoever reads this CLI's output, same reasoning
  // as resolveTasksDir's own refusal in a worktree with no explicit
  // TASKS_DIR.
  const tasksDir = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)
  console.log(`tasks dir: ${tasksDir}`)

  const taskDir = path.join(tasksDir, slug)
  // SAFE_TOKEN allows dots, so a slug of exactly '..' (or './..', etc.)
  // still needs an explicit check: path.join alone would happily resolve
  // outside tasksDir, and this CLI must never act on a directory that isn't
  // directly one of tasksDir's own children.
  if (path.dirname(taskDir) !== tasksDir) {
    console.error(`Refusing '${slug}': resolves outside ${tasksDir}`)
    process.exitCode = 1
    return
  }

  try {
    await fs.access(taskDir)
  } catch {
    console.error(`No task '${slug}' in ${tasksDir}`)
    process.exitCode = 1
    return
  }

  const task = await parseTask(taskDir)
  if (!task) {
    console.error(`No task '${slug}' in ${tasksDir}`)
    process.exitCode = 1
    return
  }

  try {
    const result = await mergeTask(tasksDir, task)
    switch (result.outcome) {
      case 'no-pr':
        console.error('No PR recorded for this task yet')
        process.exitCode = 1
        return
      case 'gate-unavailable':
      case 'merge-failed':
        console.error(result.error)
        process.exitCode = 1
        return
      case 'blocked':
        console.error(formatMergeBlockers(result.blockers))
        process.exitCode = 2
        return
      case 'merged':
        console.log(`PR #${result.prNumber} merged, task marked done`)
        if (result.cleanupError) console.error(`cleanup: ${result.cleanupError}`)
        process.exitCode = 0
        return
    }
  } catch (err) {
    console.error(errorMessage(err))
    process.exitCode = 1
  }
}

// resolveTasksDir and parseTask above run outside that try/catch (their own
// failures aren't merge outcomes), so without a handler here a throw from
// either — e.g. resolveTasksDir's own documented refusal in a worktree with
// no explicit TASKS_DIR — would surface as a raw unhandled-rejection stack
// trace instead of this file's own clean, single-line stderr + exit 1.
main().catch((err) => {
  console.error(errorMessage(err))
  process.exitCode = 1
})
