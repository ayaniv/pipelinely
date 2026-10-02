import fs from 'node:fs/promises'
import { resolveTasksDir } from './tasksDir.js'
import { parseTask } from './taskParser.js'
import { resolveTaskDirArg } from './batchDispatch.js'
import { describeMergeOutcome, mergeResolvingPr } from './cockpitMerge.js'

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
  if (!slug) {
    console.error('Usage: pipelinely-merge <slug>')
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

  let taskDir: string
  try {
    taskDir = resolveTaskDirArg(tasksDir, slug)
  } catch (err) {
    console.error(errorMessage(err))
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
    const { exitCode, lines } = describeMergeOutcome(await mergeResolvingPr(tasksDir, task))
    for (const line of lines) (line.stream === 'log' ? console.log : console.error)(line.text)
    process.exitCode = exitCode
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
