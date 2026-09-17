import { execa } from 'execa'

export interface ValidationResult {
  ok: boolean
  failures: string[]
}

type CommandRunner = (cmd: string, args: string[]) => Promise<{ exitCode: number | null }>

const defaultRunner: CommandRunner = async (cmd, args) => {
  const result = await execa(cmd, args, { reject: false })
  return { exitCode: result.exitCode ?? null }
}

interface Check {
  run: (runCommand: CommandRunner) => Promise<boolean>
  failureMessage: string
}

const CHECKS: Check[] = [
  { run: async (r) => (await r('git', ['--version'])).exitCode === 0, failureMessage: 'git not found on PATH' },
  { run: async (r) => (await r('node', ['--version'])).exitCode === 0, failureMessage: 'node not found on PATH' },
  { run: async (r) => (await r('npm', ['--version'])).exitCode === 0, failureMessage: 'npm not found on PATH' },
  { run: async (r) => (await r('tmux', ['-V'])).exitCode === 0, failureMessage: 'tmux not found on PATH' },
  { run: async (r) => (await r('gh', ['auth', 'status'])).exitCode === 0, failureMessage: 'gh not found on PATH, or not authenticated' },
  {
    run: async (r) => (await r('claude', ['plugin', 'list'])).exitCode === 0,
    failureMessage: 'could not confirm the superpowers plugin — run `claude plugin install superpowers`',
  },
]

export async function validateEnvironment(runCommand: CommandRunner = defaultRunner): Promise<ValidationResult> {
  const failures: string[] = []
  for (const check of CHECKS) {
    if (!(await check.run(runCommand))) failures.push(check.failureMessage)
  }
  return { ok: failures.length === 0, failures }
}
