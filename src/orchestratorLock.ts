import fs from 'node:fs/promises'
import path from 'node:path'

// Serializes every read-decide-write of ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX
// across every caller in this process — writeToOrchestrator (server.ts, used
// by /focus/:slug's fallback, /backlog/dispatch, /batch-dispatch, and
// /stage-skill/:slug's orchestrator branch) and POST /orchestrator/tab both
// read these two pointer files, decide whether/how to heal them, and
// (sometimes) rewrite ORCHESTRATOR_SESSION_PATH — and, until this lock
// existed, could do so from two concurrent Express request handlers with no
// mutual exclusion at all. Two overlapping calls could each read a
// consistent-looking pointer, decide independently, and then race their own
// `osascript`/`tmux` calls and their own file write — the second write
// clobbering the first, and/or a `write text` landing in whichever session
// the OTHER call had already reattached/adopted by the time this call's own
// AppleScript actually fired. That is the root cause documented in
// FINDINGS.md's Mechanism A.
//
// File-based (not an in-memory mutex) on purpose: ORCHESTRATOR_SESSION and
// ORCHESTRATOR_TMUX are themselves file-backed, process-external state — the
// /run-orchestrator skill's own guarded-write step (see its own SKILL.md)
// reads and writes them from a completely different OS process (the
// orchestrator's own Claude Code session running plain bash), which an
// in-memory lock inside this server's Node process could never see. A lock
// file colocated with the pointer files it protects is the one mechanism
// that can be honored by every writer, in-process or not — see that SKILL.md
// for the matching acquire/release step added there.
//
// Modeled on e2e/fixtures/orchestratorSessionLock.ts (which exists to stop
// parallel Playwright workers from stomping the *fixture* copies of these
// same two files), but hardened for production use rather than a test
// harness: a bounded acquire timeout (a hung critical section must not wedge
// every future orchestrator dispatch forever) and stale-lock reaping (a
// server process that crashes mid-critical-section must not leave a lock
// file that blocks every dispatch until someone notices and deletes it by
// hand).
//
// Deliberately a DIFFERENT filename from that e2e lock (`.orchestrator-
// session.lock`), even though both live under the same tasks dir during an
// e2e run (playwright.config.ts points the real server's TASKS_DIR at the
// same `e2e/fixtures/tasks` the test fixture lock also uses) — reusing that
// name was tried first and immediately self-deadlocked every e2e test: the
// test harness holds *its* lock for an entire test body (real page
// interactions, multiple assertions, well over ACQUIRE_TIMEOUT_MS), so this
// server's own lock — if it shared that file — would time out waiting on a
// completely unrelated lock held by the test process itself. The two lock
// files protect different populations of writers (this one: every
// pointer-touching code path inside this server process; that one: the
// test's own direct `fs.writeFile` calls that set up a scenario before/
// around hitting the server) and must stay on separate files so neither can
// block on the other.
const LOCK_FILE_NAME = '.orchestrator-pointer.lock'

// Generous relative to the actual critical section: the slowest real path
// through it (reattachAndRecord -> reattachTmuxSession -> openNewTabRunning
// + waitForTmuxAttach's own 2s timeout, or pasteIntoSession's ~2s frontmost
// poll + ~2s confirm poll) completes in single-digit seconds even under
// load. 15s leaves real headroom without making a genuinely stuck lock (a
// crashed holder, see STALE_LOCK_MS below) block every dispatch for long.
//
// COCKPIT_ORCH_LOCK_TIMEOUT_MS overrides this for the e2e suite only
// (playwright.config.ts's webServer.env) — the "lock already held" test
// needs to actually observe a timeout, and proving that logic at 15s costs
// 15 real seconds of wall clock for no more proof than the same logic run
// against a smaller number. That override is process-wide, though — every
// e2e test hits this same server, including "two dispatches fired at once
// both land intact", which waits on a real pasteIntoSession critical section
// (the ~2s frontmost poll + ~2s confirm poll cited just above). The override
// has to stay comfortably above that real worst case, not just short enough
// to save time — see playwright.config.ts's own comment on the chosen value.
const ACQUIRE_TIMEOUT_MS = process.env.COCKPIT_ORCH_LOCK_TIMEOUT_MS
  ? parseInt(process.env.COCKPIT_ORCH_LOCK_TIMEOUT_MS, 10)
  : 15_000
