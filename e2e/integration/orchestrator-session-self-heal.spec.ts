import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  closeScratchSession,
  closeScratchTab,
  createTmuxSession,
  createOrchestratorTmuxSession,
  readTmuxPaneContents,
  killTmuxSession,
  tmuxSessionIsLive,
  attachSessionToTmux,
  countSessions,
} from '../fixtures/itermSessions.js'
import { startCanonicalServer, stopCanonicalServer } from '../fixtures/canonicalServer.js'

// Covers the orchestrator's OWN tab dying while its tmux session keeps
// running (a remote client reattaching from Termius/a phone drops the Mac-side
// tab; a Mac restart; iTerm quitting; the tab closed by accident), now that
// every dispatch write goes into the tmux pane named by ORCHESTRATOR_TMUX and
// never through an iTerm2 tab:
//
//  1. POST /stage-skill/:slug — the card's "Start <stage>" CTA — writes into
//     the recorded tmux pane whatever state ORCHESTRATOR_SESSION is in, so a
//     dead tab pointer is no longer a dead end. After the write the server
//     re-records the tab really attached to that tmux session (correcting a
//     stale pointer) and, because a stage is only staged and unsent, brings
//     that tab forward — reattaching one when none is attached, since a
//     staged command nobody can find is useless.
//
//  2. Nothing is typed unless it is safe: no ORCHESTRATOR_TMUX on record, a
//     recorded session that is gone, or a pane sitting at a bare shell all
//     answer 503 and leave the pointer files and the pane untouched. There is
//     no keystroke fallback to a tab.
//
//  3. POST /orchestrator/tab asks for the orchestrator's tab back WITHOUT
//     dispatching anything. It reuses reattachOrFocus — the same function the
//     per-task "→ Terminal" button uses, one level up — and is unchanged by
//     the tmux writer.
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

