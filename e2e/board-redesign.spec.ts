import { test, expect } from '@playwright/test'
import { gotoBoardTab } from './fixtures/boardTabs'

// M1 of the pipelinely redesign: focus banner, summary strip, active
// sessions, backlog, done. M1 also removed the Backlog/In Progress/Done tab
// bar, which cockpit-ui-reconcile then put back — so the sections below live
// in tabs again, and any case reaching a backlog or done row selects its tab
// first via gotoBoardTab.
//
// The summary-strip cases assert INTERNAL CONSISTENCY (each tile against
// the cards actually rendered below it) rather than hardcoded fixture
// totals. Two reasons: the fixture set grows every time another feature
// adds one, and — more importantly — a test that recomputes the count from
// /api/tasks would just be a second implementation of the thing under test.
// "The tile agrees with the cards" is the property that actually matters.
//
// One constraint worth stating: attentionStatus's own 'working' branch
// requires a LIVE iTerm2 session id (see computeAttentionStatus in
// src/taskParser.ts), which no fixture can have. The Working tile itself
// does not depend solely on that, though — it also counts a task whose
// STATUS file says "working" even without a confirmed live session (see
// renderSummaryStrip in public/index.html), so the loop below compares it
// against cards carrying that same raw lifecycle status (data-lifecycle-
// status) rather than the attentionStatus-derived data-status the other
// two tiles compare against.
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).
// board-metrics is the only fixture with a priced METRICS file, so it is the one
// card with a real CTX percentage and a priced cost.

test.use({ colorScheme: 'light' })

const METRICS_SLUG = 'board-metrics'
const METRICS_CTX = 42
// 400,000 input + 20,000 output at claude-sonnet-5's $2/$10 per 1M.
const METRICS_COST = '$1.00'

test.describe('board layout', () => {
  // This case used to assert the exact opposite — that the tab bar was gone
  // and all three sections showed at once, which is what the design
  // reference specifies. The developer reversed that after using the merged
  // board: at real task volume the single page is enormous. It keeps its
  // job as the board-layout guard, with the layout it guards inverted.
  // Full reasoning in tech-design-cockpit-ui-reconcile.md.
  test('the board is tabbed, and whole-board context sits outside the tabs', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('tab-bar')).toBeVisible()
    // Summary strip is not tabbed — it counts every active session.
    await expect(page.getByTestId('summary-strip')).toBeVisible()

    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(page.getByTestId('backlog-section')).toBeHidden()
    await expect(page.getByTestId('done-section')).toBeHidden()
  })

  // Superseded by the Pipelinely Pipeline redesign: the 4-tile summary strip
  // is now 2 pulse chips (working / waiting) matching the design exactly.
  // Paused has no equivalent in the design; active spend moved into the
  // header's own "spent today" pill (see the next two cases).
  test('each pulse chip matches the number of cards in that status', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('summary-strip')).toBeVisible()

    const chips = [
      { testid: 'pulse-chip-waiting', selector: '[data-status="needs-you"]' },
      // Working counts by raw lifecycle status (data-lifecycle-status), not
      // attentionStatus (data-status) — see the file header comment.
      { testid: 'pulse-chip-working', selector: '[data-lifecycle-status="working"]:not([data-status="needs-you"])' },
    ]

    for (const { testid, selector } of chips) {
      const cardCount = await page
        .locator(`[data-testid="task-card"]${selector}`)
        .count()
      const chipText = await page.getByTestId(testid).innerText()
      const chipCount = Number(chipText.match(/\d+/)![0])
      expect(chipCount, `${testid} should equal the ${selector} card count`).toBe(cardCount)
    }
  })

  test('the waiting chip is non-zero, so the consistency check above is not vacuous', async ({ page }) => {
    await page.goto('/')

    const cardCount = await page
      .locator('[data-testid="task-card"][data-status="needs-you"]')
      .count()
    expect(cardCount).toBeGreaterThan(0)
  })

  // Superseded: M2 of the Claude Design v2 alignment removed the card's
  // inline cost figure (see design-v2-active-board.spec.ts), so this can no
  // longer sum per-card cost text off the board. board-metrics is the only
  // active fixture with a priced METRICS file (see the file header comment above),
  // so it is the sole contributor to the header spend total — asserting
  // against the same named constant the "priced cost" case below grounds
  // itself in, rather than reintroducing a per-card cost display just to
  // sum it back up.
  test('the header spend pill equals board-metrics\' own priced cost, its sole contributor', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('header-spend')).toBeVisible()
    await expect(page.getByTestId('header-spend')).toContainText(METRICS_COST)
  })
})