const POLL_INTERVAL_MS = 50

// A lock file older than this is assumed to belong to a holder that crashed
// (or was killed) before its `finally` block could remove it, rather than
// one that is still legitimately working — see ACQUIRE_TIMEOUT_MS's own
// comment for why this is well above any real critical section's duration.
const STALE_LOCK_MS = 30_000

export class OrchestratorLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for the orchestrator session lock at ${lockPath}`)
    this.name = 'OrchestratorLockTimeoutError'
  }
}

function lockPathFor(tasksDir: string): string {
  return path.join(tasksDir, LOCK_FILE_NAME)
}

// Atomic: `wx` fails with EEXIST if the file already exists, which is what
// makes "create the lock file" and "hold the lock" the same event — no
// separate check-then-create window for two callers to both slip through.
async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath, 'wx')
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

// Best-effort: removes the lock file only if it looks abandoned (older than
// `staleLockMs`, see STALE_LOCK_MS's own comment). Swallows read/parse
// errors rather than reaping on them — a lock file that's mid-write (another
// process's tryAcquire between `open` and `writeFile`) or already gone
// (another waiter reaped it first) must be left alone/ignored, not treated
// as proof of staleness.
async function reapIfStale(lockPath: string, staleLockMs: number): Promise<void> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8')
    const { acquiredAt } = JSON.parse(raw) as { acquiredAt?: number }
    if (typeof acquiredAt === 'number' && Date.now() - acquiredAt > staleLockMs) {
      await fs.rm(lockPath, { force: true })
    }
  } catch {
    // Not our call to make right now — see comment above.
  }
}

// Test-only knobs: production callers never pass these, so they always get
// ACQUIRE_TIMEOUT_MS/POLL_INTERVAL_MS/STALE_LOCK_MS above. Real orchestrator
// lock contention resolves in low hundreds of ms at worst, so exercising the
// 15s/30s production values directly in a test would make the suite slow
// without proving anything the same logic run against smaller numbers
// doesn't already prove.
export interface OrchestratorLockTiming {
  acquireTimeoutMs?: number
  pollIntervalMs?: number
  staleLockMs?: number
}

// Runs `fn` with exclusive ownership of the orchestrator session pointer
// files under `tasksDir`. Throws OrchestratorLockTimeoutError if the lock
// isn't acquired within `timing.acquireTimeoutMs` (default
// ACQUIRE_TIMEOUT_MS — callers should treat this as a distinct, reportable
// failure — "try again" — not a crash: see writeToOrchestrator's and POST
// /orchestrator/tab's handling of it in server.ts). Always releases the lock
// on the way out, success or failure — the `finally` covers both `fn`
// throwing and this function's own timeout path never having acquired it in
// the first place is handled by the loop simply exiting via `throw` before
// entering the `try`.
export async function withOrchestratorLock<T>(
  tasksDir: string,
  fn: () => Promise<T>,
  timing: OrchestratorLockTiming = {},
): Promise<T> {
  const acquireTimeoutMs = timing.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS
  const pollIntervalMs = timing.pollIntervalMs ?? POLL_INTERVAL_MS
  const staleLockMs = timing.staleLockMs ?? STALE_LOCK_MS

  const lockPath = lockPathFor(tasksDir)
  const deadline = Date.now() + acquireTimeoutMs
  while (!(await tryAcquire(lockPath))) {
    await reapIfStale(lockPath, staleLockMs)
    if (Date.now() >= deadline) throw new OrchestratorLockTimeoutError(lockPath)
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
}
