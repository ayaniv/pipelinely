import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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

// Regression guard for "→ Terminal does nothing when clicked" (reported against
// the live dashboard). The server broadcasts on ANY watched task file changing
// (see server.ts's chokidar watcher — one shared watch across every task dir,
// no per-client filtering), so with several tasks active at once an SSE push
// lands roughly every 1-2 seconds in real usage, none of them related to the
// card a developer is clicking. If a push replaced the button's DOM node
// between a click's mousedown and mouseup, the browser would never fire
// 'click' on either the old (detached) or new (never-pressed) button, so the
// request would silently never go out — no server log and no failed network
// request to point at, because there was no request.
//
// Every view is React now, and React's reconciliation keeps the same node for
// a same-content snapshot, so the click-survival cases live next to the views
// they guard, each driving a real SSE push through the page's own
// `es.onmessage` between a real mousedown and mouseup: e2e/react-task-detail.spec.ts
// ("click survives a same-content SSE push mid-click"), e2e/react-active-board.spec.ts
// ("clicking Terminal on a card survives a same-content SSE push landing
// mid-click") and e2e/react-board-tabs.spec.ts ("clicks survive an SSE push
// landing mid-click"). What stays here are the two "card-time freshness label"
// cases below, the second of which drives the label through the React clock
// tick (useNow).

// Direct coverage for the card-time label (.card-time). Uses
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

  test('a clock tick updates the ticked label without replacing the card\'s own button node', async ({ page }) => {
    // Anchor the fake clock to the fixture's own real STATUS mtime — the
    // exact value the server reports as this task's updatedAt
    // (taskParser.ts's `statusStat.mtime`) — instead of leaving `before`
    // computed against real wall-clock "now". Nothing ever refreshes this
    // fixture file's mtime, so real elapsed time since it was last
    // checked out only grows; once that drift passes 24h, `before` lands
    // in the "d ago" bucket and a further 1-hour fast-forward can never
    // cross another day boundary, making `after` below deterministically
    // equal `before` regardless of retries. Placing the clock 2 hours after
    // the real mtime keeps `before` solidly inside the "h ago" bucket no
    // matter how long it's been since checkout.
    //
    // Installed BEFORE navigating (unlike the render-forcing version this
    // replaces): the label now ticks off the board's own setInterval
    // (useNow), and only timers created after install are under the fake
    // clock's control.
    const { mtimeMs } = await fs.stat(FOCUS_DEAD_SESSION_STATUS_PATH)
    const ONE_HOUR_MS = 60 * 60 * 1000
    await page.clock.install({ time: mtimeMs + 2 * ONE_HOUR_MS })
    await page.goto('/')
    const card = '.card[data-slug="focus-dead-session"]'
    const time = page.locator(`${card} [data-testid="card-time"]`)
    await expect(time).toHaveText(/ago$/)
    const before = await time.textContent()

    // Tag the actual button DOM node so a replacement (a fresh node from a
    // full container rewrite) would lose the tag, while an in-place text
    // update would leave it untouched.
    await page.evaluate((sel) => {
      document.querySelector(`${sel} [data-testid="focus-btn"]`).dataset.testStableMarker = '1'
    }, card)

    // A plain millisecond count, not the '01:00' string this line used to
    // pass: Playwright's clock.fastForward string format is "[hh:]mm:ss",
    // so '01:00' parsed as 1 minute 0 seconds, not the 1 hour every
    // surrounding comment (and this test's own name) describes.
    // pipelinely-merge-gate.spec.ts's own `fastForward(10_000)` uses a bare
    // millisecond number for the same reason.
    await page.clock.fastForward(ONE_HOUR_MS)

    await expect(time).not.toHaveText(before!)
    await expect(time).toHaveText(/ago$/)
    const marker = await page.locator(`${card} [data-testid="focus-btn"]`).getAttribute('data-test-stable-marker')
    expect(marker).toBe('1')
  })
})
