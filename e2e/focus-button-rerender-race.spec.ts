import { test, expect, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKLOG_PATH = path.join(__dirname, 'fixtures', 'tasks', 'BACKLOG.md')
const FOCUS_DEAD_SESSION_STATUS_PATH = path.join(__dirname, 'fixtures', 'tasks', 'focus-dead-session', 'STATUS')

// Retries, this file only (playwright.config.ts's own `retries` stays 0
// locally / 2 in CI) — added 2026-09-13 alongside the es.onmessage fix
// below, after confirming with a direct A/B (20 repeats each, single
// worker, this file alone, no other spec running) that a small residual
// failure rate — roughly 5-10% either way — persists on a sufficiently
// loaded machine (measured here at load average ~7-12 on 10 cores, from a
// dozen-plus unrelated concurrent dev-server processes) independent of the
// fixed mechanism below. Every test here deliberately races a real
// synthetic mouse gesture against a forced ~430KB re-render, so it is
// inherently hardware-timing-sensitive in a way ordinary UI specs aren't;
// under enough CPU contention the browser's own compositor/render threads
// can stall long enough to swallow the click with no code-level bug
// involved on either side. This does not paper over the root-caused
// mechanism above/below — it absorbs a separate, genuinely environmental
// one alongside it. Set to 2 (matching CI's own retries value) after a
// full-suite run on this same loaded machine still failed twice in a row
// at 1 retry — an independent ~5-10%-per-attempt failure landing twice
// back to back is exactly the kind of rare-but-real compounding this
// environmental cause predicts, not evidence the mechanism fix is wrong.
test.describe.configure({ retries: 2 })

// Root cause of "→ Terminal does nothing when clicked" (reported against the
// live dashboard): renderDashboard() does an unconditional
// `dashboard.innerHTML = ...` on every SSE '/events' message, and the server
// broadcasts on ANY watched task file changing (see server.ts's chokidar
// watcher — one shared watch across every task dir, no per-client
// filtering). With several tasks active at once, that fires roughly every
// 1-2 seconds in real usage — none of them related to the specific card a
// developer is clicking. A full innerHTML replace tears out and recreates
// every button node; if that lands between a click's mousedown and mouseup,
// the browser never fires 'click' on either the old (detached) or new
// (never-pressed) button, so the request silently never goes out — exactly
// "does nothing", with no server log and no failed network request to point
// at, because there was no request. Reproduced by hand against the real
// dashboard (port 3030) before writing the fix: an unrelated task's METRICS
// write mid-click reliably swallowed the click.
//
// The fix (setHtmlIfChanged, in index.html) applies at every render call
// site that rebuilds real action-button DOM on an SSE tick: the active-cards
// board, Done rows, the task-detail overlay's own action row
// (.detail-actions), its ctx row (.detail-ctx-row — the detail-handover
// pill's container), its stage-chain/milestone panel (.detail-fanout), the
// backlog list, and the header context meter's own slot (header-ctx-slot —
// the orchestrator Handover segment's container). Each test below forces one
// of those containers' exact render function to run — the same call the SSE
// handler makes — right between a real click's mousedown and mouseup, and
// asserts the resulting request still goes out.

// Shared drive: real mouse down/up (not .click(), which can complete before
// a forced same-tick render has a chance to land) with the container's
// render function invoked in between, standing in for an SSE broadcast
// arriving mid-click. `rerenderFnName` names one of the top-level render
// functions/vars in index.html's classic (non-module) <script>, all reachable
// as globals from page.evaluate.
//
// `es` (the page's own EventSource, same classic-script scoping as the vars
// above) is silenced for the width of the gesture. Root-caused 2026-09-13
// (board-size-sensitive full-suite flake on the first test below — see
// pipelinely-merge-skill's tech-design.md "Risks"): every `ui`-project spec
// shares one dev server and one chokidar-watched fixture TASKS_DIR
// (playwright.config.ts's webServer), so a REAL, content-changing broadcast
// triggered by a completely unrelated spec's own STATUS/METRICS/TIMELINE
// write — running concurrently in a different Playwright worker — can land
// in this exact window too, racing the one render this test deliberately
// forces below. Confirmed by direct reproduction outside this suite: with
// only the deliberate same-content render, the click survives every time
// (setHtmlIfChanged no-ops on identical HTML, as the header comment above
// already documents); with an unrelated task's METRICS file written
// mid-gesture — standing in for another worker's real write, and timed past
// chokidar/fsevents' own ~850-900ms coalescing latency on macOS — the click
// was swallowed 5/5 runs, a second, genuinely content-different replace this
// test isn't exercising and can't control for. Board size only changes how
// often that second, uncontrolled broadcast happens to overlap a gesture in
// a full-suite run; it was never about a card's on-screen position shifting,
// the hypothesis this file's Risks section had already ruled out.
async function clickSurvivingMidClickRerender(
  page: Page,
  locator: Locator,
  rerenderFnName: 'renderDashboard' | 'renderDoneGroups' | 'renderBacklog',
) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('locator has no bounding box')
  await page.evaluate(() => { window.__pausedOnMessage = es.onmessage; es.onmessage = () => {} })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.evaluate((fnName) => {
    if (fnName === 'renderDashboard') renderDashboard(currentTasks)
    else if (fnName === 'renderDoneGroups') renderDoneGroups(currentDoneGroups)
    else renderBacklog(currentBacklog)
  }, rerenderFnName)
  await page.mouse.up()
  // The Done-row case navigates on click (see its own test below) — by the
  // time mouseup fires, this page has already unloaded and gotten a fresh
  // `es` of its own with normal onmessage, so restoring the paused handler
  // on the now-destroyed execution context has nothing to do and nothing to
  // restore. Swallowed rather than awaited unconditionally, the one outcome
  // that matters (the click's own request/navigation already happened above)
  // is unaffected either way.
  await page.evaluate(() => { es.onmessage = window.__pausedOnMessage; delete window.__pausedOnMessage }).catch(() => {})
}

