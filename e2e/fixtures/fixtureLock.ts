import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Playwright runs spec files in separate parallel workers by default
// (fullyParallel), so any fixture file that more than one spec reads or
// writes for the duration of a scenario needs a cross-worker mutex. This is
// the one implementation of that mutex — an exclusive-create lock file that
// spins until it wins — parameterised only by which shared resource it
// guards. withOrchestratorSessionLock and withBacklogFileLock are the two
// named locks built on it; neither keeps its own copy of this body.
//
// **Lock ordering:** a test needing both must always take the backlog lock
// FIRST and the orchestrator-session lock second. Two nested locks taken in
// opposite orders by two workers deadlock, and this is the only rule that
// prevents it.
export async function withFixtureLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(__dirname, 'tasks', `.${lockName}.lock`)
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
}
