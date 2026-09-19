import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { selectBoardTab, gotoBoardTab } from './fixtures/boardTabs'

// Reconciling the merged M0–M2 board against the Claude Design reference
// (tasks/ui-redesign-pipelinely/design-handoff/project/Cockpit Sharpened.dc.html)
// and putting the Backlog / In Progress / Done tabs back.
//
// Two things about how these cases are written:
//
// The card cases assert the *shape* the reference specifies — a left-edge
// stripe rather than a top one, one status dot rather than two, one meta row
// rather than two stacked ones — never a hardcoded hex value. Pinning the
// exact colours would make this a screenshot test in disguise, red on every
// palette tweak; pinning "the paused card's note accent differs from the
// needs-you card's" is the property that actually broke.
//
// The tab cases deliberately overlap board-redesign.spec.ts, which until now
// asserted the opposite (`#tab-bar` has count 0). That test is rewritten
// rather than deleted — see the plan's "The two sources disagree about tabs".
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).

test.use({ colorScheme: 'light' })

// board-metrics is the only fixture with a priced METRICS file, so it is the one
// card with a real CTX percentage and a priced cost. dev-ready is a
// `waiting:` fixture (attentionStatus needs-you) with a reason line;
// resume-dead-session is the one `paused:` fixture, also with a reason.
// board-no-branch declares no Branch: at all.
const METRICS_SLUG = 'board-metrics'
const NEEDS_YOU_SLUG = 'dev-ready'
const PAUSED_SLUG = 'resume-dead-session'
const NO_BRANCH_SLUG = 'board-no-branch'

function card(page: Page, slug: string): Locator {
  return page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
}

async function cssOf(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  )
}

test.describe('active sessions card — reconciled against the design reference', () => {
  // Superseded by the Pipelinely Pipeline redesign: that design has no
  // left-edge accent stripe at all — status is carried entirely by the
  // header's own status pill (dot + label), which is what a needs-you vs.
  // working card now differs by (see the border-tint case right below,
  // which still holds).
  test('there is no left-edge accent stripe; status lives in the header pill instead', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, METRICS_SLUG).locator('.card-stripe')).toHaveCount(0)
    await expect(card(page, NEEDS_YOU_SLUG).locator('.card-status-pill')).toBeVisible()
  })

  test('a needs-you card is tinted, not merely outlined', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, NEEDS_YOU_SLUG)).toBeVisible()

    const attention = await cssOf(card(page, NEEDS_YOU_SLUG), 'background-color')
    const plain = await cssOf(card(page, METRICS_SLUG), 'background-color')
    expect(attention).not.toBe(plain)
  })

  test('a card carries exactly one status dot, not one in the header and one in the pill', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, NEEDS_YOU_SLUG)).toBeVisible()

    await expect(card(page, NEEDS_YOU_SLUG).locator('.card-status-dot')).toHaveCount(1)
  })

  // Superseded twice over: the design's card shows project + slug (not the
  // git branch) next to a copy button, in its own row below the title — and
  // the design-v2 follow-up round then removed the secondary pills row that
  // used to sit beneath it (see design-v2-card-followup.spec.ts, which owns
  // that claim). The slug row itself is what survives here.
  test('project and slug render in their own row below the title', async ({ page }) => {
    await page.goto('/')
    const c = card(page, NEEDS_YOU_SLUG)
    await expect(c).toBeVisible()

    await expect(c.locator('.card-slug-row')).toContainText('dev-ready')
    await expect(c.locator('.card-slug-row')).toContainText('cockpit-ai')
  })

  // Superseded: M2 of the Claude Design v2 alignment removed the card's
  // inline TOK/COST metrics — the row is now ctx-only (see
  // design-v2-active-board.spec.ts's "the row carries only ctx, the meter
  // and the percentage", which owns that claim). What survives here is the
  // row's own leading label.
  test('the ctx row labels its one metric', async ({ page }) => {
    await page.goto('/')
    const c = card(page, METRICS_SLUG)
    await expect(c).toBeVisible()

    await expect(c.locator('.card-ctx-label')).toHaveText('ctx')
  })

  test('a card with no metrics still labels the row and shows an em dash, not NaN', async ({ page }) => {
    await page.goto('/')
    const footer = card(page, NEEDS_YOU_SLUG)
    await expect(footer).toBeVisible()

    await expect(footer.getByTestId('ctx-value')).toHaveText('—')
    await expect(footer).not.toContainText('NaN')
  })

  // Superseded: the design-v2 follow-up round put the design's terminal
  // button where the header's open-detail arrow used to be, which leaves the
  // card title as the board's open-detail affordance.
  test('the card title opens the task detail overlay', async ({ page }) => {
    await page.goto('/')
    const title = card(page, NEEDS_YOU_SLUG).locator('.card-title')
    await expect(title).toBeVisible()

    await title.click()
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.locator('#detail-title')).toHaveText(/\S/)
  })

  // Superseded: the design's own card summary (verified against Pipelinely
  // Dashboard v2.dc.html's live renderer) has no per-status accent at all —
  // plain paragraph text, same treatment regardless of status. The
  // bordered/tinted callout this used to assert on was built against an
  // earlier, since-superseded reference file.
  test('a waiting/paused reason renders as plain text, carrying its own real content', async ({ page }) => {
    await page.goto('/')
    const needsYouNote = card(page, NEEDS_YOU_SLUG).getByTestId('card-note')
    const pausedNote = card(page, PAUSED_SLUG).getByTestId('card-note')
    await expect(needsYouNote).toBeVisible()
    await expect(pausedNote).toBeVisible()
    await expect(needsYouNote).toHaveCSS('border-left-width', '0px')
    await expect(pausedNote).toHaveCSS('border-left-width', '0px')
  })

  test('a card with no waiting or paused reason renders no note callout', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, METRICS_SLUG)).toBeVisible()

    await expect(card(page, METRICS_SLUG).getByTestId('card-note')).toHaveCount(0)
  })
})