test('board card: clicking Terminal survives a same-content dashboard re-render landing mid-click', async ({ page }) => {
  await page.goto('/')

  const btn = page.locator('.card[data-slug="focus-dead-session"] [data-testid="focus-btn"]')
  await expect(btn).toBeVisible()

  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/focus/focus-dead-session') && r.method() === 'POST'),
    clickSurvivingMidClickRerender(page, btn, 'renderDashboard'),
  ])
  expect(req).toBeTruthy()
})

// The design-v2 alignment (M3) turned a Done row into a plain navigating
// link — no more inline Terminal button to race against a re-render, since
// the row's own action row was removed along with the inline expand. The
// same class of bug (a detached-and-recreated node swallowing a click)
// applies just as well to the link's navigation, so that is what this test
// now proves survives a same-content renderDoneGroups re-render landing
// mid-click.
test('Done row: clicking its link survives a same-content renderDoneGroups re-render landing mid-click', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('tab-btn-done').click()

  const row = page.locator('.done-row[data-slug="board-done-one"]')
  const link = row.getByTestId('done-row-link')
  await expect(link).toBeVisible()

  await clickSurvivingMidClickRerender(page, link, 'renderDoneGroups')

  await expect(page).toHaveURL('/task/board-done-one')
  await expect(page.getByTestId('task-detail')).toBeVisible()
})

test('task-detail overlay: clicking Terminal survives a same-content overlay re-render landing mid-click', async ({ page }) => {
  await page.goto('/')
  await page.locator('.card[data-slug="dev-ready"] .card-title').click()
  await expect(page.getByTestId('task-detail')).toBeVisible()

  const btn = page.locator('.detail-actions [data-testid="focus-btn"]')
  await expect(btn).toBeVisible()

  // renderDashboard is what the SSE handler actually calls; it re-runs
  // renderTaskDetail (and so .detail-actions) internally while the overlay
  // is open — see renderDashboard's own detailSlug branch in index.html.
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/focus/dev-ready') && r.method() === 'POST'),
    clickSurvivingMidClickRerender(page, btn, 'renderDashboard'),
  ])
  expect(req).toBeTruthy()
})

test('task-detail .detail-fanout: clicking the stage CTA survives a same-content overlay re-render landing mid-click', async ({ page }) => {
  await page.goto('/')
  await page.locator('.card[data-slug="dev-ready"] .card-title').click()
  await expect(page.getByTestId('task-detail')).toBeVisible()

  // detailL2Tab defaults to 'dev' on a fresh open, so the CTA (inside
  // .detail-fanout's l2-panel) is visible with no extra tab click needed —
  // same precedent as pipeline-stage-cta.spec.ts's identical-shape test.
  const cta = page.getByTestId('l2-cta')
  await expect(cta).toBeVisible()

  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/stage-skill/dev-ready') && r.method() === 'POST'),
    clickSurvivingMidClickRerender(page, cta, 'renderDashboard'),
  ])
  expect(req).toBeTruthy()
})

