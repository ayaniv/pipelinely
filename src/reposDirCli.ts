import fs from 'node:fs'
import os from 'node:os'
import { resolveReposDir, writeReposDir } from './reposDir.js'
import { resolveTasksDir } from './tasksDir.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// What the orchestrator runs (`npm --prefix <tool> run --silent repos-dir`)
// to resolve the repo root once per dispatch, and what a developer runs
// (`... repos-dir -- set <dir>`) to repoint it. Prints one JSON line on
// stdout; every failure is a single stderr line with exit 1.
function main(): void {
  const [command, targetPath] = process.argv.slice(2)
  const tasksDir = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)

  if (command === 'set') {
    if (!targetPath) {
      console.error('Usage: repos-dir [set <path>]')
      process.exitCode = 1
      return
    }
    // npm runs the script with cwd = the tool checkout; INIT_CWD is where the
    // user actually typed the command, so a relative <path> means what they meant.
    const callerCwd = process.env.INIT_CWD ?? process.cwd()
    const reposDir = writeReposDir(tasksDir, targetPath, callerCwd)
    console.log(JSON.stringify({ reposDir, source: 'file' }))
    return
  }

  if (command !== undefined) {
    console.error(`Usage: repos-dir [set <path>] — unknown command '${command}'`)
    process.exitCode = 1
    return
  }

  const resolved = resolveReposDir({ envValue: process.env.REPOS_DIR, tasksDir, homeDir: os.homedir() })
  // The env-leak case: a stale e2e-fixture REPOS_DIR in this shell would be
  // baked into every launch script, so a root that doesn't exist must be loud.
  // A bad saved file is already warned about and replaced by the default
  // inside resolveReposDir, and the default is exempt: ~/Dev not existing yet
  // is the normal fresh-machine state, and the ask-once prompt handles it.
  if (resolved.source === 'env' && !isExistingDirectory(resolved.reposDir)) {
    console.error(`Warning: repo root ${resolved.reposDir} (from this shell's environment) is not an existing directory`)
  }
  console.log(JSON.stringify(resolved))
}

try {
  main()
} catch (err) {
  console.error(errorMessage(err))
  process.exitCode = 1
}
