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
//
// **Stale-lock reaping**, mirroring src/orchestratorLock.ts's own
// tryAcquire/reapIfStale (that file's comment names this one as its model,
// deliberately left unhardened at the time since a test holder was assumed
// to always release via its own `finally`). That assumption broke in
// practice: a test that hits Playwright's own test-level timeout has its
// worker killed rather than unwound, so this function's `finally` below
// never runs and the lock file is left behind forever — observed
// 2026-09-14 as a full-suite cascade under `workers: 1`
// (playwright.config.ts's `integration` project), where one timed-out test
// left `.orchestrator-session.lock` on disk and every later test needing it
// spun for the rest of the run, each hitting the same 30s test timeout with
// no other error. STALE_LOCK_MS is comfortably above
// PLAYWRIGHT_TEST_TIMEOUT_MS (a lock legitimately spans an entire test
// body — real page interactions, multiple `expect.poll`s — which can itself
// run right up to that limit) so a still-legitimately-held lock is never
// reaped out from under its holder.
const PLAYWRIGHT_TEST_TIMEOUT_MS = 30_000
const STALE_LOCK_MS = PLAYWRIGHT_TEST_TIMEOUT_MS + 15_000

async function reapIfStale(lockPath: string): Promise<void> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8')
    const { acquiredAt } = JSON.parse(raw) as { acquiredAt?: number }
    if (typeof acquiredAt === 'number' && Date.now() - acquiredAt > STALE_LOCK_MS) {
      await fs.rm(lockPath, { force: true })
    }
  } catch {
    // Not our call to make right now — a lock file mid-write by another
    // acquirer, or already reaped by a sibling waiter, must be left alone
    // rather than treated as proof of staleness. Same reasoning as
    // orchestratorLock.ts's own reapIfStale.
  }
}

export async function withFixtureLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(__dirname, 'tasks', `.${lockName}.lock`)
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
      } finally {
        await handle.close()
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      await reapIfStale(lockPath)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
}
