import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openScratchSession, closeScratchSession, readSessionContents, frontmostAppName } from '../fixtures/itermSessions.js'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import { firstNonLoopbackIPv4 } from '../../src/testNetwork.js'

// REAL-INTEGRATION SPEC. It lives under e2e/integration/ and imports
// ../fixtures/itermSessions.js, whose module-scope assertIsolatedEnvironment()
// refuses to load anywhere but an isolated environment — so importing a single
// helper from it arms the guard before one osascript call can fire. Both facts
// are load-bearing: the 2026-09-06 incident happened because the previous
// attempt's equivalent spec sat in plain e2e/, ran under the everyday
// `npm run test:e2e`, and typed real keystrokes plus Return into the
// developer's live orchestrator tab.
//
// There is NO runner for e2e/integration/ today, on purpose (the local-VM path
// was rejected and removed; no remote VM path exists). This spec is written to
// be correct when a safe runner exists. Do not invent one to run it, and do not
// run any e2e command at all without asking the developer first, every time.
//
// What only a real terminal can settle: whether the command was SUBMITTED or
// left STAGED. The scratch session is an ordinary shell, so a submitted
// `/pipelinely-dev dev-ready` is executed and the shell answers "command not
// found"; a staged one sits at the prompt as inert text and the shell says
// nothing. That difference is the entire assertion here, in both directions:
//
//   remote peer  + autoSubmit:true  -> executed   (the feature)
//   loopback peer + autoSubmit:true -> still inert (the regression constraint)
//
// The remote case additionally asserts that iTerm2 was never raised to the OS
// foreground. That is the whole reason /stage-skill reaches for
// pasteIntoSessionQuiet rather than pasteIntoSession: this write fires
// unattended, triggered from a phone while the developer may be working in a
// completely unrelated app, and must not jump their windows. Asserting only
// that the text arrived would pass just as happily for the focus-stealing
// variant.
//
// The second case is the one that matters most. It is asserted here against
// real iTerm2, and again — deterministically, in the everyday verifier, with
// no terminal involved — by src/server.autoSubmit.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

const CTA_SLUG = 'dev-ready'
const STAGED_COMMAND = `/pipelinely-dev ${CTA_SLUG}`
// What an ordinary shell says when it is actually handed `/pipelinely-dev …` as a
// command — i.e. the observable proof that a Return was really sent.
// STAGED_COMMAND contains a `/`, so both zsh and bash treat it as a path
// lookup rather than a PATH search and reject it as "no such file or
// directory" (zsh's own wording, lowercase) rather than "command not found"
// (which only fires for a bare, slash-free word) — confirmed against a real
// captured session where the command really was submitted and executed.
// Matched case-insensitively since wording/casing can still vary by shell.
const SHELL_REJECTION = /command not found|no such file or directory/i

function portOf(baseURL: string): string {
  return new URL(baseURL).port
}

// Points the fixture ORCHESTRATOR_SESSION at a real scratch iTerm2 window for
// the duration of `fn`, then removes it. Held under withOrchestratorSessionLock
// because parallel Playwright workers share this one fixture file — see that
// fixture's own comment.
async function withScratchOrchestrator(fn: (sessionId: string) => Promise<void>): Promise<void> {
  await withOrchestratorSessionLock(async () => {
    const sessionId = await openScratchSession()
    await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId)
    try {
      await fn(sessionId)
    } finally {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await closeScratchSession(sessionId)
    }
  })
}

async function postStageSkill(origin: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}/stage-skill/${CTA_SLUG}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Serial for the same reason as resume-dead-session-fallback.spec.ts and
// orchestrator-session-self-heal.spec.ts: withScratchOrchestrator's lock
// already keeps two tests' real-window open/write/close bodies from
// overlapping, but 'remote request carrying autoSubmit:true' also samples
// frontmostAppName() *before* it acquires that lock — a genuinely
// concurrent sibling test's own window churn could still be caught mid-flight
// by that unlocked read. Serial mode only orders tests within this file; it
// does not protect against another spec file running in a different worker.
test.describe.configure({ mode: 'serial' })

test.describe('auto-submit is gated on a genuinely remote peer', () => {
  test('loopback request carrying autoSubmit:true is STILL only staged', async ({ baseURL }) => {
    await withScratchOrchestrator(async (sessionId) => {
      const res = await postStageSkill(`http://127.0.0.1:${portOf(baseURL!)}`, {
        stage: 'dev',
        autoSubmit: true,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ submitted: false })

      // The text must land — this is not a "nothing happened" assertion, it is
      // "the right thing happened and the Return was withheld".
      await expect.poll(() => readSessionContents(sessionId)).toContain(STAGED_COMMAND)
      expect(await readSessionContents(sessionId)).not.toMatch(SHELL_REJECTION)
    })
  })

  test('remote request carrying autoSubmit:true is actually submitted', async ({ baseURL }) => {
    const lanAddress = firstNonLoopbackIPv4()
    test.skip(
      lanAddress === null,
      'no non-internal IPv4 interface on this machine — cannot produce a non-loopback peer for the server to see',
    )

    // Captured before the dispatch and compared after it: the assertion is
    // "whatever was frontmost stayed frontmost", which holds regardless of
    // what the developer (or the harness) happened to have in front.
    const frontmostBefore = await frontmostAppName()

    await withScratchOrchestrator(async (sessionId) => {
      const res = await postStageSkill(`http://${lanAddress}:${portOf(baseURL!)}`, {
        stage: 'dev',
        autoSubmit: true,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ submitted: true })

      await expect.poll(() => readSessionContents(sessionId)).toMatch(SHELL_REJECTION)
      expect(await readSessionContents(sessionId)).toContain(STAGED_COMMAND)

      // Read after the write has demonstrably landed, so this cannot pass by
      // merely being quicker than an activate that was going to happen. Given
      // a short grace period rather than one point-in-time check: this reads
      // real, machine-wide OS focus, which unrelated activity on a real
      // developer desktop (another app, another already-open iTerm2 tab) can
      // also nudge — confirmed by an isolated repro of this exact
      // select+write-no-activate script independently catching a transient,
      // self-correcting focus change with nothing to do with this code path.
      // pasteIntoSessionQuiet has no restore-frontmost step of its own (unlike
      // openScratchSession/openNewTabRunning), so a real `activate` regression
      // leaves iTerm2 frontmost with nothing to put it back — it will not
      // settle back to frontmostBefore within the grace window the way
      // incidental noise does.
      await expect
        .poll(() => frontmostAppName(), { timeout: 1000 })
        .toBe(frontmostBefore)
    })
  })

  test('remote request WITHOUT the flag is staged, exactly as it is today', async ({ baseURL }) => {
    const lanAddress = firstNonLoopbackIPv4()
    test.skip(
      lanAddress === null,
      'no non-internal IPv4 interface on this machine — cannot produce a non-loopback peer for the server to see',
    )

    await withScratchOrchestrator(async (sessionId) => {
      const res = await postStageSkill(`http://${lanAddress}:${portOf(baseURL!)}`, { stage: 'dev' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ submitted: false })

      await expect.poll(() => readSessionContents(sessionId)).toContain(STAGED_COMMAND)
      expect(await readSessionContents(sessionId)).not.toMatch(SHELL_REJECTION)
    })
  })
})
