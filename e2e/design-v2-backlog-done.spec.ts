import { test, expect } from '@playwright/test'
import { gotoBoardTab } from './fixtures/boardTabs'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'

// M3 of the Claude Design v2 alignment: the Backlog tab, the Done tab and the
// work-density heatmap (which now opens on the You tab, not Done — see the
// "work density heatmap" describe block below).
//
// The largest behavioural change in the whole pass lives here. The design's
// Done row is a LINK — the whole row navigates to the session in done mode
// and ends in a chevron-right (Dashboard v2 lines 406-414). This repo's row
// instead expanded inline to reveal pills, the stats grid, action buttons and
// an "Open detail" link. The developer's call was: match the design, drop the
// expand. Everything the expand exposed is one click away on the detail page
// the row now goes to, so nothing becomes unreachable.
//
// The Done group header changes meaning too: the design shows the day's total
// SPEND (`g.total`, summed over the group's visible rows), not the row count
// this repo showed.
//
// design-v2-done-priced is the fixture that makes that sum assertable — the
// only done fixture carrying a METRICS file, so the only one with a real
// cost. It shares board-done-one's merge timestamp, so the group it lands in
// mixes priced and unpriced rows, which is the case the design's own
// `parseFloat` reduce has to survive.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const PRICED_SLUG = 'design-v2-done-priced'

const doneRow = (page: import('@playwright/test').Page, slug: string) =>
  page.locator(`[data-testid="done-row"][data-slug="${slug}"]`)

// The group card that contains a given row — the design computes its total
// from exactly the rows inside it, so the assertion has to start from a row
// and walk up rather than guessing at a date label whose text ("Today",
// "Yesterday", a date) depends on when the suite runs.
const groupOf = (page: import('@playwright/test').Page, slug: string) =>
  page.locator(`[data-testid="done-date-group"]:has([data-slug="${slug}"])`)

// '—' is what a row with no METRICS renders; the design's own reduce treats a
// missing price as nothing rather than skipping the row.
const parseMoney = (text: string): number => {
  const match = text.match(/\$([\d.]+)/)
  return match ? parseFloat(match[1]) : 0
}

test.describe('done rows navigate', () => {
  test('a done row is a link to its task detail', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const link = doneRow(page, PRICED_SLUG).getByTestId('done-row-link')
    await expect(link).toHaveAttribute('href', `/task/${PRICED_SLUG}`)
  })

  test('clicking a done row opens that task\'s detail view', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    await doneRow(page, PRICED_SLUG).getByTestId('done-row-link').click()
    await expect(page).toHaveURL(new RegExp(`/task/${PRICED_SLUG}$`))
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  // The inline expand is gone, not merely collapsed by default — a row that
  // still carried its detail block would keep expanding on click and fight
  // the navigation above.
  test('the inline expand and its Open detail link are gone', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    await expect(page.getByTestId('done-row-detail')).toHaveCount(0)
    await expect(page.getByTestId('done-open-detail')).toHaveCount(0)
  })

  test('the row ends in the design\'s chevron, and its meta reads project / slug', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const row = doneRow(page, PRICED_SLUG)
    await expect(row.getByTestId('done-row-chevron')).toBeVisible()
    await expect(row.locator('.done-row-meta')).toHaveText(`cockpit-ai / ${PRICED_SLUG}`)
    // The project half is the emphasised one in the design
    // (`font-weight:600; color:var(--text2)` inside an otherwise text3 line).
    const project = row.locator('.done-row-project')
    expect(await cssOf(project, 'font-weight')).toBe('600')
    expect(await cssOf(project, 'color')).toBe(TOKEN.text2)
  })

  test('the row uses the design\'s padding, radius and sage check badge', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const link = doneRow(page, PRICED_SLUG).getByTestId('done-row-link')
    expect(await cssOf(link, 'padding-top')).toBe('14px')
    expect(await cssOf(link, 'padding-left')).toBe('18px')
    expect(await cssOf(link, 'column-gap')).toBe('14px')

    const check = doneRow(page, PRICED_SLUG).locator('.done-row-check')
    expect(await cssOf(check, 'width')).toBe('18px')
    expect(await cssOf(check, 'background-color')).toBe(TOKEN.sageSoft)
    expect(await cssOf(check, 'color')).toBe(TOKEN.sage)
  })
})

test.describe('done group header', () => {
  test('the header shows the day\'s total spend, not a row count', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const total = groupOf(page, PRICED_SLUG).getByTestId('done-date-total')
    await expect(total).toHaveText(/^\$\d+\.\d{2}$/)
  })

  test('the total equals the sum of that group\'s own row costs', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const group = groupOf(page, PRICED_SLUG)
    const costs = await group.locator('.done-row-cost').allTextContents()
    const summed = costs.reduce((n, text) => n + parseMoney(text), 0)

    // Guard: with every row unpriced this would be a vacuous 0 === 0. The
    // design-v2-done-priced fixture exists precisely so it is not.
    expect(summed).toBeGreaterThan(0)
    await expect(group.getByTestId('done-date-total')).toHaveText(`$${summed.toFixed(2)}`)
  })

  test('the header uses the design\'s type and spacing', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const header = groupOf(page, PRICED_SLUG).locator('.date-group-header')
    expect(await cssOf(header, 'align-items')).toBe('baseline')
    expect(await cssOf(header, 'padding-bottom')).toBe('9px')

    const label = header.getByTestId('done-date-label')
    expect(await cssOf(label, 'font-size')).toBe('13px')
    expect(await cssOf(label, 'font-weight')).toBe('700')
    expect(await cssOf(label, 'color')).toBe(TOKEN.text2)

    const total = header.getByTestId('done-date-total')
    expect(await cssOf(total, 'font-size')).toBe('11.5px')
    expect(await cssOf(total, 'font-family')).toContain('JetBrains Mono')
    expect(await cssOf(total, 'color')).toBe(TOKEN.text3)
  })
})

