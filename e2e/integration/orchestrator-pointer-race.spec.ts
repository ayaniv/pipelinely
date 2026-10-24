import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  closeScratchSession,
  readSessionContents,
  readTmuxPaneContents,
  countWindows,
  countSessions,
  createOrchestratorTmuxSession,
  killTmuxSession,
  tmuxSessionIsLive,
  attachSessionToTmux,
} from '../fixtures/itermSessions.js'

// Coverage for FINDINGS.md's Mechanism A — the orchestrator pointer
// (ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX) being a single global pair of
// files that several HTTP endpoints read, decide on, and rewrite. Two
// requests in flight at once must not interleave their writes, and a message
// addressed to the orchestrator must never land in a different, live
// conversation.
//
// Two distinct defects are covered here, and they are not the same defect:
//
//  1. CONCURRENCY (the lock). Two overlapping requests must serialize, and a
//     caller that cannot get the lock in time must fail loudly (503) rather
//     than proceed unserialized. A lock file abandoned by a crashed holder
//     must be reaped rather than wedging every future dispatch.
//
//  2. IDENTITY (which conversation is really the orchestrator). The
//     recorded tmux session in ORCHESTRATOR_TMUX is the orchestrator's
//     identity: every dispatch is pasted into that session's pane and
//     nowhere else, whatever iTerm tab ORCHESTRATOR_SESSION happens to name.
//     There is no keystroke fallback, so a missing or dead tmux session is a
//     503, never a write into some other tab.
//
// The scratch orchestrator is a uniquely named tmux session whose pane runs
// the fake claude (see fixtures/itermSessions.ts), and delivery is asserted
// by reading that pane with `tmux capture-pane`. iTerm scratch tabs appear
// only as bystanders (to prove nothing was typed into them) and as the tab a
// session is attached through. Real tmux/osascript automation throughout, no
// route mocking. The tmux session name is suffixed with the worker's pid so
// two Playwright workers can never collide on it.
//
// @pending: two of these tests keep their own per-test `@pending` tag until
// the developer has run this suite against the tmux writer; they were
// previously blocked by the AppleScript writer's cross-process window
// targeting and by openNewTabRunning's "current window" use.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')
const ORCHESTRATOR_TMUX_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_TMUX')

// Deliberately NOT `.orchestrator-session.lock`, which is
// fixtures/orchestratorSessionLock.ts's own test-harness lock over the same
// fixture directory. The two protect different populations of writers and
// must never share a file — see src/orchestratorLock.ts's comment.
const POINTER_LOCK_PATH = path.join(TASKS_DIR, '.orchestrator-pointer.lock')

const TMUX_SESSION_NAME = `cockpit-e2e-pointer-${process.pid}`
const DEAD_SESSION_ID = 'dead-orchestrator-session-not-real'

// Serial for the same reason as resume-dead-session-fallback.spec.ts and
// orchestrator-session-self-heal.spec.ts: every test here writes the same
// shared pointer files. withOrchestratorSessionLock inside each test body is
// what protects it from OTHER spec files running in parallel workers; serial
// mode only orders tests within this file.
test.describe.configure({ mode: 'serial' })

async function readPointer(): Promise<string> {
  return (await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8').catch(() => '')).trim()
}

async function clearPointers(): Promise<void> {
  await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
  await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
  await fs.rm(POINTER_LOCK_PATH, { force: true })
}

// Writes the lock file exactly as src/orchestratorLock.ts's own tryAcquire
// does, with a caller-chosen age — so a test can stand up either a lock a
// live holder is legitimately using (age 0) or one a crashed holder
// abandoned (age well past STALE_LOCK_MS).
async function holdPointerLock(ageMs: number): Promise<void> {
  await fs.writeFile(
    POINTER_LOCK_PATH,
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - ageMs }),
  )
}

// One dispatch, addressed by a marker string unique to the test that sent
// it — /backlog/dispatch pastes "Let's do this backlog item: <description>",
// so the marker is exactly what a test looks for in the tmux pane.
//
// Every test below asks for Playwright's bare `request` fixture, never
// `page` — this suite makes HTTP calls only, and `page` would launch a real
// (headless) Chromium process per test for no reason.
async function dispatchBacklogItem(request: APIRequestContext, description: string): Promise<APIResponse> {
  return request.post('/backlog/dispatch', { data: { description } })
}

