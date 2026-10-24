import { test, expect, type Locator, type Page } from '@playwright/test'
import { DESKTOP, TOKEN } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'
import { gotoBoardTab } from './fixtures/boardTabs'

// dashboard-v4-table-design-alignment: the measurable layout facts of the
// Active table and the frame, as measured from Pipelinely Dashboard v4's
// rendered DOM (tasks/dashboard-v4-table-design-alignment/DESIGN_DIFF.md).
// Widths are the design's fixed grid tracks at DESKTOP; Task and State are
// the two flexible columns.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const VIEW_STORAGE_KEY = 'cockpit-active-view'
const NEEDS = ['dev-ready', 'cr-fixes-ready', 'card-merge-ready']
const WORKING = ['board-metrics', 'filters-api-idle']
const PATCHES: Record<string, Record<string, unknown>> = {
  'dev-ready': { contextPct: 41 },
  'cr-fixes-ready': { contextPct: 74, prNumber: '18' },
  'card-merge-ready': { contextPct: 18 },
  'board-metrics': { status: 'working', attentionStatus: 'working', stage: 'qa', contextPct: 37, prNumber: '19' },
  'filters-api-idle': { status: 'working', attentionStatus: 'working', contextPct: 52 },
}
// The design's fixed tracks (`tableGroups.cols`), in px.
const FIXED_TRACKS_PX = { project: 92, stage: 110, ctx: 104, next: 140, actions: 56 }
const WORKING_FIXED_TRACKS_PX = { project: 92, stage: 110, ctx: 104, actions: 56 }
// Task and State share the leftover width 1.5 : 2 on Working, once both are past their minimums.
const WORKING_STATE_TO_TASK_RATIO = 2 / 1.5
const WIDE = { width: 1600, height: 900 }
const RATIO_TOLERANCE = 0.02
// The design's Needs-you min-width; at DESKTOP the 14px past its tracks goes to State (220/92/110/194/104/140/56).
const NEEDS_MIN_WIDTH_PX = 1060
const NEEDS_STATE_AT_DESKTOP_PX = 194
const VIEW_SWITCH_PX = { width: 70, height: 34 }
const ICON_PX = 14
const NAV_COUNT_WIDTH_PX = 36
const TASK_MIN_PX = 220
const STATE_MIN_PX = 180
const COLUMN_GAP_PX = 18
const ROW_PAD_Y_PX = 14
const TABLE_RADIUS = '16px'
const PX_TOLERANCE = 1

const needsTable = (page: Page) => page.getByTestId('active-table-needs')
const workingTable = (page: Page) => page.getByTestId('active-table-working')
const row = (page: Page, slug: string) => page.locator(`[data-testid="table-row"][data-slug="${slug}"]`)
const widthOf = async (locator: Locator) => (await locator.boundingBox())!.width
const centreYOf = async (locator: Locator) => { const box = (await locator.boundingBox())!; return box.y + box.height / 2 }
const style = (locator: Locator, property: string) => locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property)

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, 'table'), VIEW_STORAGE_KEY)
  await page.goto('/')
  await expect(needsTable(page)).toBeVisible()
  await freezeLiveFeed(page)
  await pushSnapshot(page, { onlySlugs: [...NEEDS, ...WORKING], taskPatches: PATCHES })
  await expect(row(page, 'filters-api-idle')).toBeVisible()
})

