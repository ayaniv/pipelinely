import { test, expect } from '@playwright/test'
import { selectBoardTab } from './fixtures/boardTabs'
import { TOKEN, DESKTOP, MOBILE, cssOf } from './fixtures/designTokens'

// M2 of the Claude Design v2 alignment: the Active tab — its two section
// headers, the session card's ctx row, and the project filter.
//
// Three things change here.
//
// 1. SECTION HEADER ART. v2 opened each header with a 36px PNG. Pipelinely
//    Dashboard v4 (like v3) drops it: the header is the label, the count and
//    the rule (dashboard-v4-table-design-alignment).
// 2. THE CTX ROW IS THE DESIGN'S, EXACTLY. The design's row is `ctx · meter ·
//    NN%` plus either the inline terminal button (working cards) or the
//    Handover pill (hot ctx) — nothing else. This repo also rendered inline
//    TOK and COST there; those come out (the figures stay available in the
//    task detail view). The row's bottom padding is also state-dependent in
//    the design: 18px on a working card, 0 on one that has a footer below it.
// 3. MULTI-SELECT PROJECT FILTER. The design's chips toggle independently and
//    an empty selection means "all" — there is no "All" chip. This repo held
//    a single filterProject string.
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).
// board-metrics is the only fixture with a priced METRICS file, so it is the one
// card with a real context percentage — and at 42% it is the suite's COLD
// case for the shared meter, the counterpart to the hot header meter in
// design-v2-orchestrator-ctx.spec.ts.
//
test.use({ colorScheme: 'light', viewport: DESKTOP })

const WORKING_SLUG = 'board-metrics'
const WORKING_CTX = 42
// A waiting task: it renders a footer, so its ctx row is the "0 bottom
// padding" case and it is the card whose CTA footer the design specifies.
const WAITING_SLUG = 'dev-ready'

const card = (page: import('@playwright/test').Page, slug: string) =>
  page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)

test.describe('section headers', () => {
  test('neither group heading carries creature art any more (v4)', async ({ page }) => {
    await page.goto('/')

    for (const group of ['active-group-needs', 'active-group-working']) {
      const heading = page.getByTestId(group).getByTestId('active-group-header')
      await expect(heading).toBeVisible()
      expect(await heading.evaluate((el) => el.querySelector('[style*="background-image"]'))).toBeNull()
    }
  })

  // The design's own header row: `align-items:center; gap:6px; margin:0 4px
  // 14px`. This repo once drifted to baseline alignment and an 8px gap.
  test('the header row uses the design\'s alignment, gap and margins', async ({ page }) => {
    await page.goto('/')

    const header = page.getByTestId('active-group-working').getByTestId('active-group-header')
    expect(await cssOf(header, 'align-items')).toBe('center')
    expect(await cssOf(header, 'column-gap')).toBe('6px')
    expect(await cssOf(header, 'margin-top')).toBe('0px')
    expect(await cssOf(header, 'margin-left')).toBe('4px')
    expect(await cssOf(header, 'margin-bottom')).toBe('14px')
  })
})

test.describe('session card ctx row', () => {
  test('the row carries only ctx, the meter and the percentage', async ({ page }) => {
    await page.goto('/')

    const row = card(page, WORKING_SLUG).locator('.card-ctx-row')
    await expect(row.getByTestId('card-ctx-label')).toHaveText('ctx')
    await expect(row.getByTestId('ctx-meter')).toBeVisible()
    await expect(row.getByTestId('ctx-value')).toHaveText(`${WORKING_CTX}%`)

    // The inline TOK/COST metrics this repo added are gone from the row.
    await expect(row.getByTestId('card-cost')).toHaveCount(0)
    await expect(row.getByTestId('card-cost-label')).toHaveCount(0)
    await expect(row.getByTestId('card-tok-label')).toHaveCount(0)
  })

  // The cold half of the design's one hot-context rule (`ctx > 60`), on the
  // same shared meter the header's hot case exercises. Since v3 the fill is
  // the card's stage tone (`ctxColor: t.c`), so a cold dev card fills in
  // --devC; v2's accent fill predates the stage palette.
  test('a cold context fills the meter in its stage tone, not amber', async ({ page }) => {
    await page.goto('/')

    const row = card(page, WORKING_SLUG).locator('.card-ctx-row')
    expect(await cssOf(row.getByTestId('ctx-meter-fill'), 'background-color')).toBe(TOKEN.devC)
    expect(await cssOf(row.getByTestId('ctx-meter'), 'background-color')).toBe(TOKEN.surface2)
    expect(await cssOf(row.getByTestId('ctx-value'), 'color')).toBe(TOKEN.text2)
  })

  // `ctxPadBottom` in the design: 18px while working (there is no footer
  // beneath to supply the space), 0 otherwise.
  test('the row\'s bottom padding depends on whether a footer follows', async ({ page }) => {
    await page.goto('/')

    const workingRow = card(page, WORKING_SLUG).locator('.card-ctx-row')
    expect(await cssOf(workingRow, 'padding-bottom')).toBe('18px')
    await expect(card(page, WORKING_SLUG).locator('.card-footer')).toHaveCount(0)

    const waitingRow = card(page, WAITING_SLUG).locator('.card-ctx-row')
    expect(await cssOf(waitingRow, 'padding-bottom')).toBe('0px')
    await expect(card(page, WAITING_SLUG).locator('.card-footer')).toHaveCount(1)
  })
})