test.describe('session card', () => {
  test('a card with metrics renders a partially-filled CTX meter and its percentage', async ({ page }) => {
    await page.goto('/')

    const card = page.locator(`[data-testid="task-card"][data-slug="${METRICS_SLUG}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('ctx-value')).toHaveText(`${METRICS_CTX}%`)

    const trackWidth = await card.getByTestId('ctx-meter').evaluate(
      (el) => el.getBoundingClientRect().width
    )
    const fillWidth = await card.getByTestId('ctx-meter-fill').evaluate(
      (el) => el.getBoundingClientRect().width
    )
    expect(trackWidth).toBeGreaterThan(0)
    expect(fillWidth).toBeGreaterThan(0)
    expect(fillWidth).toBeLessThan(trackWidth)
  })

  // Superseded: M2 removed the card's own inline cost figure — "the figures
  // stay available in the task detail view" (design-v2-active-board.spec.ts),
  // so this now opens that view rather than reading the board card. M4 then
  // replaced the detail view's own stats grid with the design's header meta
  // row — four mono pairs (tok/cost/sessions/model, see
  // design-v2-task-detail.spec.ts) — so the cost figure is read from that
  // row's 'cost' pair (index 1) rather than a dedicated detail-cost testid.
  test('a card with metrics shows its priced cost in the task detail view', async ({ page }) => {
    await page.goto('/')

    const card = page.locator(`[data-testid="task-card"][data-slug="${METRICS_SLUG}"]`)
    // The design-v2 follow-up round replaced the header's open-detail arrow
    // with the design's terminal button, leaving the card title as the
    // board's open-detail affordance.
    await card.locator('.card-title').click()

    await expect(page.getByTestId('task-detail')).toBeVisible()
    const meta = page.getByTestId('detail-meta')
    await expect(meta.getByTestId('detail-meta-value').nth(1)).toHaveText(METRICS_COST)
  })

  // Failure path: no METRICS at all is the common case across the fixture
  // set (and across real tasks that have not run yet). The meter must
  // collapse to zero width and the value to an em dash — never NaN%, and
  // never a width:undefined% that silently renders full.
  test('a card with no metrics shows an em dash and a zero-width meter, not NaN', async ({ page }) => {
    await page.goto('/')

    const card = page.locator('[data-testid="task-card"][data-slug="dev-ready"]')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('ctx-value')).toHaveText('—')

    const fillWidth = await card.getByTestId('ctx-meter-fill').evaluate(
      (el) => el.getBoundingClientRect().width
    )
    expect(fillWidth).toBe(0)

    expect(await card.innerText()).not.toContain('NaN')
  })

  test('a paused card renders its footer CTA as the primary action, terminal as a plain icon', async ({ page }) => {
    await page.goto('/')

    // resume-dead-session has no dispatchable next stage (paused, not
    // 'waiting') — cardFooterHtml falls back to its "See details" CTA, still
    // the one primary button; the terminal icon (resume-btn, since status is
    // paused) is a secondary, un-primaried affordance, in the card's header
    // row rather than beside the CTA as of the design-v2 follow-up round.
    const card = page.locator('[data-testid="task-card"][data-slug="resume-dead-session"]')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('card-cta-btn')).toHaveAttribute('data-primary', 'true')
    await expect(card.getByTestId('resume-btn')).not.toHaveAttribute('data-primary', 'true')
    // Exactly one primary per card — the design's single accent-tinted
    // button with everything else as a ghost.
    await expect(card.locator('button[data-primary="true"]')).toHaveCount(1)
  })

  test('a needs-you card renders its stage CTA as the primary action, terminal as a plain icon', async ({ page }) => {
    await page.goto('/')

    // dev-ready's waitingReason ("plan reviewed, ready for dev") resolves a
    // real next stage (computeNextStageCta) — the footer's primary slot is
    // that stage's own CTA ("Start dev →"), per Pipelinely Dashboard
    // v2.dc.html's own footer shape, not the terminal button.
    const card = page.locator('[data-testid="task-card"][data-slug="dev-ready"]')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-status', 'needs-you')
    await expect(card.getByTestId('card-cta-btn')).toHaveAttribute('data-primary', 'true')
    await expect(card.getByTestId('focus-btn')).not.toHaveAttribute('data-primary', 'true')
    await expect(card.locator('button[data-primary="true"]')).toHaveCount(1)
  })

  // The design gives a primary button only to the cards that want the
  // developer's attention. An idle card's actions are all ghosts — asserting
  // zero primaries is what stops "primary" from degrading into "the first
  // button on every card".
  test('an idle card has no primary action at all', async ({ page }) => {
    await page.goto('/')

    const card = page.locator(`[data-testid="task-card"][data-slug="${METRICS_SLUG}"]`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-status', 'idle')
    await expect(card.locator('button[data-primary="true"]')).toHaveCount(0)
  })
})

test.describe('backlog rows', () => {
  test('backlog items render as rows carrying their three existing actions', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    const row = page.getByTestId('backlog-row').first()
    await expect(row).toBeVisible()
    await expect(row.getByTestId('backlog-edit-btn')).toBeVisible()
    await expect(row.getByTestId('backlog-play-btn')).toBeVisible()
    await expect(row.getByTestId('backlog-dismiss-btn')).toBeVisible()
  })

  test('the edit form still opens in place from a row', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    const row = page.getByTestId('backlog-row').first()
    await row.getByTestId('backlog-edit-btn').click()

    await expect(page.getByTestId('backlog-edit-form')).toBeVisible()
    await expect(page.getByTestId('backlog-edit-desc-input')).toBeVisible()
  })
})

// The design-v2 alignment (M3) replaced the inline expand with a real
// navigating link — see design-v2-backlog-done.spec.ts for the full
// row-shape/styling coverage. What stays worth proving here, against this
// file's own two-row fixture, is that each row is independently wired to
// its own task.
test.describe('done list', () => {
  const ONE = '[data-testid="done-row"][data-slug="board-done-one"]'
  const TWO = '[data-testid="done-row"][data-slug="board-done-two"]'

  test('a done row is a link to its own task detail', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    await expect(page.locator(ONE)).toBeVisible()
    await expect(page.locator(ONE).getByTestId('done-row-link')).toHaveAttribute('href', '/task/board-done-one')
    await expect(page.locator(TWO).getByTestId('done-row-link')).toHaveAttribute('href', '/task/board-done-two')
  })

  test('clicking a done row opens that task\'s detail view', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    await page.locator(ONE).getByTestId('done-row-link').click()

    await expect(page).toHaveURL('/task/board-done-one')
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  test('the inline expand is gone — no detail panel, no Open detail link', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    // Each board tab is its own real page now (/backlog, /done — see
    // switchTab's own tabUrl), so the "did not navigate" assertion is
    // relative to whichever tab this test landed on, not bare '/'.
    await expect(page).toHaveURL('/done')
    await expect(page.getByTestId('task-detail')).toBeHidden()
    await expect(page.locator(`${ONE} [data-testid="done-row-detail"]`)).toHaveCount(0)
    await expect(page.locator(`${ONE} [data-testid="done-open-detail"]`)).toHaveCount(0)
  })
})