test.describe('column widths', () => {
  test('the Needs-you fixed columns are the design tracks, and Task and State keep their minimums', async ({ page }) => {
    const table = needsTable(page)
    for (const [key, px] of Object.entries(FIXED_TRACKS_PX)) {
      expect(Math.abs(await widthOf(table.getByTestId(`table-col-${key}`)) - px), key).toBeLessThanOrEqual(PX_TOLERANCE)
    }
    expect(await widthOf(table.getByTestId('table-col-task'))).toBeGreaterThanOrEqual(TASK_MIN_PX - PX_TOLERANCE)
    expect(await widthOf(table.getByTestId('table-col-state'))).toBeGreaterThanOrEqual(STATE_MIN_PX - PX_TOLERANCE)
  })

  test("Working has no Next column, so its State column is wider than Needs you's", async ({ page }) => {
    await expect(workingTable(page).getByTestId('table-col-next')).toHaveCount(0)
    const needsState = await widthOf(needsTable(page).getByTestId('table-col-state'))
    const workingState = await widthOf(workingTable(page).getByTestId('table-col-state'))
    expect(workingState).toBeGreaterThan(needsState)
  })

  test("Needs you keeps the design's 1060px floor, so State gets the design's 194px", async ({ page }) => {
    const table = needsTable(page)
    expect(await style(table, 'min-width')).toBe(`${NEEDS_MIN_WIDTH_PX}px`)
    expect(Math.abs(await widthOf(table.getByTestId('table-col-state')) - NEEDS_STATE_AT_DESKTOP_PX)).toBeLessThanOrEqual(PX_TOLERANCE)
  })

  test('the Working fixed columns are the design tracks too', async ({ page }) => {
    const table = workingTable(page)
    for (const [key, px] of Object.entries(WORKING_FIXED_TRACKS_PX)) {
      expect(Math.abs(await widthOf(table.getByTestId(`table-col-${key}`)) - px), key).toBeLessThanOrEqual(PX_TOLERANCE)
    }
  })

  test("on a wide window Working's State takes 2 shares to Task's 1.5", async ({ page }) => {
    await page.setViewportSize(WIDE)
    const table = workingTable(page)
    const task = await widthOf(table.getByTestId('table-col-task'))
    const state = await widthOf(table.getByTestId('table-col-state'))
    expect(task).toBeGreaterThan(TASK_MIN_PX)
    expect(Math.abs(state / task - WORKING_STATE_TO_TASK_RATIO)).toBeLessThanOrEqual(RATIO_TOLERANCE)
  })

  test('every body cell sits under its header, 18px apart', async ({ page }) => {
    const table = needsTable(page)
    const header = await table.getByTestId('table-col-project').boundingBox()
    const cell = await row(page, 'dev-ready').getByTestId('table-cell-project').boundingBox()
    expect(Math.abs(cell!.x - header!.x)).toBeLessThanOrEqual(PX_TOLERANCE)
    const task = await table.getByTestId('table-col-task').boundingBox()
    expect(Math.abs(header!.x - (task!.x + task!.width) - COLUMN_GAP_PX)).toBeLessThanOrEqual(PX_TOLERANCE)
  })
})

test.describe('header and rows', () => {
  test('the header is a surface2 band and the table box is rounded 16px', async ({ page }) => {
    const header = needsTable(page).getByTestId('table-header-row')
    expect(await style(header, 'background-color')).toBe(TOKEN.surface2)
    expect(await style(header, 'text-transform')).toBe('uppercase')
    const scroller = page.getByTestId('active-table-scroll').first()
    expect(await style(scroller, 'border-top-left-radius')).toBe(TABLE_RADIUS)
  })

  test('cells are centred vertically in their row, with 14px of row padding', async ({ page }) => {
    const target = row(page, 'dev-ready')
    expect(await style(target, 'padding-top')).toBe(`${ROW_PAD_Y_PX}px`)
    const rowCentre = await centreYOf(target)
    for (const key of ['project', 'stage']) {
      expect(Math.abs(await centreYOf(target.getByTestId(`table-cell-${key}`)) - rowCentre), key).toBeLessThanOrEqual(PX_TOLERANCE)
    }
  })

  test('the first row has no divider above it; the next one does', async ({ page }) => {
    const rows = needsTable(page).getByTestId('table-row')
    const first = needsTable(page).locator('[data-testid="table-row"][aria-rowindex="2"]')
    const second = needsTable(page).locator('[data-testid="table-row"][aria-rowindex="3"]')
    await expect(rows).toHaveCount(NEEDS.length)
    expect(await style(first, 'border-top-color')).toBe('rgba(0, 0, 0, 0)')
    expect(await style(second, 'border-top-color')).toBe(TOKEN.border)
  })
})

