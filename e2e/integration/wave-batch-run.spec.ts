import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'

// Covers the wave-level batch button: one button on each wave header that
// stages ONE combined, unsent command for every currently queued-and-
// unblocked milestone in that wave — instead of requiring N separate
// drill-down "Start Dev" clicks, or (the incident this task fixes)
// auto-submitting N real dispatches with zero confirmation.
//
// Design history: this batch button originally auto-submitted N independent
// `/pipelinely-dev <slug>` pastes, one per milestone (recorded in
// compare-batch-dispatch-tasks/TASK.md), so both batch features would behave
// identically to batch-backlog-dispatch's own per-item auto-submit loop. On
// 2026-09-06 that auto-submit fired two real dispatches into the developer's
// live, attended orchestrator session with zero confirmation. The developer
// reversed the trade-off: both batch features now stage ONE combined,
// unsent command through the shared POST /batch-dispatch route instead — see
// tech-design.md's "Decision reversed again" section.
//
// The orchestrator-interaction tests below now cover POST /batch-dispatch,
// not the deleted POST /pipelinely-dev/:slug — see
// e2e/integration/batch-dispatch-staging.spec.ts for the full mechanism
// proof (one combined command landing unsent in a real session). What
// remains here is specific to the wave button itself: eligibility/
// visibility (unaffected by the staging change) and anti-double-dispatch
// (now guarding the one in-flight /batch-dispatch request, not N sequential
// /pipelinely-dev/:slug ones).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

const PARENT = 'wave-batch-parent'

// Opens the parent's Dev tab, which is where the wave sections live.
async function openWaves(page: Page, slug = PARENT) {
  await page.goto('/')
  await page.locator(`.card[data-slug="${slug}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
  await page.getByTestId('l1-tab-dev').click()
  await expect(page.getByTestId('wave').first()).toBeVisible()
}

function waveBatchBtn(page: Page, wave: number) {
  return page.locator(`[data-testid="wave"][data-wave="${wave}"] [data-testid="wave-batch-btn"]`)
}

function batchDispatchRequests(page: Page): unknown[] {
  const bodies: unknown[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/batch-dispatch')) bodies.push(req.postDataJSON())
  })
  return bodies
}

test.describe('wave batch button — eligibility and visibility', () => {
  // The wave-batch-parent fixture's wave 2 holds M1 and M2, both `needs: M0`,
  // with M0 already merged — the exact "two queued, unblocked milestones in
  // one wave" shape this feature exists for.
  test('a wave with two queued, unblocked milestones shows an enabled batch button counting both', async ({ page }) => {
    await openWaves(page)
    const btn = waveBatchBtn(page, 2)
    await expect(btn).toBeVisible()
    await expect(btn).toBeEnabled()
    await expect(
      page.locator('[data-testid="wave"][data-wave="2"] [data-testid="wave-batch-count"]'),
    ).toHaveText('2')
  })

  // Wave 1 holds only M0, already merged. Nothing queued means nothing to
  // batch — the button stays visible (so the wave header's layout doesn't
  // shift as milestones land) but disabled, matching stageCta's own
  // established disabled-with-a-title convention rather than disappearing.
  test('a fully merged wave shows the batch button disabled, counting zero', async ({ page }) => {
    await openWaves(page)
    const btn = waveBatchBtn(page, 1)
    await expect(btn).toBeVisible()
    await expect(btn).toBeDisabled()
    await expect(
      page.locator('[data-testid="wave"][data-wave="1"] [data-testid="wave-batch-count"]'),
    ).toHaveText('0')
  })

  // Wave 3 holds M3, which is queued but `needs: M1, M2` — neither merged.
  // Queued alone is not enough; the button must apply the same
  // isMilestoneReadyForDev gate each milestone's own CTA applies.
  test('a wave whose milestones are queued but still blocked shows the batch button disabled', async ({ page }) => {
    await openWaves(page)
    const btn = waveBatchBtn(page, 3)
    await expect(btn).toBeVisible()
    await expect(btn).toBeDisabled()
    await expect(
      page.locator('[data-testid="wave"][data-wave="3"] [data-testid="wave-batch-count"]'),
    ).toHaveText('0')
  })

  // A flat task's detail view has no Dev-tab wave sections at all, so it
  // must render no batch button — not a zero-count one.
  test('a flat task renders no wave sections and no batch button', async ({ page }) => {
    await page.goto('/')
    await page.locator('.card[data-slug="dev-ready"] .card-title').click()
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.getByTestId('wave')).toHaveCount(0)
    await expect(page.getByTestId('wave-batch-btn')).toHaveCount(0)
  })
})

// The mechanism proof — one combined command landing unsent in a real
// session — now lives in e2e/integration/batch-dispatch-staging.spec.ts,
// which covers both batch surfaces through the shared POST /batch-dispatch
// route. What's specific to the wave button itself, and stays here, is
// anti-double-dispatch: the button must disable for the duration of its one
// in-flight request and a fast double-click must not fire it twice.
test.describe('wave batch — anti-double-dispatch', () => {
  test('the wave button disables for the duration of the in-flight batch request', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await openWaves(page)
      const btn = waveBatchBtn(page, 2)

      let releaseRequest: () => void
      const gate = new Promise<void>((resolve) => { releaseRequest = resolve })
      let intercepted = 0
      await page.route('**/batch-dispatch', async (route) => {
        intercepted += 1
        await gate
        await route.continue()
      })

      await btn.click()
      await expect(btn).toBeDisabled()

      // Proving absence, not a value: while the one in-flight request is
      // held open, a second must never be issued — which is why this waits
      // a fixed beat rather than polling for a value that would never come.
      await page.waitForTimeout(1000)
      expect(intercepted).toBe(1)

      releaseRequest!()
      await expect(btn).toBeEnabled({ timeout: 10_000 })
      expect(intercepted).toBe(1)
    })
  })

  // A batch click is the most expensive button on the page — a double-fire
  // would stage the same wave's milestones twice.
  test('a rapid double-click only fires a single /batch-dispatch request', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await openWaves(page)
      const requests = batchDispatchRequests(page)

      // Two native .click() calls in one JS tick, bypassing Playwright's
      // actionability wait (which would patiently wait for the button to
      // re-enable and defeat the point) — what a genuinely fast
      // double-click looks like from the button's own perspective.
      await page.evaluate(() => {
        const btn = document.querySelector(
          '[data-testid="wave"][data-wave="2"] [data-testid="wave-batch-btn"]',
        ) as HTMLButtonElement
        btn.click()
        btn.click()
      })

      await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0)
      // Give a wrongly-fired second request time to show up before asserting
      // its absence.
      await page.waitForTimeout(500)
      expect(requests.length).toBe(1)
    })
  })
})