// Stands up the scratch orchestrator: a tmux session running the fake claude,
// recorded as ORCHESTRATOR_TMUX. ORCHESTRATOR_SESSION is deliberately left
// unset — a send must not need an iTerm tab at all.
async function startTmuxOrchestrator(): Promise<void> {
  await createOrchestratorTmuxSession(TMUX_SESSION_NAME)
  expect(await tmuxSessionIsLive(TMUX_SESSION_NAME)).toBe(true)
  await clearPointers()
  await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
}

async function stopTmuxOrchestrator(): Promise<void> {
  await clearPointers()
  await killTmuxSession(TMUX_SESSION_NAME)
}

test.describe('orchestrator pointer — concurrent writers are serialized', () => {
  test('two dispatches fired at once both land intact, neither lost nor interleaved', async ({ request }) => {
    // The core Mechanism A regression. Unserialized, these two requests would
    // paste into the same pane concurrently — the failure mode is one
    // message clobbering the other mid-paste. Serialized, both texts must be
    // present and each must be whole.
    await withOrchestratorSessionLock(async () => {
      try {
        await startTmuxOrchestrator()

        const [first, second] = await Promise.all([
          dispatchBacklogItem(request, 'cockpit-race-marker-alpha'),
          dispatchBacklogItem(request, 'cockpit-race-marker-bravo'),
        ])
        expect(first.status()).toBe(200)
        expect(second.status()).toBe(200)

        // Whole, not merely present: the full sentence for each dispatch has
        // to survive, which is what rules out two pastes having interleaved.
        await expect
          .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
          .toContain("Let's do this backlog item: cockpit-race-marker-alpha")
        await expect
          .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
          .toContain("Let's do this backlog item: cockpit-race-marker-bravo")
      } finally {
        await stopTmuxOrchestrator()
      }
    })
  })

  test('a lock already held by another operation fails loudly (503) instead of writing unserialized', async ({ request }) => {
    // The failure path. Proceeding anyway is exactly the bug; a clear,
    // retryable 503 is the correct answer. Relies on the server running with
    // a short COCKPIT_ORCH_LOCK_TIMEOUT_MS (set in playwright.config.ts) so
    // this test costs seconds, not the 15s production default.
    await withOrchestratorSessionLock(async () => {
      try {
        await startTmuxOrchestrator()
        await holdPointerLock(0)

        const blocked = await dispatchBacklogItem(request, 'cockpit-race-marker-blocked')
        expect(blocked.status()).toBe(503)
        expect((await blocked.json()).error).toMatch(/already in progress/i)

        // Nothing was pasted while the lock was held.
        expect(await readTmuxPaneContents(TMUX_SESSION_NAME)).not.toContain('cockpit-race-marker-blocked')

        // ...and the very same dispatch succeeds once the lock is released,
        // proving the 503 was the lock and not some unrelated failure.
        await fs.rm(POINTER_LOCK_PATH, { force: true })
        const allowed = await dispatchBacklogItem(request, 'cockpit-race-marker-allowed')
        expect(allowed.status()).toBe(200)
        await expect
          .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
          .toContain("Let's do this backlog item: cockpit-race-marker-allowed")
      } finally {
        await stopTmuxOrchestrator()
      }
    })
  })

  test('a lock file abandoned by a crashed holder is reaped, not treated as permanently held', async ({ request }) => {
    // A server killed mid-critical-section never runs its `finally`. Without
    // reaping, that one leftover file would 503 every orchestrator dispatch
    // on the machine until someone found and deleted it by hand.
    await withOrchestratorSessionLock(async () => {
      try {
        await startTmuxOrchestrator()
        await holdPointerLock(120_000)

        const res = await dispatchBacklogItem(request, 'cockpit-race-marker-reaped')
        expect(res.status()).toBe(200)
        await expect
          .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
          .toContain("Let's do this backlog item: cockpit-race-marker-reaped")

        // Released on the way out, so the next dispatch is not blocked either.
        await expect
          .poll(() => fs.access(POINTER_LOCK_PATH).then(() => true).catch(() => false))
          .toBe(false)
      } finally {
        await stopTmuxOrchestrator()
      }
    })
  })
})

