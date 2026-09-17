import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBacklogFileLock } from '../fixtures/backlogFile.js'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import { gotoBoardTab } from '../fixtures/boardTabs.js'
import { startCanonicalServer, stopCanonicalServer } from '../fixtures/canonicalServer.js'

// Covers the batch backlog selection UI: checkboxes on backlog cards, and a
// "Run selected (N)" toolbar that appears once ≥1 item is checked.
//
// Design history: "Run selected" originally dispatched every checked item
// independently — one auto-submitted POST /backlog/dispatch call per item,
// sequentially. On 2026-09-06 the wave-batch button's identical shape
// auto-submitted two real dispatches into the developer's live, attended
// orchestrator session with zero confirmation — the same incident this
// button was one click away from. The developer reversed the trade-off:
// "Run selected" now stages ONE combined, unsent command for the whole
// selection through the shared POST /batch-dispatch route instead — see
// tech-design.md's "Decision reversed again" section. The mechanism proof
// (one combined command landing unsent in a real session) now lives in
// e2e/integration/batch-dispatch-staging.spec.ts, which covers both batch
// surfaces; what remains here beyond the selection UI itself is
// anti-double-dispatch, mirroring wave-batch-run.spec.ts's own block for the
// identical concern on the wave button.
//
// The fixture BACKLOG.md (e2e/fixtures/tasks/BACKLOG.md) holds exactly
// four not-done items, in file order — "First/Second/Third batch-dispatch
// fixture item" plus a fourth, deliberately untagged item — read by index
// below via nth(). Every test here therefore
// holds withBacklogFileLock: backlog-shelve-resume.spec.ts appends and
// removes entries in that same file, and under fullyParallel workers an
// append landing mid-run would shift these indices and counts out from
// under the assertions. The anti-double-dispatch tests below also hold
// withOrchestratorSessionLock, same as wave-batch-run.spec.ts's own block —
// per backlogFile.ts's ordering rule, the backlog lock is always acquired
// first.

// M1 removed the Backlog/In Progress/Done tab bar; cockpit-ui-reconcile put
// it back, so the backlog is a panel that has to be selected again. The
// click itself lives in one place (e2e/fixtures/boardTabs.ts), shared with
// board-redesign.spec.ts.
async function goToBacklog(page: import('@playwright/test').Page, origin = ''): Promise<void> {
  await gotoBoardTab(page, 'backlog', origin)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_SESSION_PATH = path.join(__dirname, '..', 'fixtures', 'tasks', 'ORCHESTRATOR_SESSION')

function batchDispatchRequests(page: Page): unknown[] {
  const bodies: unknown[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/batch-dispatch')) bodies.push(req.postDataJSON())
  })
  return bodies
}

test.describe('backlog selection UI — no orchestrator interaction', () => {
  test('the "Run selected" bar is hidden until at least one item is checked', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await goToBacklog(page)
      await expect(page.locator('[data-testid="backlog-batch-bar"]')).toBeHidden()
    })
  })

  test('checking/unchecking items updates the count and shows/hides the bar', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await goToBacklog(page)
      const bar = page.locator('[data-testid="backlog-batch-bar"]')
      const runBtn = page.locator('[data-testid="backlog-run-selected-btn"]')
      const checkboxes = page.locator('[data-testid="backlog-select-checkbox"]')
      await expect(checkboxes).toHaveCount(4)

      await checkboxes.nth(0).check()
      await expect(bar).toBeVisible()
      await expect(runBtn).toContainText('Run selected (1)')

      await checkboxes.nth(1).check()
      await expect(runBtn).toContainText('Run selected (2)')

      await checkboxes.nth(2).check()
      await expect(runBtn).toContainText('Run selected (3)')

      await checkboxes.nth(3).check()
      await expect(runBtn).toContainText('Run selected (4)')

      await checkboxes.nth(1).uncheck()
      await expect(runBtn).toContainText('Run selected (3)')

      await checkboxes.nth(0).uncheck()
      await checkboxes.nth(2).uncheck()
      await checkboxes.nth(3).uncheck()
      await expect(bar).toBeHidden()
    })
  })
})

// Same concern as wave-batch-run.spec.ts's own 'anti-double-dispatch'
// block, for the backlog "Run selected" button instead of the wave button:
// the button must disable for the duration of its one in-flight
// /batch-dispatch request, and a fast double-click must not fire it twice.
//
// "Run selected" is one of canonical-dispatch-gate's two proactively-
// disabled CTAs (see index.html's renderBacklog/updateBacklogBatchBar), so —
// same reasoning as orchestrator-session-self-heal.spec.ts's own dedicated
// server — these tests need a canonical instance to see it enabled at all,
// rather than the shared (deliberately non-canonical) webServer every other
// describe block in this file uses.
test.describe('backlog batch — anti-double-dispatch', () => {
  let canonicalUrl: string
  test.beforeAll(async () => {
    canonicalUrl = await startCanonicalServer()
  })
  test.afterAll(async () => {
    await stopCanonicalServer(canonicalUrl)
  })

  test('the "Run selected" button disables for the duration of the in-flight batch request', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withOrchestratorSessionLock(async () => {
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
        await goToBacklog(page, canonicalUrl)
        const checkboxes = page.locator('[data-testid="backlog-select-checkbox"]')
        await checkboxes.nth(0).check()
        const runBtn = page.locator('[data-testid="backlog-run-selected-btn"]')

        let releaseRequest: () => void
        const gate = new Promise<void>((resolve) => { releaseRequest = resolve })
        let intercepted = 0
        await page.route('**/batch-dispatch', async (route) => {
          intercepted += 1
          await gate
          await route.continue()
        })

        await runBtn.click()
        await expect(runBtn).toBeDisabled()

        // Proving absence, not a value: while the one in-flight request is
        // held open, a second must never be issued — which is why this
        // waits a fixed beat rather than polling for a value that would
        // never come.
        await page.waitForTimeout(1000)
        expect(intercepted).toBe(1)

        releaseRequest!()
        await expect(runBtn).toBeEnabled({ timeout: 10_000 })
        expect(intercepted).toBe(1)
      })
    })
  })

  // A batch click is the most expensive button on the page — a double-fire
  // would stage the same selection's items twice.
  test('a rapid double-click only fires a single /batch-dispatch request', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withOrchestratorSessionLock(async () => {
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
        await goToBacklog(page, canonicalUrl)
        const checkboxes = page.locator('[data-testid="backlog-select-checkbox"]')
        await checkboxes.nth(0).check()
        const requests = batchDispatchRequests(page)

        // Two native .click() calls in one JS tick, bypassing Playwright's
        // actionability wait (which would patiently wait for the button to
        // re-enable and defeat the point) — what a genuinely fast
        // double-click looks like from the button's own perspective.
        await page.evaluate(() => {
          const btn = document.querySelector(
            '[data-testid="backlog-run-selected-btn"]',
          ) as HTMLButtonElement
          btn.click()
          btn.click()
        })

        await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0)
        // Give a wrongly-fired second request time to show up before
        // asserting its absence.
        await page.waitForTimeout(500)
        expect(requests.length).toBe(1)
      })
    })
  })
})