test.describe('card menu', () => {
  // The design opens the menu at `top:32px; right:0` relative to the 26px
  // trigger — a fixed offset, not the `calc(100% + 6px)` this repo used.
  test('the menu opens at the design\'s own offset', async ({ page }) => {
    await page.goto('/')

    const trigger = card(page, WAITING_SLUG).getByTestId('card-menu-btn')
    await trigger.click()
    // The menu is portalled into document.body (fixed), so it is looked up from the page
    // and its offset is measured from the trigger's own box.
    const menu = page.getByTestId('card-menu')
    await expect(menu).toBeVisible()
    const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()])
    const MENU_GAP_PX = 6
    expect(Math.abs(menuBox!.y - (triggerBox!.y + triggerBox!.height) - MENU_GAP_PX)).toBeLessThanOrEqual(1)
    expect(Math.abs(menuBox!.x + menuBox!.width - (triggerBox!.x + triggerBox!.width))).toBeLessThanOrEqual(1)
    expect(await cssOf(menu, 'min-width')).toBe('168px')
    expect(await cssOf(menu, 'border-radius')).toBe('12px')
    expect(await cssOf(menu, 'border-top-color')).toBe(TOKEN.border2)
  })
})

test.describe('card hover', () => {
  // The design's card lift is 3px (`transform:translateY(-3px)` on hover,
  // Dashboard v2 line 226); this repo's shared .card rule used 2px, which the
  // session card inherited. Polled because the transform runs behind a 0.25s
  // transition.
  test('hovering a card lifts it by the design\'s 3px', async ({ page }) => {
    await page.goto('/')

    await card(page, WAITING_SLUG).hover()
    await expect
      .poll(async () => cssOf(card(page, WAITING_SLUG), 'transform'))
      .toBe('matrix(1, 0, 0, 1, 0, -3)')
  })
})

test.describe('project filter — multi-select', () => {
  // The design's chip row is toggles only: "Multi-select; an empty selection
  // means 'all'". There is no "All" chip to select.
  test('there is no All chip', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()

    await expect(page.getByTestId('filter-chip-project-all')).toHaveCount(0)
    await expect(page.getByTestId('filter-chip-project-cockpit-ai')).toBeVisible()
  })

  test('two projects can be selected at once and both sets of cards show', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()
    await page.getByTestId('filter-chip-project-acme-api').click()
    await page.getByTestId('filter-chip-project-acme-web').click()

    await expect(page.getByTestId('filter-chip-project-acme-api')).toHaveClass(/is-active/)
    await expect(page.getByTestId('filter-chip-project-acme-web')).toHaveClass(/is-active/)

    await expect(page.locator('[data-testid="task-card"][data-repo="acme-api"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="task-card"][data-repo="acme-web"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="task-card"][data-repo="cockpit-ai"]')).toHaveCount(0)
  })

  test('de-selecting one project leaves the other selected', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()
    await page.getByTestId('filter-chip-project-acme-api').click()
    await page.getByTestId('filter-chip-project-acme-web').click()
    await page.getByTestId('filter-chip-project-acme-api').click()

    await expect(page.getByTestId('filter-chip-project-acme-api')).not.toHaveClass(/is-active/)
    await expect(page.getByTestId('filter-chip-project-acme-web')).toHaveClass(/is-active/)
    await expect(page.locator('[data-testid="task-card"][data-repo="acme-api"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="task-card"][data-repo="acme-web"]').first()).toBeVisible()
  })

  // "The filter applies to all three tabs" (handoff README). A multi-select
  // that only narrowed the Active tab would be a different feature.
  test('the selection narrows the Done tab too', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()
    await page.getByTestId('filter-chip-project-acme-api').click()
    await selectBoardTab(page, 'done')

    await expect(page.locator('[data-testid="done-row"][data-repo="acme-api"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="done-row"][data-repo="cockpit-ai"]')).toHaveCount(0)
  })
})

test.describe('card grid — mobile', () => {
  test.use({ viewport: MOBILE })

  // The design's grid is `minmax(min(100%,300px),1fr)`; this repo's plain
  // `minmax(300px,1fr)` overflows a 375px viewport once the gutters are
  // subtracted, which is exactly the bug the `min(100%, …)` guard prevents.
  test('cards fit the viewport instead of overflowing it', async ({ page }) => {
    await page.goto('/')

    const grid = await page.locator('.active-group-grid').first().boundingBox()
    const firstCard = await page.getByTestId('task-card').first().boundingBox()
    expect(firstCard!.width).toBeLessThanOrEqual(grid!.width + 1)

    const docScrollsSideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    )
    expect(docScrollsSideways).toBe(false)
  })
})