// `origin` is '' for the shared (non-canonical) webServer's own baseURL, or
// a canonical test server's own absolute origin — see the first describe
// block's own comment on why it needs one.
async function openTask(page: Page, slug: string, origin = ''): Promise<void> {
  await page.goto(`${origin}/`)
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
// test asserting a write SUCCEEDS, since the writer refuses a pane that is
// not running claude with bracketed paste on.
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
//  - src/server.ts has no port fallback, and listenOnHosts (src/bindHosts.ts)
//    probes the port before binding loopback, so a conflict is a loud
//    EADDRINUSE crash rather than a dashboard flakily served by whichever
//    process the OS routed to first.
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
// Known-open, and deliberately not a reason to stay quarantined — it cannot
// reach the real pointer files:
//
//  - countSessions() counts every iTerm2 session on the machine, so the
//    "nothing new was opened" assertions below are racy while unrelated
//    sessions open and close tabs.
//
// If a run shows that failing, tag that individual test @pending
// with the defect named — the way orchestrator-pointer-race.spec.ts does —
// rather than re-quarantining the whole file.
//
// Both describe blocks below need a canonical instance of src/server.ts
// (same fixture TASKS_DIR, COCKPIT_DISPATCH_ENABLED=1) rather than the
// shared webServer (playwright.config.ts deliberately never sets
// COCKPIT_DISPATCH_ENABLED — see that config's own comment): "Start CTA"'s
// POST /stage-skill/:slug orchestrator-target branch, and "bring back the
// orchestrator tab"'s POST /orchestrator/tab, both go through the
// canonical-dispatch gate now. One dedicated server for the whole file
// (file-level `serial` above already orders every test here, so nothing is
// gained by giving each describe block its own).
let canonicalUrl: string
test.beforeAll(async () => {
  canonicalUrl = await startCanonicalServer()
})
test.afterAll(async () => {
  await stopCanonicalServer(canonicalUrl)
})

test.describe('Start CTA — writes into the orchestrator tmux pane and re-records its tab', () => {
  // This dashboard is inherently macOS+iTerm2-only, and every test in this
  // block is specifically about real osascript/tmux integration behavior
  // (which tab gets recorded, brought forward or reattached after a tmux
  // write) that a mock can't stand in for — that's the whole reason this file
  // exists (see its own header).
  test('recorded tab is dead and none is attached to ORCHESTRATOR_TMUX: stages in the pane, reattaches a tab, and rewrites the pointer', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await withOrchestratorTmuxSession(async () => {
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
        let healedSessionId = ''
        try {
          await openTask(page, 'dev-ready', canonicalUrl)
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

          // The command landed in the tmux pane itself, staged unsent.
          await expect
            .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
            .toContain('/pipelinely-dev dev-ready')

          // A staged command nobody can find is useless, so a tab was
          // reattached and the pointer file rewritten to it — the NEXT
          // dispatch finds it already recorded.
          await expect.poll(readPointer).not.toBe(DEAD_SESSION_ID)
          healedSessionId = await readPointer()
          expect(healedSessionId).not.toBe('')
        } finally {
          if (healedSessionId) await closeScratchTab(healedSessionId)
          await clearPointers()
        }
      })
    })
  })

  test('recorded tab is live and attached to ORCHESTRATOR_TMUX: stages in the pane, with no new tab and no pointer rewrite', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await withOrchestratorTmuxSession(async () => {
        const sessionId = await openScratchSession()
        try {
          await attachSessionToTmux(sessionId, TMUX_SESSION_NAME)
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
          const tabsBefore = await countSessions()
          try {
            await openTask(page, 'dev-ready', canonicalUrl)
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
              .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
              .toContain('/pipelinely-dev dev-ready')

            // Untouched — an already-correct pointer must not be rewritten,
            // and the attached tab is brought forward rather than replaced.
            expect(await readPointer()).toBe(sessionId)
            expect(await countSessions()).toBe(tabsBefore)
          } finally {
            await clearPointers()
          }
        } finally {
          await closeScratchSession(sessionId)
        }
      })
    })
  })

  test('the recorded id is stale but a live tab is attached to ORCHESTRATOR_TMUX: the pointer is corrected to that tab and no second one opens', async ({ page }) => {
    // The state a real "Start Dev did nothing" report turned out to be in:
    // the orchestrator's tab was on screen and correctly attached the whole
    // time, and only the recorded id was stale. Reattaching here would detach
    // that very tab (reattachTmuxSession attaches with -d) and open a
    // redundant one, so the pointer must land on the EXISTING tab.
    await withOrchestratorSessionLock(async () => {
      await withOrchestratorTmuxSession(async () => {
        const attachedSessionId = await openScratchSession()
        try {
          await attachSessionToTmux(attachedSessionId, TMUX_SESSION_NAME)
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
          const tabsBefore = await countSessions()
          try {
            await openTask(page, 'dev-ready', canonicalUrl)
            const cta = page.getByTestId('l2-cta')

            const [res] = await Promise.all([
              page.waitForResponse(
                (r) => r.url().includes('/stage-skill/dev-ready') && r.request().method() === 'POST',
              ),
              cta.click(),
            ])
            expect(res.status()).toBe(200)

            // The command landed in the pane...
            await expect
              .poll(() => readTmuxPaneContents(TMUX_SESSION_NAME))
              .toContain('/pipelinely-dev dev-ready')
            // ...the pointer now names the tab that was already there...
            await expect.poll(readPointer).toBe(attachedSessionId)
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

  test('the recorded tab is attached to ORCHESTRATOR_TMUX, but that tmux session is a bare shell: refuses before ever writing', async ({ page }) => {
    // The recorded session here is LIVE and really is a client of
    // ORCHESTRATOR_TMUX, so a writer that only checked tab attachment would
    // reproduce the reported symptom verbatim: the text lands straight in the
    // shell ("zsh: no such file or directory: /pipelinely-dev") and returns 200.
    await withOrchestratorSessionLock(async () => {
      await withLiveTmuxSession(async () => {
        const liveTab = await openScratchSession()
        try {
          await attachSessionToTmux(liveTab, TMUX_SESSION_NAME)
          await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
          await fs.writeFile(ORCHESTRATOR_SESSION_PATH, liveTab + '\n')
          try {
            const res = await page.request.post(`${canonicalUrl}/stage-skill/dev-ready`, { data: { stage: 'dev' } })
            expect(res.status()).toBe(503)
            expect((await res.json()).error).toMatch(/not running claude/i)

            // Pointer untouched, and — the whole point — nothing was typed
            // into the pane the tracked tab is showing.
            expect(await readPointer()).toBe(liveTab)
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
    // claude process (crash / /exit / quit), and the staged command was typed
    // into a bare zsh prompt — "zsh: no such file or directory: /pipelinely-dev".
    // withLiveTmuxSession (not withOrchestratorTmuxSession) is deliberate
    // here: this is the "tmux alive, pane is a plain shell" state itself.
    await withOrchestratorSessionLock(async () => {
      await withLiveTmuxSession(async () => {
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, TMUX_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
        const tabsBefore = await countSessions()
        try {
          const res = await page.request.post(`${canonicalUrl}/stage-skill/dev-ready`, { data: { stage: 'dev' } })
          expect(res.status()).toBe(503)
          const { error } = await res.json()
          // A distinct message from "not inside tmux" — this is a live tmux
          // session, just not one running the orchestrator.
          expect(error).toMatch(/not running claude/i)

          // Nothing was invented in place of the dead session: no tab was
          // reattached, and the stray shell never saw the staged command.
          expect(await readPointer()).toBe(DEAD_SESSION_ID)
          expect(await countSessions()).toBe(tabsBefore)
          expect(await readTmuxPaneContents(TMUX_SESSION_NAME)).not.toContain('/pipelinely-dev')
        } finally {
          await clearPointers()
        }
      })
    })
  })

  test('dead tab and no ORCHESTRATOR_TMUX on record: fails clearly, never a false success', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')
      try {
        await openTask(page, 'dev-ready', canonicalUrl)
        const cta = page.getByTestId('l2-cta')

        const res = await page.request.post(`${canonicalUrl}/stage-skill/dev-ready`, { data: { stage: 'dev' } })
        expect(res.status()).toBe(503)
        const { error } = await res.json()
        expect(error).toMatch(/not running inside tmux/i)

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
        const res = await page.request.post(`${canonicalUrl}/stage-skill/dev-ready`, { data: { stage: 'dev' } })
        expect(res.status()).toBe(503)
        expect((await res.json()).error).toMatch(/not running inside tmux/i)
        // Nothing was invented in place of the dead session.
        expect(await readPointer()).toBe(DEAD_SESSION_ID)
      } finally {
        await clearPointers()
      }
    })
  })

  test('nothing on record at all: the same "not inside tmux" 503, with no pointer invented', async ({ page }) => {
    // ORCHESTRATOR_SESSION no longer decides anything for a write, so its
    // absence has no message of its own — only the missing ORCHESTRATOR_TMUX
    // does.
    await withOrchestratorSessionLock(async () => {
      await clearPointers()
      const res = await page.request.post(`${canonicalUrl}/stage-skill/dev-ready`, { data: { stage: 'dev' } })
      expect(res.status()).toBe(503)
      expect((await res.json()).error).toMatch(/not running inside tmux/i)
      expect(await readPointer()).toBe('')
    })
  })
})

// Un-quarantined 2026-09-07 alongside the block above — see its comment.
// POST /orchestrator/tab can forcibly reattach or foreground the developer's
// real, live orchestrator session, so it is now canonical-dispatch-gated too
// (canonical-dispatch-gate CR fix) — every case below runs against the
// shared file's own canonicalUrl instance for the same reason "Start CTA"
// does, and the button itself renders disabled on a non-canonical instance
// (see ReadOnlyBanner.tsx / OrchestratorPill.tsx), so a direct page.request.post is
// used wherever a test needs to reach the route without going through a
// (now conditionally disabled) button click.
test.describe('"bring back the orchestrator tab" button', () => {
  test('recorded tab is live: focuses it, leaving the pointer alone', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        try {
          await page.goto(`${canonicalUrl}/`)
          const btn = page.getByTestId('orchestrator-tab-btn')
          await expect(btn).toBeVisible()
          await expect(btn).toBeEnabled()

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
          await page.goto(`${canonicalUrl}/`)
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
        await page.goto(`${canonicalUrl}/`)
        const btn = page.getByTestId('orchestrator-tab-btn')

        const res = await page.request.post(`${canonicalUrl}/orchestrator/tab`)
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
      const res = await page.request.post(`${canonicalUrl}/orchestrator/tab`)
      expect(res.status()).toBe(503)
      expect((await res.json()).error).toMatch(/orchestrator not running/i)
    })
  })

  test('a non-canonical instance is rejected with 403, the button renders disabled, and nothing is ever touched', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        try {
          await page.goto('/')
          const btn = page.getByTestId('orchestrator-tab-btn')
          await expect(btn).toBeVisible()
          await expect(btn).toBeDisabled()

          const res = await page.request.post('/orchestrator/tab')
          expect(res.status()).toBe(403)
          expect((await res.json()).error).toMatch(/not the canonical orchestrator dashboard/i)
          expect(await readPointer()).toBe(sessionId)
        } finally {
          await clearPointers()
        }
      } finally {
        await closeScratchSession(sessionId)
      }
    })
  })
})
