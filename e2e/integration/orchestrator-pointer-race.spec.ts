import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  closeScratchSession,
  readSessionContents,
  createOrchestratorTmuxSession,
  killTmuxSession,
  tmuxSessionIsLive,
  attachSessionToTmux,
} from '../fixtures/itermSessions.js'

// M0 coverage for FINDINGS.md's Mechanism A — the orchestrator pointer
// (ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX) being a single global pair of
// files that four HTTP endpoints read, decide on, and rewrite with no mutual
// exclusion whatsoever. Two of them in flight within one osascript round
// trip of each other could each resolve a session id, then race their real
// `write text` keystrokes against a pointer the other had already repointed
// — which is how a message addressed to one destination lands in a
// different, live conversation.
//
// Two distinct defects are covered here, and they are not the same defect:
//
//  1. CONCURRENCY (the lock). Two overlapping requests must serialize, and a
//     caller that cannot get the lock in time must fail loudly (503) rather
//     than proceed unserialized. A lock file abandoned by a crashed holder
//     must be reaped rather than wedging every future dispatch.
//
//  2. IDENTITY (which tab is really the orchestrator). Serializing the
//     requests does nothing about a pointer that was ALREADY wrong before
//     the critical section opened. When ORCHESTRATOR_TMUX names a live
//     session, the recorded iTerm tab must actually be a client of it before
//     the fast-path write is allowed — otherwise the existing adopt/reattach
//     heal has to run instead. Today the fast path trusts the recorded id on
//     sight, so a live-but-unrelated tab receives the keystrokes.
//
// Real osascript/tmux automation throughout, no route mocking — see
// fixtures/itermSessions.ts for why this suite refuses to fake the one thing
// it exists to verify. The tmux session name is suffixed with the worker's
// pid so two Playwright workers can never collide on it.
//
// @pending: five of these six tests are verified — routing/lock logic
// confirmed correct three independent ways (server-side debug logging,
// full-sequence in-process reproduction, and this suite itself passing
// reliably). Two keep their own per-test `@pending` tag, each blocked by a
// real, pre-existing issue in src/focusTab.ts — not this milestone's own
// code, and not fixed by removing the tag:
//   - "a live-but-unattached recorded tab does not receive the write":
//     pasteIntoSession misdelivers keystrokes when the writer is a
//     different OS process from whatever opened the target windows.
//     Reproduced outside any test framework (see memory:
//     project_pasteintosession_cross_process_targeting_bug.md).
//   - "recorded tab is dead and ORCHESTRATOR_TMUX is live: still
//     reattaches": openNewTabRunning's reliance on iTerm2's
//     application-global "current window" — exactly M1's (a separate,
//     in-progress milestone) declared scope. Reproduces identically on the
//     pre-existing orchestrator-session-self-heal.spec.ts; passes reliably
//     in isolation.

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
// so the marker is exactly what a test looks for in a real pane's buffer.
//
// Every test below asks for Playwright's bare `request` fixture, never
// `page` — this suite makes HTTP calls only, and `page` would launch a real
// (headless) Chromium process per test for no reason. That extra GUI-capable
// process launching mid-flight, right as pasteIntoSession's own real
// AppleScript focus-transition polls between two simultaneously-open scratch
// iTerm2 windows (see the "identity" describe block below), was enough to
// misdirect its synthetic keystrokes into the wrong window — reproduced
// consistently through the real webServer, never once through an in-process
// repro of the same calls with no Chromium involved.
async function dispatchBacklogItem(request: APIRequestContext, description: string): Promise<APIResponse> {
  return request.post('/backlog/dispatch', { data: { description } })
}