test.describe('cell content', () => {
  test('the title is not underlined, and project and branch truncate on one line', async ({ page }) => {
    const target = row(page, 'cr-fixes-ready')
    expect(await style(target.getByTestId('card-title'), 'text-decoration-line')).toBe('none')
    const project = target.getByTestId('table-cell-project').locator(':scope > *')
    expect(await style(project, 'white-space')).toBe('nowrap')
    expect(await style(project, 'text-overflow')).toBe('ellipsis')
  })

  test('the Ctx cell has no per-row "ctx" label, and Handover sits under the bar', async ({ page }) => {
    const cell = row(page, 'cr-fixes-ready').getByTestId('table-cell-ctx')
    await expect(cell.getByTestId('card-ctx-label')).toHaveCount(0)
    const handover = await cell.getByTestId('row-handover').boundingBox()
    const bar = await cell.getByTestId('row-ctx-meter').boundingBox()
    expect(handover!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height)
  })

  test("a hot row's ctx track stays surface2; only the fill and the value change", async ({ page }) => {
    const track = row(page, 'cr-fixes-ready').getByTestId('row-ctx-meter').locator(':scope > :first-child')
    expect(await style(track, 'background-color')).toBe(TOKEN.surface2)
  })

  test('the Next button fills its column and the text link is centred under it', async ({ page }) => {
    const cell = row(page, 'cr-fixes-ready').getByTestId('table-cell-next')
    const button = await cell.getByTestId('row-cta-btn').boundingBox()
    expect(Math.abs(button!.width - FIXED_TRACKS_PX.next)).toBeLessThanOrEqual(PX_TOLERANCE)
    const link = await cell.getByTestId('row-cta-link').boundingBox()
    expect(Math.abs((link!.x + link!.width / 2) - (button!.x + button!.width / 2))).toBeLessThanOrEqual(PX_TOLERANCE)
  })
})

test.describe('frame', () => {
  test('the spend pill comes before the orchestrator ctx pill', async ({ page }) => {
    const spend = await page.getByTestId('header-spend').boundingBox()
    const ctx = await page.getByTestId('header-ctx').boundingBox()
    expect(spend!.x + spend!.width).toBeLessThan(ctx!.x)
  })

  test('the main column carries the washes and the dot grid', async ({ page }) => {
    const main = page.getByTestId('app-main')
    expect(await style(main, 'background-image')).toContain('radial-gradient')
    expect(await style(main, 'background-size')).toContain('22px 22px')
  })
})

test.describe('group headings and card footers', () => {
  test('neither heading carries creature art', async ({ page }) => {
    for (const group of ['active-group-needs', 'active-group-working']) {
      const heading = page.getByTestId(group).getByTestId('active-group-header')
      expect(await heading.evaluate((el) => el.querySelector('[style*="background-image"]'))).toBeNull()
    }
  })

  test("a card's Read plan and Triage comments lead with their icons", async ({ page }) => {
    await page.getByTestId('active-view-cards').click()
    const card = (slug: string) => page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
    await expect(card('dev-ready').getByTestId('card-cta-secondary').getByTestId('read-plan-icon')).toBeVisible()
    await expect(card('cr-fixes-ready').getByTestId('card-cta-secondary').getByTestId('triage-comments-icon')).toBeVisible()
  })
})

test.describe('backlog rows', () => {
  test('the date is the short form, with the full date on hover', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')
    const date = page.getByTestId('backlog-row-date').first()
    await expect(date).toHaveText(/^[A-Z][a-z]{2} \d{2}$/)
    await expect(date).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2}$/)
  })

  test('edit and delete are borderless until hovered', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')
    const edit = page.getByTestId('backlog-edit-btn').first()
    expect(await style(edit, 'border-top-color')).toBe('rgba(0, 0, 0, 0)')
    expect(await style(edit, 'background-color')).toBe('rgba(0, 0, 0, 0)')
    await edit.hover()
    await expect.poll(() => style(edit, 'background-color')).toBe(TOKEN.surface2)
  })
})

test.describe('toolbar and sidebar', () => {
  test('the card/table switch is a 70x34 pill of two 14px icons', async ({ page }) => {
    const box = (await page.getByTestId('active-view-switch').boundingBox())!
    expect(Math.abs(box.width - VIEW_SWITCH_PX.width)).toBeLessThanOrEqual(PX_TOLERANCE)
    expect(Math.abs(box.height - VIEW_SWITCH_PX.height)).toBeLessThanOrEqual(PX_TOLERANCE)
    for (const icon of ['cards-view-icon', 'table-view-icon']) {
      const iconBox = (await page.getByTestId(icon).boundingBox())!
      expect(iconBox.width, icon).toBe(ICON_PX)
    }
  })

  test('the active tab reads 700 and every count pill is 36px wide', async ({ page }) => {
    expect(await style(page.getByTestId('tab-label-inprogress'), 'font-weight')).toBe('700')
    expect(await style(page.getByTestId('tab-label-done'), 'font-weight')).toBe('600')
    for (const tab of ['inprogress', 'done', 'backlog']) {
      expect(Math.abs(await widthOf(page.getByTestId(`tab-count-${tab}`)) - NAV_COUNT_WIDTH_PX), tab).toBeLessThanOrEqual(PX_TOLERANCE)
    }
  })
})