test.describe('backlog rows', () => {
  test('a row uses the design\'s padding, gap and date column', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    const row = page.getByTestId('backlog-card').first()
    expect(await cssOf(row, 'padding-top')).toBe('15px')
    expect(await cssOf(row, 'padding-left')).toBe('18px')
    expect(await cssOf(row, 'column-gap')).toBe('14px')

    // The design pins the date to a 64px column so every title starts at the
    // same x regardless of how wide the date happens to render.
    const date = row.getByTestId('backlog-row-date')
    expect(await cssOf(date, 'width')).toBe('64px')
    expect(await cssOf(date, 'font-family')).toContain('JetBrains Mono')
  })

  test('the run button carries the design\'s accent-soft treatment', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    const run = page.getByTestId('backlog-play-btn').first()
    expect(await cssOf(run, 'background-color')).toBe(TOKEN.accentSoft)
    expect(await cssOf(run, 'color')).toBe(TOKEN.accent)
    expect(await cssOf(run, 'border-radius')).toBe('9px')
    expect(await cssOf(run, 'font-weight')).toBe('700')
  })

  test('the unchecked select mark is a border2 ring, and checking it fills accent', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    const box = page.getByTestId('backlog-select-checkbox').first()
    expect(await cssOf(box, 'width')).toBe('18px')
    expect(await cssOf(box, 'border-radius')).toBe('999px')
    expect(await cssOf(box, 'border-top-color')).toBe(TOKEN.border2)

    await box.check()
    expect(await cssOf(box, 'background-color')).toBe(TOKEN.accent)
    expect(await cssOf(box, 'border-top-color')).toBe(TOKEN.accent)
  })
})

test.describe('backlog batch bar', () => {
  test('selecting a row reveals the design\'s sticky batch bar', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    await page.getByTestId('backlog-select-checkbox').first().check()
    const bar = page.getByTestId('backlog-batch-bar')
    await expect(bar).toBeVisible()

    expect(await cssOf(bar, 'position')).toBe('sticky')
    expect(await cssOf(bar, 'border-radius')).toBe('14px')
    expect(await cssOf(bar, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(bar, 'border-top-color')).toBe(TOKEN.border2)
  })

  // The design's own label is "Run batch (N)". This repo said "Run selected
  // (N)"; the testid is unchanged so nothing else has to move.
  test('the batch button reads Run batch with its count', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    await page.getByTestId('backlog-select-checkbox').first().check()
    await expect(page.getByTestId('backlog-run-selected-btn')).toHaveText(/^Run batch \(1\)$/)
    await expect(page.getByTestId('backlog-selected-count')).toHaveText('1 selected')
  })
})

// The heatmap moved to the You tab (see e2e/you-tab.spec.ts) — it was never a
// Done-tab concern. These three cases still own the design's own visual
// constants for the card, so they stay here and only change which tab they
// open.
test.describe('work density heatmap', () => {
  test('the card uses the design\'s radius, padding and top margin', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    const wrap = page.locator('.work-density')
    expect(await cssOf(wrap, 'margin-top')).toBe('44px')

    const card = page.locator('.work-density-card')
    expect(await cssOf(card, 'border-radius')).toBe('16px')
    expect(await cssOf(card, 'padding-top')).toBe('18px')
    expect(await cssOf(card, 'background-color')).toBe(TOKEN.surface)
  })

  // The month strip is offset by exactly the day-label column's width plus
  // the body gap (28px + 6px) so a month label sits over its own weeks. Off
  // by that much and every label points at the wrong column.
  test('the month strip clears the day-label column', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    expect(await cssOf(page.locator('.work-density-months'), 'margin-left')).toBe('34px')
    expect(await cssOf(page.locator('.work-density-daylabels'), 'width')).toBe('28px')
  })

  test('the legend shows five 11px swatches between less and more', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    const legend = page.locator('.work-density-legend')
    const swatches = legend.locator('.work-density-swatch')
    await expect(swatches).toHaveCount(5)
    expect(await cssOf(swatches.first(), 'width')).toBe('11px')
    expect(await cssOf(swatches.first(), 'border-radius')).toBe('2px')
    // Level 0 is the only one with a visible outline, so every cell keeps the
    // same box size across levels (the design's own `cellBorder`).
    expect(await cssOf(swatches.first(), 'border-top-color')).toBe(TOKEN.border)
  })
})
