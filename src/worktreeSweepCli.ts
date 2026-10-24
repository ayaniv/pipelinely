import readline from 'node:readline/promises'
import { resolveTasksDir } from './tasksDir.js'
import {
  collectSweepEntries,
  formatSweepReport,
  removeSweepEntries,
  type SweepEntry,
  type SweepOutcome,
} from './worktreeSweep.js'

const USAGE = 'Usage: worktree-sweep [--json] [--remove <slug>... | --all-clean] [--yes]'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface ParsedArgs {
  json: boolean
  yes: boolean
  allClean: boolean
  remove: string[] | null
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const parsed: ParsedArgs = { json: false, yes: false, allClean: false, remove: null }
  for (const arg of argv) {
    if (arg === '--json') parsed.json = true
    else if (arg === '--yes') parsed.yes = true
    else if (arg === '--all-clean') parsed.allClean = true
    else if (arg === '--remove') parsed.remove = []
    else if (!arg.startsWith('--') && parsed.remove) parsed.remove.push(arg)
    else return null
  }
  if (parsed.remove && parsed.remove.length === 0) return null
  if (parsed.remove && parsed.allClean) return null
  return parsed
}

async function askToConfirm(entries: SweepEntry[]): Promise<boolean> {
  // stderr, so --json keeps stdout parseable even when it has to ask.
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(`Remove ${entries.length} worktree(s) (${entries.map((e) => e.slug).join(', ')})? [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

function describeOutcome(outcome: SweepOutcome): string {
  return 'reason' in outcome ? `${outcome.result} ${outcome.slug}: ${outcome.reason}` : `${outcome.result} ${outcome.slug}`
}

// Sweeps worktrees of tasks whose STATUS is done — see src/worktreeSweep.ts.
// Report by default (read-only); removal only via --remove/--all-clean.
// Exit codes: 0 = ok (or nothing to do / not confirmed), 1 = bad usage or
// something broke (a git removal failed), 2 = at least one removal was
// refused because the worktree needs the developer.
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  // Same env-leak visibility as pipelinely-merge: stale e2e-fixture TASKS_DIR
  // inherited by an iTerm2 tab would otherwise sweep the wrong place silently.
  const tasksDir = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)
  if (!args.json) console.log(`tasks dir: ${tasksDir}`)

  if (!args.remove && !args.allClean) {
    const entries = await collectSweepEntries(tasksDir)
    if (args.json) console.log(JSON.stringify({ tasksDir, entries }, null, 2))
    else for (const line of formatSweepReport(entries)) console.log(line)
    return
  }

  const outcomes = await removeSweepEntries(tasksDir, {
    slugs: args.remove ?? undefined,
    allClean: args.allClean,
    confirm: args.yes ? undefined : askToConfirm,
  })
  if (args.json) console.log(JSON.stringify({ tasksDir, outcomes }, null, 2))
  else for (const outcome of outcomes) console.log(describeOutcome(outcome))

  if (outcomes.some((outcome) => outcome.result === 'failed')) process.exitCode = 1
  else if (outcomes.some((outcome) => outcome.result === 'refused')) process.exitCode = 2
}

main().catch((err) => {
  console.error(errorMessage(err))
  process.exitCode = 1
})
