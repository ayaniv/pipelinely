import { resolveTasksDir } from './tasksDir.js'
import { readEffectiveWeeklyFocus } from './weeklyFocus.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// What the orchestrator and the planning/dev skills run
// (`npm --prefix <tool> run --silent weekly-focus -- get`) instead of reading
// the WEEKLY_FOCUS file: empty output means "no focus" — nothing set, or the
// Settings switch is off — so the dispatch gate has nothing to check against.
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0] !== 'get') {
    console.error('Usage: weekly-focus get')
    process.exitCode = 1
    return
  }

  const focus = await readEffectiveWeeklyFocus(resolveTasksDir(process.cwd(), process.env.TASKS_DIR))
  if (focus) console.log(focus)
}

main().catch((err) => {
  console.error(errorMessage(err))
  process.exitCode = 1
})
