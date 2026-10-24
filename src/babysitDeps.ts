import os from 'node:os'
import { execa } from 'execa'
import type { BabysitDeps } from './babysit.js'
import { findPrByBranch } from './gitOps.js'
import { loadTasks } from './loadTasks.js'
import { readPrMergeState } from './mergeGate.js'
import { createPrMergeStateCache, createPrNumberCache, repoPrMergeStateLookup, repoPrNumberLookup } from './prLookup.js'
import { readSettings } from './taskParser.js'

// Read-only. tmux exits non-zero when no server is running, which just means
// "no sessions"; anything else is a real failure the caller must see rather
// than a fresh name guessed against an unknown set.
async function listTmuxSessions(): Promise<string[]> {
  const result = await execa('tmux', ['list-sessions', '-F', '#{session_name}'], { reject: false })
  if (result.exitCode === 0) return result.stdout.split('\n').filter(Boolean)
  const stderr = String(result.stderr ?? '')
  if (/no server running|no sessions|error connecting/i.test(stderr)) return []
  throw new Error(`tmux list-sessions failed: ${stderr || result.shortMessage}`)
}

// The CLI's real wiring: the tasks dir on disk, `gh` from each task's repo
// checkout, the machine load and tmux. One factory so the CLI and the
// real-file tests cannot read tasks differently.
export function babysitDeps(tasksDir: string): BabysitDeps {
  return {
    tasksDir,
    readSettings,
    // New caches every call: a merge since the last call changes every other
    // PR's mergeability, so a sweep never acts on the server's 60-second state.
    loadTasks: (dir, settings) =>
      loadTasks(dir, settings, {
        lookUpPrNumber: repoPrNumberLookup(findPrByBranch, dir),
        lookUpPrMergeState: repoPrMergeStateLookup(readPrMergeState, dir),
        prNumberCache: createPrNumberCache(),
        prMergeStateCache: createPrMergeStateCache(),
      }),
    loadavg: () => os.loadavg()[0],
    listTmuxSessions,
  }
}