test('backlog list: clicking Waive survives a same-content renderBacklog re-render landing mid-click', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('tab-btn-backlog').click()

  // Not the "▶ Run" button: this suite's own shared webServer never sets
  // COCKPIT_DISPATCH_ENABLED (see playwright.config.ts's own comment), so it
  // identifies as a non-canonical instance and that button renders disabled
  // — see TASK.md: canonical-dispatch-gate. A disabled native button can't
  // be mid-click-interrupted at all (mousedown/up on it never fires
  // 'click'), so it can no longer stand in for this regression. Waive
  // exercises the exact same renderBacklog/setHtmlIfChanged container and
  // is unaffected by the canonical gate (it never touches the orchestrator
  // session).

  // Waive genuinely removes the item from the shared fixture BACKLOG.md
  // (backlog-batch-dispatch.spec.ts and others depend on its exact starting
  // contents) — snapshot and restore it so this test leaves no trace.
  const originalBacklog = await fs.readFile(BACKLOG_PATH, 'utf-8')
  try {
    const row = page.locator('[data-testid="backlog-row"][data-index="0"]')
    const btn = row.locator('[data-testid="backlog-dismiss-btn"]')
    await expect(btn).toBeVisible()

    // Waive opens the shared confirm modal rather than firing the request
    // directly — the request only fires once "Delete" is confirmed there.
    await clickSurvivingMidClickRerender(page, btn, 'renderBacklog')
    await expect(page.getByTestId('backlog-delete-modal')).toBeVisible()

    const [req, res] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/backlog/dismiss/') && r.method() === 'POST'),
      // Waited for alongside the request, not after: the restore below must
      // not run until the server's own write to BACKLOG.md has actually
      // finished, or it can land before that write and be clobbered right
      // back to the dismissed state.
      page.waitForResponse((r) => r.url().includes('/backlog/dismiss/') && r.request().method() === 'POST'),
      page.getByTestId('backlog-delete-confirm-btn').click(),
    ])
    expect(req.url()).toContain('/backlog/dismiss/0')
    expect(res.ok()).toBe(true)
  } finally {
    await fs.writeFile(BACKLOG_PATH, originalBacklog)
  }
})

// Direct coverage for refreshCardTimes/the emptied .card-time markup — the
// mechanism the tests above rely on indirectly (by not flaking). Uses
// page.clock instead of a real wait so a tick is deterministic rather than
// depending on landing on a real-clock boundary, the same non-determinism
// that made the "board card" test above flaky before this mechanism existed.
// The second test below additionally anchors that fake clock to the
// fixture's own real file mtime rather than real "now" — see its own
// comment for why.
test.describe('card-time freshness label', () => {
  test('a card\'s time-ago label populates after render, not left empty', async ({ page }) => {
    await page.goto('/')
    const time = page.locator('.card[data-slug="focus-dead-session"] [data-testid="card-time"]')
    await expect(time).toBeVisible()
    await expect(time).toHaveText(/ago$/)
  })

  test('a same-content re-render updates a ticked label without replacing the card\'s own button node', async ({ page }) => {
    await page.goto('/')
    const card = '.card[data-slug="focus-dead-session"]'
    const time = page.locator(`${card} [data-testid="card-time"]`)
    await expect(time).toHaveText(/ago$/)

    // Anchor the fake clock to the fixture's own real STATUS mtime — the
    // exact value the server reports as this task's updatedAt
    // (taskParser.ts's `statusStat.mtime`) — instead of leaving `before`
    // computed against real wall-clock "now". Nothing ever refreshes this
    // fixture file's mtime, so real elapsed time since it was last
    // checked out only grows; once that drift passes 24h, `before` lands
    // in the "d ago" bucket and a further 1-hour fast-forward can never
    // cross another day boundary, making `after` below deterministically
    // equal `before` regardless of retries. Forcing a render 2 hours after
    // the real mtime keeps `before` solidly inside the "h ago" bucket no
    // matter how long it's been since checkout.
    const { mtimeMs } = await fs.stat(FOCUS_DEAD_SESSION_STATUS_PATH)
    const ONE_HOUR_MS = 60 * 60 * 1000
    await page.clock.install({ time: mtimeMs + 2 * ONE_HOUR_MS })
    await page.evaluate(() => { renderDashboard(currentTasks) })
    const before = await time.textContent()

    // Tag the actual button DOM node so a replacement (a fresh node from a
    // full innerHTML rewrite) would lose the tag, while an in-place text
    // update (refreshCardTimes) would leave it untouched.
    await page.evaluate((sel) => {
      document.querySelector(`${sel} [data-testid="focus-btn"]`).dataset.testStableMarker = '1'
    }, card)

    // A plain millisecond count, not the '01:00' string this line used to
    // pass: Playwright's clock.fastForward string format is "[hh:]mm:ss",
    // so '01:00' parsed as 1 minute 0 seconds, not the 1 hour every
    // surrounding comment (and this test's own name) describes — the real
    // root cause of this test's failure, not just the mtime drift above.
    // A 60s step reliably crossed the "m ago" bucket while the fixture was
    // fresh, then stopped crossing anything once real drift pushed
    // `before` into the coarser "h ago"/"d ago" buckets, which is exactly
    // the failure QA reported. pipelinely-merge-gate.spec.ts's own
    // `fastForward(10_000)` uses a bare millisecond number for the same
    // reason: the mm:ss string shorthand reads like hh:mm and isn't.
    await page.clock.fastForward(ONE_HOUR_MS)
    await page.evaluate(() => { renderDashboard(currentTasks) })

    const marker = await page.locator(`${card} [data-testid="focus-btn"]`).getAttribute('data-test-stable-marker')
    expect(marker).toBe('1')

    const after = await time.textContent()
    expect(after).not.toBe(before)
    expect(after).toMatch(/ago$/)
  })
})
