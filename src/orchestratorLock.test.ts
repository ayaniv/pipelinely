import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withOrchestratorLock, OrchestratorLockTimeoutError } from './orchestratorLock.js'

// Regression coverage for the fix to FINDINGS.md's "Mechanism A": two
// concurrent callers reading/deciding/writing ORCHESTRATOR_SESSION and
// ORCHESTRATOR_TMUX with no mutual exclusion, which could let one caller's
// keystrokes land in a session another caller had already reattached/adopted
// out from under it. This suite proves the lock primitive itself — that no
// two `withOrchestratorLock` critical sections over the same tasksDir can
// ever run concurrently, that a timeout/error releases cleanly rather than
// wedging future callers, and that an abandoned lock file gets reaped — all
// without touching real osascript/tmux (unlike e2e/fixtures/
// orchestratorSessionLock.ts, which exists only to stop parallel Playwright
// *workers* from clobbering the fixture pointer files and proves nothing
// about the production locking behavior this fix adds).

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-orchestrator-lock-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('withOrchestratorLock', () => {
  it('runs fn and returns its result when uncontended', async () => {
    const result = await withOrchestratorLock(tmpDir, async () => 'ok')
    expect(result).toBe('ok')
  })

  it('removes the lock file after a successful run, so a later call does not have to wait or reap anything', async () => {
    await withOrchestratorLock(tmpDir, async () => undefined)
    await expect(fs.access(path.join(tmpDir, '.orchestrator-pointer.lock'))).rejects.toThrow()
  })

  it('removes the lock file even when fn throws, so one failed critical section cannot wedge every later caller', async () => {
    await expect(
      withOrchestratorLock(tmpDir, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(fs.access(path.join(tmpDir, '.orchestrator-pointer.lock'))).rejects.toThrow()

    // Proves the release actually worked, not just that the file happens to
    // be gone: a fresh call must succeed immediately, not time out.
    const result = await withOrchestratorLock(tmpDir, async () => 'recovered')
    expect(result).toBe('recovered')
  })

  it('serializes two concurrent callers — the core regression case: a second critical section can never start while the first is still inside its own read-decide-write window', async () => {
    // Reproduces the exact shape of the original race: two "requests" each
    // read some shared state, then (after doing other async work — the
    // stand-in for osascript/tmux round trips) write their own value based
    // on what they read. Unlocked, B's read can land between A's read and
    // A's write, and then both writes race — exactly what let one caller's
    // keystrokes get typed against a pointer another caller had already
    // changed. Locked, B's read must always observe A's completed write.
    let sharedState = 'initial'
    const observedReads: string[] = []
    let concurrentEntries = 0
    let maxConcurrentEntries = 0

    const runner = (id: string, writesTo: string) => withOrchestratorLock(tmpDir, async () => {
      concurrentEntries++
      maxConcurrentEntries = Math.max(maxConcurrentEntries, concurrentEntries)
      try {
        observedReads.push(`${id}:${sharedState}`)
        // A real critical section always does real async work (osascript/
        // tmux round trips) between its read and its write — without the
        // lock, this is exactly the window the other caller's read/write
        // would race into.
        await new Promise((resolve) => setTimeout(resolve, 20))
        sharedState = writesTo
      } finally {
        concurrentEntries--
      }
    })

    await Promise.all([runner('A', 'from-A'), runner('B', 'from-B')])

    expect(maxConcurrentEntries).toBe(1)
    // Whichever caller ran second must have observed the first caller's
    // completed write, not the pre-lock 'initial' value — proof the lock
    // enforces a real happens-before between them, not just non-overlapping
    // timestamps.
    const second = observedReads[1]
    expect(second).not.toContain(':initial')
  })

  it('a slow holder blocks a waiter until it releases, then the waiter proceeds — proves waiting, not silent skipping', async () => {
    const order: string[] = []
    const slow = withOrchestratorLock(tmpDir, async () => {
      order.push('slow-start')
      await new Promise((resolve) => setTimeout(resolve, 100))
      order.push('slow-end')
    })
    // Give `slow` a head start so it reliably wins the initial acquire.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const waiter = withOrchestratorLock(tmpDir, async () => {
      order.push('waiter-start')
    })

    await Promise.all([slow, waiter])
    expect(order).toEqual(['slow-start', 'slow-end', 'waiter-start'])
  })

  it('throws OrchestratorLockTimeoutError when the lock cannot be acquired in time, and never calls fn', async () => {
    let fnCalled = false
    const holder = withOrchestratorLock(tmpDir, async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    // Give the holder time to actually acquire before the impatient caller
    // tries — otherwise both could race for the initial acquire.
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(
      withOrchestratorLock(
        tmpDir,
        async () => {
          fnCalled = true
        },
        { acquireTimeoutMs: 60, pollIntervalMs: 10 },
      ),
    ).rejects.toBeInstanceOf(OrchestratorLockTimeoutError)
    expect(fnCalled).toBe(false)

    await holder
  })

  it('reaps a stale lock file left by a crashed holder (no matching release) instead of blocking forever', async () => {
    const lockPath = path.join(tmpDir, '.orchestrator-pointer.lock')
    // Simulate a holder that acquired the lock and then crashed before its
    // `finally` ran — an old acquiredAt timestamp, file left behind forever.
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() - 10_000 }))

    const result = await withOrchestratorLock(
      tmpDir,
      async () => 'acquired-after-reap',
      { staleLockMs: 50, acquireTimeoutMs: 2000, pollIntervalMs: 10 },
    )
    expect(result).toBe('acquired-after-reap')
  })

  it('does not reap a lock that is merely young — a real in-progress holder is not mistaken for a crashed one', async () => {
    const lockPath = path.join(tmpDir, '.orchestrator-pointer.lock')
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }))

    await expect(
      withOrchestratorLock(
        tmpDir,
        async () => 'should-not-run',
        { staleLockMs: 10_000, acquireTimeoutMs: 80, pollIntervalMs: 10 },
      ),
    ).rejects.toBeInstanceOf(OrchestratorLockTimeoutError)
  })

  // M0.5: COCKPIT_ORCH_LOCK_TIMEOUT_MS lets the e2e suite (see
  // playwright.config.ts's webServer.env) prove the "lock already held"
  // timeout in ~2s instead of paying the real 15s production default. The
  // constant is read at module load, so this re-imports the module with the
  // env var set rather than passing an explicit `timing` override — proving
  // the *default* actually moves, not just that an override still works
  // (already covered by every other test in this file).
  it('honors COCKPIT_ORCH_LOCK_TIMEOUT_MS as the default acquire timeout when no explicit timing override is given', async () => {
    vi.resetModules()
    process.env.COCKPIT_ORCH_LOCK_TIMEOUT_MS = '80'
    try {
      const fresh = await import('./orchestratorLock.js')
      const holder = fresh.withOrchestratorLock(tmpDir, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      // Give the holder time to actually acquire before the impatient
      // caller tries — same reasoning as the explicit-timing test above.
      await new Promise((resolve) => setTimeout(resolve, 20))

      const start = Date.now()
      await expect(fresh.withOrchestratorLock(tmpDir, async () => 'should-not-run'))
        .rejects.toBeInstanceOf(fresh.OrchestratorLockTimeoutError)
      // Well under the 15s production default — proof the env var, not the
      // hardcoded constant, decided this timeout.
      expect(Date.now() - start).toBeLessThan(1000)

      await holder
    } finally {
      delete process.env.COCKPIT_ORCH_LOCK_TIMEOUT_MS
      vi.resetModules()
    }
  })
})