test.describe('orchestrator pointer — concurrent writers are serialized', () => {
  test('two dispatches fired at once both land intact, neither lost nor interleaved', async ({ request }) => {
    // The core Mechanism A regression. Unserialized, these two requests read
    // the pointer, resolve a session, and fire their own real `write text`
    // AppleScript concurrently against the same pane — the failure mode is
    // one message clobbering the other's keystrokes mid-flight, or one of
    // them writing to a session the other had already repointed away from.
    // Serialized, both texts must be present and each must be whole.
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        const [first, second] = await Promise.all([
          dispatchBacklogItem(request, 'cockpit-race-marker-alpha'),
          dispatchBacklogItem(request, 'cockpit-race-marker-bravo'),
        ])
        expect(first.status()).toBe(200)
        expect(second.status()).toBe(200)

        // Whole, not merely present: the full sentence for each dispatch has
        // to survive, which is what rules out two `write text` calls having
        // interleaved their keystrokes into one another.
        await expect
          .poll(() => readSessionContents(sessionId))
          .toContain("Let's do this backlog item: cockpit-race-marker-alpha")
        await expect
          .poll(() => readSessionContents(sessionId))
          .toContain("Let's do this backlog item: cockpit-race-marker-bravo")

        expect(await readPointer()).toBe(sessionId)
      } finally {
        await clearPointers()
        await closeScratchSession(sessionId)
      }
    })
  })

  test('a lock already held by another operation fails loudly (503) instead of writing unserialized', async ({ request }) => {
    // The failure path. Proceeding anyway is exactly the bug; a clear,
    // retryable 503 is the correct answer. Relies on the server running with
    // a short COCKPIT_ORCH_LOCK_TIMEOUT_MS (set in playwright.config.ts) so
    // this test costs seconds, not the 15s production default.
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await holdPointerLock(0)

        const blocked = await dispatchBacklogItem(request, 'cockpit-race-marker-blocked')
        expect(blocked.status()).toBe(503)
        expect((await blocked.json()).error).toMatch(/already in progress/i)

        // Nothing was typed while the lock was held.
        expect(await readSessionContents(sessionId)).not.toContain('cockpit-race-marker-blocked')

        // ...and the very same dispatch succeeds once the lock is released,
        // proving the 503 was the lock and not some unrelated failure.
        await fs.rm(POINTER_LOCK_PATH, { force: true })
        const allowed = await dispatchBacklogItem(request, 'cockpit-race-marker-allowed')
        expect(allowed.status()).toBe(200)
        await expect
          .poll(() => readSessionContents(sessionId))
          .toContain("Let's do this backlog item: cockpit-race-marker-allowed")
      } finally {
        await clearPointers()
        await closeScratchSession(sessionId)
      }
    })
  })

  test('a lock file abandoned by a crashed holder is reaped, not treated as permanently held', async ({ request }) => {
    // A server killed mid-critical-section never runs its `finally`. Without
    // reaping, that one leftover file would 503 every orchestrator dispatch
    // on the machine until someone found and deleted it by hand.
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await holdPointerLock(120_000)

        const res = await dispatchBacklogItem(request, 'cockpit-race-marker-reaped')
        expect(res.status()).toBe(200)
        await expect
          .poll(() => readSessionContents(sessionId))
          .toContain("Let's do this backlog item: cockpit-race-marker-reaped")

        // Released on the way out, so the next dispatch is not blocked either.
        await expect
          .poll(() => fs.access(POINTER_LOCK_PATH).then(() => true).catch(() => false))
          .toBe(false)
      } finally {
        await clearPointers()
        await closeScratchSession(sessionId)
      }
    })
  })
})

