import os from 'node:os'
import path from 'node:path'
import { resolveReposDir } from './reposDir.js'
import { worktreesDir } from './taskParser.js'
import { parseWorkerStartDirArgs, prepareStartDir, recordSetupFailure } from './workerStartDir.js'

const EXIT_SETUP_FAILED = 1
const EXIT_BAD_ARGS = 2

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// What launch.sh runs before `exec claude` (orchestrator-prompt.md step 4).
// stdout is only the start dir, because launch.sh captures it with $(...).
// Bad arguments: exit 2 and no write. A setup failure: exit 1, and the cause
// goes to stderr, STATUS and TIMELINE, so the card shows it.
async function main(): Promise<void> {
  const parsed = parseWorkerStartDirArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(`worker-start-dir: ${parsed.error}`)
    process.exitCode = EXIT_BAD_ARGS
    return
  }
  const { args } = parsed
  try {
    const { reposDir } = resolveReposDir({ envValue: process.env.REPOS_DIR, tasksDir: path.dirname(args.taskDir), homeDir: os.homedir() })
    console.log(await prepareStartDir({ ...args, reposDir, worktreesDir: worktreesDir() }))
  } catch (err) {
    const cause = errorMessage(err)
    console.error(`worker-start-dir: ${cause}`)
    process.exitCode = EXIT_SETUP_FAILED
    try {
      await recordSetupFailure(args.taskDir, process.env.COCKPIT_STAGE ?? '', cause)
    } catch (writeErr) {
      console.error(`worker-start-dir: could not record the failure in ${args.taskDir}: ${errorMessage(writeErr)}`)
    }
  }
}

main().catch((err) => {
  console.error(`worker-start-dir: ${errorMessage(err)}`)
  process.exitCode = EXIT_SETUP_FAILED
})
