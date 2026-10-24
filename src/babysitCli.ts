import { runBabysit, tasksDirLine } from './babysit.js'
import { babysitDeps } from './babysitDeps.js'
import { resolveTasksDir } from './tasksDir.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// What `.claude/skills/pipelinely-babysit/SKILL.md` tells the orchestrator to run
// (`npm --prefix $HOME/Dev/pipelinely run --silent babysit -- <command>`).
// Exit codes (documented in babysit.ts): 0 ok, 1 error, 2 refused, 3 nothing
// to do, 4 held by load.
async function main(): Promise<void> {
  // Env leak: iTerm2 tabs have been seen inheriting stale e2e-fixture
  // TASKS_DIR/REPOS_DIR/WORKTREES_DIR; the resolved path is printed first, on
  // stderr, so stdout stays machine-readable.
  const tasksDir = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)
  console.error(tasksDirLine(tasksDir))
  const result = await runBabysit(process.argv.slice(2), babysitDeps(tasksDir))
  for (const line of result.stderr) console.error(line)
  for (const line of result.stdout) console.log(line)
  process.exitCode = result.exitCode
}

main().catch((err) => {
  console.error(`babysit: ${errorMessage(err)}`)
  process.exitCode = 1
})