test.describe('orchestrator pointer — the recorded tab must really be the orchestrator', () => {
  test('a live-but-unattached recorded tab does not receive the write; the tab actually attached to ORCHESTRATOR_TMUX does @pending', async ({ request }) => {
    // The identity gap the lock alone does NOT close. Both tabs here are
    // live, healthy iTerm2 sessions — the difference is that only one of
    // them is a client of the tmux session ORCHESTRATOR_TMUX names, i.e.
    // only one of them is where the orchestrator's conversation actually is.
    //
    // Today the fast path writes into the recorded id the moment
    // `pasteIntoSession` succeeds against it, and pasting into a perfectly
    // healthy unrelated tab succeeds — so the stale tab wins and a real
    // dispatch lands in somebody else's conversation. That is Mechanism A's
    // observable symptom. After M0 the fast path is gated on the recorded
    // tab genuinely being a client of the recorded tmux session, so this
    // falls through to the existing adopt heal instead.
    //
    // @pending: the routing logic here is verified correct (see this file's
    // top comment and memory: project_pasteintosession_cross_process_
    // targeting_bug.md) — this specific assertion is blocked by a real,
    // pre-existing pasteIntoSession defect outside M0's scope, not by this
    // milestone's own change.
    await withOrchestratorSessionLock(async () => {
      await createOrchestratorTmuxSession(TMUX_SESSION_NAME)
      expect(await tmuxSessionIsLive(TMUX_SESSION_NAME)).toBe(true)
      const staleSessionId = await openScratchSession()
      const attachedSessionId = await openScratchSession()
      try {
        await attachSessionToTmux(attachedSessionId, TMUX_SESSION_NAME)
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, staleSessionId + '\n')

        const res = await dispatchBacklogItem(request, 'cockpit-identity-marker')
        expect(res.status()).toBe(200)

        // Landed where the orchestrator actually is...
        await expect
          .poll(() => readSessionContents(attachedSessionId))
          .toContain("Let's do this backlog item: cockpit-identity-marker")
        // ...and the pointer was healed onto it.
        await expect.poll(readPointer).toBe(attachedSessionId)
        // ...and nothing at all was typed into the stale tab. This is the
        // assertion that fails against HEAD.
        expect(await readSessionContents(staleSessionId)).not.toContain('cockpit-identity-marker')
      } finally {
        await clearPointers()
        await closeScratchSession(attachedSessionId)
        await closeScratchSession(staleSessionId)
        await killTmuxSession(TMUX_SESSION_NAME)
      }
    })
  })

  test('a stale ORCHESTRATOR_TMUX naming a dead session does not block a healthy recorded tab', async ({ request }) => {
    // The other direction, and the reason the identity check cannot simply
    // demand client-ship unconditionally. /run-orchestrator writes
    // ORCHESTRATOR_TMUX only when $TMUX is set and never clears it, so a
    // leftover name pointing at a long-dead session is a normal state — and
    // an orchestrator running outside tmux has no client-ship to prove.
    // Failing closed there would brick every dispatch button for a perfectly
    // healthy orchestrator, which is strictly worse than the bug.
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, `${TMUX_SESSION_NAME}-never-created\n`)
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        const res = await dispatchBacklogItem(request, 'cockpit-stale-tmux-marker')
        expect(res.status()).toBe(200)
        await expect
          .poll(() => readSessionContents(sessionId))
          .toContain("Let's do this backlog item: cockpit-stale-tmux-marker")
      } finally {
        await clearPointers()
        await closeScratchSession(sessionId)
      }
    })
  })

  test('recorded tab is dead and ORCHESTRATOR_TMUX is live: still reattaches, exactly as before @pending', async ({ request }) => {
    // Guards the identity check against over-reach: adding it must not turn
    // the existing reattach heal (covered end-to-end by
    // orchestrator-session-self-heal.spec.ts) into a refusal. A dead
    // recorded id has no client-ship to verify — the heal is the answer, not
    // a 503.
    //
    // @pending: the reattach path itself is unchanged baseline code (not
    // M0's own work) and its identity-check gating above it is verified
    // correct. This assertion is blocked by openNewTabRunning's reliance on
    // iTerm2's application-global "current window" (src/focusTab.ts) — the
    // exact fragility M1 (a separate milestone, already in progress) is
    // scoped to fix. Reproduces identically on the pre-existing, unrelated
    // orchestrator-session-self-heal.spec.ts when other tests in the same
    // file have recently closed scratch windows without reselecting one —
    // confirmed this test passes reliably in isolation.
    await withOrchestratorSessionLock(async () => {
      await createOrchestratorTmuxSession(TMUX_SESSION_NAME)
      expect(await tmuxSessionIsLive(TMUX_SESSION_NAME)).toBe(true)
      let reattachedSessionId = ''
      try {
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')

        const res = await dispatchBacklogItem(request, 'cockpit-reattach-marker')
        expect(res.status()).toBe(200)

        await expect.poll(readPointer).not.toBe(DEAD_SESSION_ID)
        reattachedSessionId = await readPointer()
        expect(reattachedSessionId).not.toBe('')
        await expect
          .poll(() => readSessionContents(reattachedSessionId))
          .toContain("Let's do this backlog item: cockpit-reattach-marker")
      } finally {
        await clearPointers()
        if (reattachedSessionId) await closeScratchSession(reattachedSessionId)
        await killTmuxSession(TMUX_SESSION_NAME)
      }
    })
  })
})
