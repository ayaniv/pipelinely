import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  adoptScratchSession,
  closeScratchSession,
  closeScratchTab,
  readSessionContents,
  createTmuxSession,
  createOrchestratorTmuxSession,
  readTmuxPaneContents,
  killTmuxSession,
  tmuxSessionIsLive,
  attachSessionToTmux,
  countSessions,
} from '../fixtures/itermSessions.js'

// Covers two related gaps, both about the orchestrator's OWN tab dying while
// its tmux session keeps running (a remote client reattaching from
// Termius/a phone drops the Mac-side tab; a Mac restart; iTerm quitting; the
// tab closed by accident):
//
//  1. POST /stage-skill/:slug — the card's "Start <stage>" CTA — read
//     ORCHESTRATOR_SESSION raw and called stageInSession with no liveness
//     check and no reattach, so a dead pointer produced a bare 503 with no
//     recovery path. This is the failure actually hit in production. The
//     sibling routes (/backlog/dispatch, /focus/:slug's fallback) already
//     self-healed through pasteToOrchestrator; this route was the one that
//     didn't, as pasteToOrchestrator's own comment noted. It now shares that
//     helper, generalized over the writer (stage-unsent vs paste-and-send).
//
//  2. The heal must not be disruptive. Found live: the recorded id was
//     stale while the orchestrator's tab was on screen and correctly
//     attached the whole time. Reattaching blindly there would detach that
//     very tab (reattachTmuxSession uses `-d`) and open a redundant one, so
//     an already-attached tab is adopted before any reattach is considered.
//
//  3. There was no way to ask for the orchestrator's tab back WITHOUT
//     dispatching something. POST /orchestrator/tab is that affordance,
//     reusing reattachOrFocus — the same function the per-task "→ Terminal"
//     button already uses, one level up.
//
//  4. Every liveness check above — including gap 2's adopt step — only
//     confirms a tty is attached to ORCHESTRATOR_TMUX, never that the pane
//     is actually running claude. Found live via the wave-batch "Run wave"
//     button: it typed a raw /pipelinely-dev command into a bare zsh shell
//     ("zsh: no such file or directory: /pipelinely-dev") because the tmux
//     session had outlived the claude process that used to be in it.
//     writeToOrchestrator now checks tmuxSessionRunningOrchestrator before
//     attempting either adopt or reattach, and refuses — same as "no
//     session" — rather than typing into whatever is actually there.
//
// Real osascript/tmux throughout (no route mocking) — see
// fixtures/itermSessions.ts for why. The scratch tmux session name is
// suffixed with the worker's pid so two workers can never collide on it.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')
const ORCHESTRATOR_TMUX_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_TMUX')

const DEAD_SESSION_ID = 'dead-orchestrator-session-not-real'
const TMUX_SESSION_NAME = `cockpit-e2e-selfheal-${process.pid}`

// Serial for the same reason as resume-dead-session-fallback.spec.ts: every
// test here writes the same two shared pointer files. The lock inside each
// test is what protects it from OTHER spec files running in parallel
// workers; serial mode only orders tests within this file.
test.describe.configure({ mode: 'serial' })