test.describe('three-tab board', () => {
  test('the board renders a Backlog / In Progress / Done tab bar', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('tab-bar')).toBeVisible()
    await expect(page.getByTestId('tab-btn-backlog')).toBeVisible()
    await expect(page.getByTestId('tab-btn-inprogress')).toBeVisible()
    await expect(page.getByTestId('tab-btn-done')).toBeVisible()
  })

  test('In Progress is the default tab and the other two panels are hidden', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(page.getByTestId('backlog-section')).toBeHidden()
    await expect(page.getByTestId('done-section')).toBeHidden()
  })

  test('selecting a tab shows only that panel', async ({ page }) => {
    await page.goto('/')

    await selectBoardTab(page, 'backlog')
    await expect(page.getByTestId('backlog-section')).toBeVisible()
    await expect(page.getByTestId('active-sessions')).toBeHidden()
    await expect(page.getByTestId('done-section')).toBeHidden()

    await selectBoardTab(page, 'done')
    await expect(page.getByTestId('done-section')).toBeVisible()
    await expect(page.getByTestId('active-sessions')).toBeHidden()
    await expect(page.getByTestId('backlog-section')).toBeHidden()
  })

  test('the selected tab survives a reload', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    await page.reload()
    await expect(page.getByTestId('done-section')).toBeVisible()
    await expect(page.getByTestId('active-sessions')).toBeHidden()
  })

  test('a garbage stored tab value falls back to In Progress rather than hiding every panel', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.setItem('cockpit-active-tab', 'not-a-tab'))

    await page.reload()
    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(page.getByTestId('backlog-section')).toBeHidden()
    await expect(page.getByTestId('done-section')).toBeHidden()
  })

  // Internal consistency rather than a hardcoded total: the fixture set grows
  // every time another feature adds one, and recomputing from /api/tasks would
  // just be a second implementation of the thing under test.
  test('each tab count equals the rows rendered in its own panel', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('tab-bar')).toBeVisible()

    const inProgress = await page.getByTestId('task-card').count()
    await expect(page.getByTestId('tab-count-inprogress')).toHaveText(String(inProgress))

    await selectBoardTab(page, 'backlog')
    const backlog = await page.getByTestId('backlog-row').count()
    await expect(page.getByTestId('tab-count-backlog')).toHaveText(String(backlog))

    await selectBoardTab(page, 'done')
    const done = await page.getByTestId('done-row').count()
    await expect(page.getByTestId('tab-count-done')).toHaveText(String(done))
  })

  // Superseded by the Pipelinely Pipeline redesign: the tab bar now lives in
  // the persistent sidebar (see .app-sidebar), which the design keeps
  // visible on its inner task view too — so switching sections no longer
  // requires backing out of a detail view first. #board (not the sidebar)
  // is still what toggles with a detail view; that's the real signal this
  // case checks now.
  test('the sidebar tab bar stays visible while a task detail is open, and the board panel swaps out', async ({ page }) => {
    await page.goto('/')
    await card(page, NEEDS_YOU_SLUG).locator('.card-title').click()

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.getByTestId('tab-bar')).toBeVisible()
    // #board (not board-filters, which now starts hidden behind the filter
    // toggle regardless of detail state — see the toolbar's own filter
    // reveal) is the real "board panel" signal here.
    await expect(page.getByTestId('summary-strip')).toBeHidden()

    await page.getByTestId('detail-close').click()
    await expect(page.getByTestId('tab-bar')).toBeVisible()
    await expect(page.getByTestId('summary-strip')).toBeVisible()
  })
})
