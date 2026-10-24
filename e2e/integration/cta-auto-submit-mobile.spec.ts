import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  openScratchSession,
  closeScratchSession,
  attachSessionToTmux,
  createOrchestratorTmuxSession,
  readTmuxPaneContents,
  killTmuxSession,
  frontmostAppName,
  tmuxEnterWasPressed,
} from '../fixtures/itermSessions.js'
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
// left STAGED. The scratch orchestrator is a tmux session whose pane runs a
// fake claude (named in the fixture ORCHESTRATOR_TMUX) that never reads its
// tty, so the tty just echoes what the server writes. A pasted command shows
// up as text with the cursor sitting right after it; a pressed Enter moves
// the cursor to column 0 of the next line. That difference is the entire
// assertion here, in both directions:
//
//   remote peer  + autoSubmit:true  -> Enter pressed (the feature)
//   loopback peer + autoSubmit:true -> still unsent (the regression constraint)
//
// The remote case additionally asserts that iTerm2 was never raised to the OS
// foreground. A 'send' write pastes into the tmux pane and never activates
// iTerm2 (it only reads which tab is attached, to re-record the pointer), and
// this write fires unattended, triggered from a phone
// while the developer may be working in a completely unrelated app, so it
// must not jump their windows. Asserting only that the text arrived would
// pass just as happily for a focus-stealing variant.
//
// The second case is the one that matters most. It is asserted here against a
// real tmux pane, and again — deterministically, in the everyday verifier, with
// no terminal involved — by src/server.autoSubmit.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')
const ORCHESTRATOR_TMUX_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_TMUX')

const CTA_SLUG = 'dev-ready'
const STAGED_COMMAND = `/pipelinely-dev ${CTA_SLUG}`
function portOf(baseURL: string): string {
  return new URL(baseURL).port
}

// Points the fixture ORCHESTRATOR_TMUX at a scratch tmux session running a
// fake claude for the duration of `fn`, then removes it. Held under
// withOrchestratorSessionLock because parallel Playwright workers share this
// one fixture file — see that fixture's own comment. `hasAttachedTab` attaches
// a scratch iTerm2 tab to the session for the stage writes, which focus the
// attached tab and would otherwise open a window this test cannot clean up.
async function withTmuxOrchestrator(
  { hasAttachedTab }: { hasAttachedTab: boolean },
  fn: (tmuxName: string) => Promise<void>,
): Promise<void> {
  await withOrchestratorSessionLock(async () => {
    const tmuxName = `cockpit-e2e-cta-${randomUUID().slice(0, 8)}`
    await createOrchestratorTmuxSession(tmuxName)
    const attachedTabId = hasAttachedTab ? await openScratchSession() : null
    try {
      if (attachedTabId) await attachSessionToTmux(attachedTabId, tmuxName)
      await fs.writeFile(ORCHESTRATOR_TMUX_PATH, tmuxName + '\n')
      await fn(tmuxName)
    } finally {
      await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
      // The server re-records the attached tab here after a write.
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      if (attachedTabId) await closeScratchSession(attachedTabId)
      await killTmuxSession(tmuxName)
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
// orchestrator-session-self-heal.spec.ts: withTmuxOrchestrator's lock
// already keeps two tests' real-window open/write/close bodies from
// overlapping, but 'remote request carrying autoSubmit:true' also samples
// frontmostAppName() *before* it acquires that lock — a genuinely
// concurrent sibling test's own window churn could still be caught mid-flight
// by that unlocked read. Serial mode only orders tests within this file; it
// does not protect against another spec file running in a different worker.
test.describe.configure({ mode: 'serial' })

test.describe('auto-submit is gated on a genuinely remote peer', () => {
  test('loopback request carrying autoSubmit:true is STILL only staged', async ({ baseURL }) => {
    await withTmuxOrchestrator({ hasAttachedTab: true }, async (tmuxName) => {
      const res = await postStageSkill(`http://127.0.0.1:${portOf(baseURL!)}`, {
        stage: 'dev',
        autoSubmit: true,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ submitted: false })

      // The text must land — this is not a "nothing happened" assertion, it is
      // "the right thing happened and the Return was withheld".
      await expect.poll(() => readTmuxPaneContents(tmuxName)).toContain(STAGED_COMMAND)
      expect(await tmuxEnterWasPressed(tmuxName)).toBe(false)
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

    await withTmuxOrchestrator({ hasAttachedTab: false }, async (tmuxName) => {
      const res = await postStageSkill(`http://${lanAddress}:${portOf(baseURL!)}`, {
        stage: 'dev',
        autoSubmit: true,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ submitted: true })

      await expect.poll(() => tmuxEnterWasPressed(tmuxName)).toBe(true)
      expect(await readTmuxPaneContents(tmuxName)).toContain(STAGED_COMMAND)

      // Read after the write has demonstrably landed, so this cannot pass by
      // merely being quicker than an activate that was going to happen. Given
      // a short grace period rather than one point-in-time check: this reads
      // real, machine-wide OS focus, which unrelated activity on a real
      // developer desktop (another app, another already-open iTerm2 tab) can
      // also nudge — confirmed by an isolated repro of this exact
      // select+write-no-activate script independently catching a transient,
      // self-correcting focus change with nothing to do with this code path.
      // Nothing on the send path has a restore-frontmost step of its own
      // (unlike openScratchSession/openNewTabRunning), so a real `activate`
      // regression leaves iTerm2 frontmost with nothing to put it back — it
      // will not settle back to frontmostBefore within the grace window the
      // way incidental noise does.
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

    await withTmuxOrchestrator({ hasAttachedTab: true }, async (tmuxName) => {
      const res = await postStageSkill(`http://${lanAddress}:${portOf(baseURL!)}`, { stage: 'dev' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ submitted: false })

      await expect.poll(() => readTmuxPaneContents(tmuxName)).toContain(STAGED_COMMAND)
      expect(await tmuxEnterWasPressed(tmuxName)).toBe(false)
    })
  })
})
