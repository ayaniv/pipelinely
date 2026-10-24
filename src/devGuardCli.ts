import { checkDevTarget, describeDevGuardOutcome } from './devGuard.js'
import { resolveTasksDir } from './tasksDir.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fail(message: string): void {
  console.error(`dev-guard: ${message}`)
  process.exitCode = 1
}

// What `.claude/skills/pipelinely-dev/SKILL.md` Step 1 tells the orchestrator to
// run (`npm --prefix $HOME/Dev/pipelinely run --silent dev-guard -- <slug>`)
// before anything else. Exit codes let the skill tell the three outcomes apart
// without parsing text:
//   0 = not a milestone parent, go ahead (no output)
//   2 = refused: the slug's tech-design.md declares ## Milestones; the
//       milestones and which are dispatchable now are printed on stdout
//   1 = something broke: one stderr line, relay it and stop without dispatching
async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug) return fail('Usage: dev-guard <slug>')

  const tasksDir = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)
  const report = describeDevGuardOutcome(slug, await checkDevTarget(tasksDir, slug))
  for (const line of report.lines) console.log(line)
  process.exitCode = report.exitCode
}

// resolveTasksDir (a worktree with no explicit TASKS_DIR), checkDevTarget (an
// unsafe slug, an unreadable file) can all throw; a handler here keeps those
// as this file's own single stderr line instead of an unhandled-rejection
// stack trace.
main().catch((err) => fail(errorMessage(err)))