async function readPointer(): Promise<string> {
  return (await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8').catch(() => '')).trim()
}

async function clearPointers(): Promise<void> {
  await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
  await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
}

async function openTask(page: Page, slug: string): Promise<void> {
  await page.goto('/')
  await page.locator(`.card[data-slug="${slug}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}

// Stands up a real, live tmux session for the duration of `fn`, guaranteeing
// it is killed afterwards even when the test fails mid-way.
async function withLiveTmuxSession(fn: () => Promise<void>): Promise<void> {
  await createTmuxSession(TMUX_SESSION_NAME)
  try {
    expect(await tmuxSessionIsLive(TMUX_SESSION_NAME)).toBe(true)
    await fn()
  } finally {
    await killTmuxSession(TMUX_SESSION_NAME)
  }
}

// Same as withLiveTmuxSession, but the pane is genuinely running claude (via
// createOrchestratorTmuxSession) rather than a bare shell — required for any
// test asserting a heal SUCCEEDS, now that tmuxSessionRunningOrchestrator
// gates reattach/adopt on the pane actually being the orchestrator.
async function withOrchestratorTmuxSession(fn: () => Promise<void>): Promise<void> {
  await createOrchestratorTmuxSession(TMUX_SESSION_NAME)
  try {
    expect(await tmuxSessionIsLive(TMUX_SESSION_NAME)).toBe(true)
    await fn()
  } finally {
    await killTmuxSession(TMUX_SESSION_NAME)
  }
}

// UN-QUARANTINED 2026-09-07. Quarantined 2026-09-01 because this suite's
// ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX isolation depends on the running
// server actually being scoped to this file's own fixture TASKS_DIR — and it
// wasn't: a stray, already-running dev-server instance on the same port
// (started outside Playwright's own webServer, with whatever TASKS_DIR *it*
// happened to have, which defaulted to the real one) was adopted as-is via
// `reuseExistingServer`. This suite then overwrote the developer's real, live
// ORCHESTRATOR_SESSION pointer mid-run, observed live during
// `canonical-dispatch-gate`'s own dev loop.
//
// That vector is closed, by five independent mechanisms:
//
//  - playwright.config.ts hardcodes `reuseExistingServer: false` (c19253b,
//    PR #60). Playwright throws before running a single test when the port
//    already answers, rather than adopting a stranger.
//  - That config's `webServer.env` pins TASKS_DIR/REPOS_DIR/WORKTREES_DIR to
//    e2e/fixtures/*, and Playwright merges `options.env` last, so an
//    inherited env var cannot override it.
//  - src/server.ts binds an explicit '0.0.0.0' with no port fallback, so a
//    conflict is a loud EADDRINUSE crash rather than a dashboard flakily
//    served by whichever process the OS routed to first.
//  - src/tasksDir.ts's resolveTasksDir throws when a worktree starts a server
//    with no explicit TASKS_DIR — draining the reservoir of stray servers
//    silently armed on the real tasks dir that the incident drew from.
//  - This file lives under e2e/integration/, so it runs only through
//    `npm run test:e2e:integration`'s interactive consent gate, and both
//    fixtures it imports call assertIsolatedEnvironment() at module scope
//    (c5523ca, PR #65) — whose TASKS_DIR check refuses to load this file at
//    all if it is ever aimed at real space. That one fails closed.
//
// The first two are pinned by findWebServerIsolationViolations
// (src/e2eIsolation.ts), so flipping either back fails `npx vitest run`
// instead of silently re-arming the incident with every test still green.
//
// The original unblock condition — canonical-dispatch-gate's
// canonical-instance gate — is NOT what closed this, and never landed: PR #57
// is still open. Don't wait on it. It would not have helped anyway: a stray
// server that IS the developer's real canonical instance passes a canonical
// check while still pointing at the real TASKS_DIR.
//
// Known-open, and deliberately not a reason to stay quarantined — neither can
// reach the real pointer files:
//
//  - src/focusTab.ts misdelivers synthetic keystrokes when the writing
//    process differs from whatever opened the target windows (tasks/BACKLOG.md
//    2026-09-06; orchestrator-pointer-race.spec.ts carries @pending tags for
//    it). Bounded here: /stage-skill writes through stageInSession, which is
//    `submit: false`, so a misdelivery leaves unsent text at some other tab's
//    prompt and cannot fire a command.
//  - countSessions() counts every iTerm2 session on the machine, so the
//    "nothing new was opened" assertions below are racy while unrelated
//    sessions open and close tabs.
//
// If a run shows either of those failing, tag that individual test @pending
// with the defect named — the way orchestrator-pointer-race.spec.ts does —
// rather than re-quarantining the whole file.
test.describe('Start CTA — self-heals a dead ORCHESTRATOR_SESSION', () => {
  test('recorded tab is dead but ORCHESTRATOR_TMUX is alive: reattaches, rewrites the pointer, and stages the command anyway', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await withOrchestratorTmuxSession(async () => {
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
        let healedSessionId = ''
        try {
          await openTask(page, 'dev-ready')
          const cta = page.getByTestId('l2-cta')
          await expect(cta).toBeEnabled()

          const [res] = await Promise.all([
            page.waitForResponse(
              (r) => r.url().includes('/stage-skill/dev-ready') && r.request().method() === 'POST',
            ),
            cta.click(),
          ])

          // The whole point: a dead pointer no longer means a dead end.
          expect(res.status()).toBe(200)
          await expect(cta).toHaveClass(/btn-ok/)
          await expect(cta).not.toHaveClass(/btn-err/)

          // The pointer file was rewritten to the newly-opened tab, so the
          // NEXT dispatch hits the fast path instead of healing again.
          await expect.poll(readPointer).not.toBe(DEAD_SESSION_ID)
          healedSessionId = await readPointer()
          expect(healedSessionId).not.toBe('')
          // The server opened this tab (reattachTmuxSession), not this
          // test's own openScratchSession — adopt it so the finally block
          // below can actually close it instead of leaking a real window.
          adoptScratchSession(healedSessionId)

          // And the command genuinely landed in that reattached tab —
          // staged unsent, which is what stageInSession promises.
          await expect
            .poll(() => readSessionContents(healedSessionId))
            .toContain('/pipelinely-dev dev-ready')
        } finally {
          if (healedSessionId) await closeScratchTab(healedSessionId)
          await clearPointers()
        }
      })
    })
  })

  test('recorded tab is live: stages directly, with no reattach and no pointer rewrite', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await withLiveTmuxSession(async () => {
          // ORCHESTRATOR_TMUX deliberately points at a genuinely live tmux
          // session here: if the fast path regressed into always healing,
          // the pointer assertion below would catch it rather than the test
          // passing because there was nothing to reattach to.
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
          try {
            await openTask(page, 'dev-ready')
            const cta = page.getByTestId('l2-cta')

            const [res] = await Promise.all([
              page.waitForResponse(
                (r) => r.url().includes('/stage-skill/dev-ready') && r.request().method() === 'POST',
              ),
              cta.click(),
            ])
            expect(res.status()).toBe(200)
            await expect(cta).toHaveClass(/btn-ok/)

            await expect
              .poll(() => readSessionContents(sessionId))
              .toContain('/pipelinely-dev dev-ready')

            // Untouched — the live path must not open a tab or rewrite this.
            expect(await readPointer()).toBe(sessionId)
          } finally {
            await clearPointers()
          }
        })
      } finally {
        await closeScratchSession(sessionId)
      }
    })
  })

  test('a live tab is already attached to ORCHESTRATOR_TMUX: adopts that tab instead of opening a second one', async ({ page }) => {
    // The state a real "Start Dev did nothing" report turned out to be in:
    // the orchestrator's tab was on screen and correctly attached the whole
    // time, and only the recorded id was stale. Reattaching here would
    // detach that very tab (reattachTmuxSession attaches with -d) and open a
    // redundant one — a heal that disrupts a working setup. So the pointer
    // must land on the EXISTING tab, and no new tab may appear.
    await withOrchestratorSessionLock(async () => {
      await withOrchestratorTmuxSession(async () => {
        const attachedSessionId = await openScratchSession()
        try {
          await attachSessionToTmux(attachedSessionId, TMUX_SESSION_NAME)
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
          const tabsBefore = await countSessions()
          try {
            await openTask(page, 'dev-ready')
            const cta = page.getByTestId('l2-cta')

            const [res] = await Promise.all([
              page.waitForResponse(
                (r) => r.url().includes('/stage-skill/dev-ready') && r.request().method() === 'POST',
              ),
              cta.click(),
            ])
            expect(res.status()).toBe(200)

            // Adopted, not reattached: the pointer names the tab that was
            // already there...
            await expect.poll(readPointer).toBe(attachedSessionId)
            // ...the command landed in it...
            await expect
              .poll(() => readSessionContents(attachedSessionId))
              .toContain('/pipelinely-dev dev-ready')
            // ...and nothing new was opened.
            expect(await countSessions()).toBe(tabsBefore)
          } finally {
            await clearPointers()
          }
        } finally {
          await closeScratchSession(attachedSessionId)
        }
      })
    })
  })

  test('the recorded tab is genuinely attached to ORCHESTRATOR_TMUX, but that tmux session is a bare shell: refuses before ever writing', async ({ page }) => {
    // Distinguishes "the gate is on the heal" from "the gate is on every
    // write". The recorded session here is LIVE and really is a client of
    // ORCHESTRATOR_TMUX, so without the step-0 gate ahead of the fast path
    // this reproduces the reported symptom verbatim: the fast-path write
    // lands straight into the shell and returns 200
    // ("zsh: no such file or directory: /pipelinely-dev").
    await withOrchestratorSessionLock(async () => {
      await withLiveTmuxSession(async () => {
        const liveTab = await openScratchSession()
        try {
          await attachSessionToTmux(liveTab, TMUX_SESSION_NAME)
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, liveTab + '\n')
          try {
            const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
            expect(res.status()).toBe(503)
            expect((await res.json()).error).toMatch(/not running claude/i)

            // Pointer untouched, and — the whole point — nothing was typed
            // into either the tracked tab or the raw tmux pane.
            expect(await readPointer()).toBe(liveTab)
            await expect(readSessionContents(liveTab)).resolves.not.toContain('/pipelinely-dev')
            expect(await readTmuxPaneContents(TMUX_SESSION_NAME)).not.toContain('/pipelinely-dev')
          } finally {
            await clearPointers()
          }
        } finally {
          await closeScratchSession(liveTab)
        }
      })
    })
  })

  test('ORCHESTRATOR_TMUX is alive but its pane is a bare shell, not claude: fails clearly, never types into it', async ({ page }) => {
    // The wave-batch "Run wave" bug: the tmux session had outlived the
    // claude process (crash / /exit / quit), so every prior liveness check
    // (tty-attachment only) reattached anyway and typed the staged command
    // into a bare zsh prompt — "zsh: no such file or directory: /pipelinely-dev".
    // withLiveTmuxSession (not withOrchestratorTmuxSession) is deliberate
    // here: this is the "tmux alive, pane is a plain shell" state itself.
    await withOrchestratorSessionLock(async () => {
      await withLiveTmuxSession(async () => {
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
        const tabsBefore = await countSessions()
        try {
          const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
          expect(res.status()).toBe(503)
          const { error } = await res.json()
          // A distinct message from the generic "tab not found" — this is a
          // live tmux session, just not one running the orchestrator.
          expect(error).toMatch(/not running claude/i)

          // Nothing was invented in place of the dead session, and — the
          // whole point — no reattach was even attempted: no new tab opened,
          // and the stray shell never saw the staged command.
          expect(await readPointer()).toBe(DEAD_SESSION_ID)
          expect(await countSessions()).toBe(tabsBefore)
          expect(await readTmuxPaneContents(TMUX_SESSION_NAME)).not.toContain('/pipelinely-dev')
        } finally {
          await clearPointers()
        }
      })
    })
  })

  test('a live tab is already attached to ORCHESTRATOR_TMUX, but its pane is a bare shell: does not adopt it either', async ({ page }) => {
    // Same bug, via the adopt path instead of the reattach path — the
    // process check has to gate both, since adopt is the cheaper heal step
    // that runs first (see Change 3's ordering) and would otherwise type
    // into the stray shell before reattach is even considered.
    await withOrchestratorSessionLock(async () => {
      await withLiveTmuxSession(async () => {
        const attachedSessionId = await openScratchSession()
        try {
          await attachSessionToTmux(attachedSessionId, TMUX_SESSION_NAME)
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
          const tabsBefore = await countSessions()
          try {
            const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
            expect(res.status()).toBe(503)
            expect((await res.json()).error).toMatch(/not running claude/i)

            // Not adopted: the pointer is untouched, the already-attached
            // tab never received the command, and nothing new opened.
            expect(await readPointer()).toBe(DEAD_SESSION_ID)
            await expect(readSessionContents(attachedSessionId)).resolves.not.toContain('/pipelinely-dev')
            expect(await countSessions()).toBe(tabsBefore)
          } finally {
            await clearPointers()
          }
        } finally {
          await closeScratchSession(attachedSessionId)
        }
      })
    })
  })

  test('dead tab and no ORCHESTRATOR_TMUX on record: fails clearly, never a false success', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
      try {
        await openTask(page, 'dev-ready')
        const cta = page.getByTestId('l2-cta')

        const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
        expect(res.status()).toBe(503)
        const { error } = await res.json()
        expect(error).toMatch(/orchestrator tab not found/i)

        await cta.click()
        await expect(cta).toHaveClass(/btn-err/)
        await expect(cta).not.toHaveClass(/btn-ok/)
        // The CTA surfaces the server's own computed message and re-enables,
        // matching the existing no-ORCHESTRATOR_SESSION path in
        // pipeline-stage-cta.spec.ts rather than inventing a second style.
        await expect(cta).toHaveText(error)
        await expect(cta).toBeEnabled()
      } finally {
        await clearPointers()
      }
    })
  })

  test('dead tab and ORCHESTRATOR_TMUX naming a session that is gone too: same clear 503, no guessing', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      const goneSession = `${TMUX_SESSION_NAME}-gone`
      // Assert the premise rather than assuming it — a stray session by this
      // name would otherwise turn this into a silent false pass.
      expect(await tmuxSessionIsLive(goneSession)).toBe(false)
      await fs.writeFile(ORCHESTRATOR_TMUX_PATH, goneSession + '\n')
      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
      try {
        const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
        expect(res.status()).toBe(503)
        expect((await res.json()).error).toMatch(/orchestrator tab not found/i)
        // Nothing was invented in place of the dead session.
        expect(await readPointer()).toBe(DEAD_SESSION_ID)
      } finally {
        await clearPointers()
      }
    })
  })

  test('no ORCHESTRATOR_SESSION at all: still the distinct "not running" message, not the dead-tab one', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
      expect(res.status()).toBe(503)
      expect((await res.json()).error).toMatch(/orchestrator not running/i)
    })
  })
})

// Un-quarantined 2026-09-07 alongside the block above — see its comment.
test.describe('"bring back the orchestrator tab" button', () => {
  test('recorded tab is live: focuses it, leaving the pointer alone', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        try {
          await page.goto('/')
          const btn = page.getByTestId('orchestrator-tab-btn')
          await expect(btn).toBeVisible()

          const [res] = await Promise.all([
            page.waitForResponse(
              (r) => r.url().includes('/orchestrator/tab') && r.request().method() === 'POST',
            ),
            btn.click(),
          ])
          expect(res.status()).toBe(200)
          await expect(btn).toHaveClass(/btn-ok/)
          expect(await readPointer()).toBe(sessionId)
        } finally {
          await clearPointers()
        }
      } finally {
        await closeScratchSession(sessionId)
      }
    })
  })

  test('recorded tab is dead but the tmux session survived: opens a new tab attached to it and re-records the id', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await withLiveTmuxSession(async () => {
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
        let healedSessionId = ''
        try {
          await page.goto('/')
          const btn = page.getByTestId('orchestrator-tab-btn')

          const [res] = await Promise.all([
            page.waitForResponse(
              (r) => r.url().includes('/orchestrator/tab') && r.request().method() === 'POST',
            ),
            btn.click(),
          ])
          expect(res.status()).toBe(200)
          await expect(btn).toHaveClass(/btn-ok/)

          await expect.poll(readPointer).not.toBe(DEAD_SESSION_ID)
          healedSessionId = await readPointer()
          expect(healedSessionId).not.toBe('')
          // Same reasoning as the test above: the server opened this tab,
          // so it must be adopted before the finally block can close it.
          adoptScratchSession(healedSessionId)
        } finally {
          if (healedSessionId) await closeScratchTab(healedSessionId)
          await clearPointers()
        }
      })
    })
  })

  test('tab and tmux session both gone: 503 with its own message, and the button shows the failure', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
      try {
        await page.goto('/')
        const btn = page.getByTestId('orchestrator-tab-btn')

        const res = await page.request.post('/orchestrator/tab')
        expect(res.status()).toBe(503)
        expect((await res.json()).error).toMatch(/orchestrator/i)

        await btn.click()
        await expect(btn).toHaveClass(/btn-err/)
        await expect(btn).not.toHaveClass(/btn-ok/)
      } finally {
        await clearPointers()
      }
    })
  })

  test('nothing on record at all: 503 rather than opening a stray tab', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      const res = await page.request.post('/orchestrator/tab')
      expect(res.status()).toBe(503)
      expect((await res.json()).error).toMatch(/orchestrator not running/i)
    })
  })
})
