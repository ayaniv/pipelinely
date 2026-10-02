import fs from 'node:fs/promises'
import path from 'node:path'

// Written by /pipelinely, but only when it's running inside tmux — the
// orchestrator's own tmux session name.
export function orchestratorTmuxPath(tasksDir: string): string {
  return path.join(tasksDir, 'ORCHESTRATOR_TMUX')
}

// null when no session is recorded. Any other read failure throws, so a caller
// that must fail closed (the answer-dialog route) can; callers for whom an
// unreadable file means "no orchestrator session" catch it themselves.
export async function readOrchestratorTmux(tasksDir: string): Promise<string | null> {
  try {
    return (await fs.readFile(orchestratorTmuxPath(tasksDir), 'utf-8')).trim() || null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