test.describe('orchestrator pointer — ORCHESTRATOR_TMUX is the orchestrator, not the recorded tab', () => {
  test('a live-but-unattached recorded tab does not receive the write; the tmux pane does @pending', async ({ request }) => {
    // The identity gap the lock alone does NOT close. Both tabs here are
    // live, healthy iTerm2 sessions — the difference is that only one of
    // them is a client of the tmux session ORCHESTRATOR_TMUX names, i.e.
    // only one of them is where the orchestrator's conversation actually is.
    // The write goes into the tmux pane itself, so the stale tab can never
    // receive it, and the pointer is re-recorded onto the attached tab.
    await withOrchestratorSessionLock(async () => {
      const staleSessionId = await openScratchSession()
      const attachedSessionId = await openScratchSession()
      try {
        await startTmuxOrchestrator()
        await attachSessionToTmux(attachedSessionId, TMUX_SESSION_NAME)
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, staleSessionId + '\n')

        const res = await dispatchBacklogItem(request, 'cockpit-identity-marker')
        expect(res.status()).toBe(200)

        // Landed where the orchestrator actually is...
        await expect
          .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
          .toContain("Let's do this backlog item: cockpit-identity-marker")
        // ...the pointer was healed onto the tab attached to it...
        await expect.poll(readPointer).toBe(attachedSessionId)
        // ...and nothing at all was typed into the stale tab.
        expect(await readSessionContents(staleSessionId)).not.toContain('cockpit-identity-marker')
      } finally {
        await stopTmuxOrchestrator()
        await closeScratchSession(attachedSessionId)
        await closeScratchSession(staleSessionId)
      }
    })
  })

  test('a stale ORCHESTRATOR_TMUX naming a dead session is a 503, even with a healthy recorded tab', async ({ request }) => {
    // There is no keystroke fallback: /pipelinely writes
    // ORCHESTRATOR_TMUX only when $TMUX is set and never clears it, so a
    // leftover name pointing at a long-dead session is a normal state, and
    // the only safe answer to it is a loud refusal. Writing into the healthy
    // recorded tab instead is the misdelivery this plan exists to remove.
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, `${TMUX_SESSION_NAME}-never-created\n`)
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        const res = await dispatchBacklogItem(request, 'cockpit-stale-tmux-marker')
        expect(res.status()).toBe(503)
        expect((await res.json()).error).toMatch(/tmux/i)

        expect(await readSessionContents(sessionId)).not.toContain('cockpit-stale-tmux-marker')
        expect(await readPointer()).toBe(sessionId)
      } finally {
        await clearPointers()
        await closeScratchSession(sessionId)
      }
    })
  })

  test('recorded tab is dead and ORCHESTRATOR_TMUX is live: the send lands in the pane without opening a window @pending', async ({ request }) => {
    // A send never reattaches a tab: the pane is written directly, so a dead
    // recorded id costs nothing. Opening a window here would be the old
    // reattach-before-write heal creeping back in.
    await withOrchestratorSessionLock(async () => {
      try {
        await startTmuxOrchestrator()
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')

        const windowsBefore = await countWindows()
        const sessionsBefore = await countSessions()

        const res = await dispatchBacklogItem(request, 'cockpit-reattach-marker')
        expect(res.status()).toBe(200)

        await expect
          .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
          .toContain("Let's do this backlog item: cockpit-reattach-marker")

        expect(await countWindows()).toBe(windowsBefore)
        expect(await countSessions()).toBe(sessionsBefore)
        // No tab is attached to the tmux session, so there is nothing to
        // re-record: the dead id stays as it was.
        expect(await readPointer()).toBe(DEAD_SESSION_ID)
      } finally {
        await stopTmuxOrchestrator()
      }
    })
  })

  test('no ORCHESTRATOR_TMUX recorded is a 503 and types nothing into the recorded tab', async ({ request }) => {
    // An orchestrator outside tmux can no longer receive dispatches; the
    // failure has to be loud and must not leak into the recorded tab.
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        const res = await dispatchBacklogItem(request, 'cockpit-no-tmux-marker')
        expect(res.status()).toBe(503)

        expect(await readSessionContents(sessionId)).not.toContain('cockpit-no-tmux-marker')
      } finally {
        await clearPointers()
        await closeScratchSession(sessionId)
      }
    })
  })
})
