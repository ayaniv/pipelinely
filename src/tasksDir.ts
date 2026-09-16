import path from 'node:path'
import { CANONICAL_REPO_PATH, isCanonicalRepoPath } from './derivePort.js'

// Drains the reservoir documented in tech-design.md: `npm run dev` in a
// worktree never set TASKS_DIR, so every worktree preview server anyone
// ever started was a fully-armed handle on the real orchestrator's tasks
// dir — some alive for days. Binding it from a worktree is now a typed,
// deliberate act instead of a silent default.
export function resolveTasksDir(cwd: string, envValue: string | undefined): string {
  if (envValue) return path.resolve(envValue)
  if (isCanonicalRepoPath(cwd)) return path.join(CANONICAL_REPO_PATH, 'tasks')
  throw new Error(
    `resolveTasksDir: refusing to silently bind the real tasks dir from a worktree (${cwd}) — set TASKS_DIR explicitly:\n` +
      `  TASKS_DIR=${cwd}/e2e/fixtures/tasks npm run dev   # scratch preview against fixture data\n` +
      `  TASKS_DIR=${path.join(CANONICAL_REPO_PATH, 'tasks')} npm run dev   # deliberately point at real data`
  )
}
