import { test, expect, type Page, type Route } from '@playwright/test'
import { DESKTOP } from './fixtures/designTokens'
import { collectPageErrors, freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'
import { PUSHED_APPROVAL_BUTTON_COUNT, PUSHED_APPROVAL_PROMPT } from './fixtures/approvalPrompts'
import { gotoBoardTab } from './fixtures/boardTabs'

// dashboard-v3-update M4 — the Active table view and the card/table switch
// (REQUEST-v3-full.md §1 "card/table switch" and §4; Pipelinely Dashboard
// v3.dc.html `tableGroups` / `sortRows` / `tableRowsFor` / `viewModes`). Two
// tables (Needs you, Working) share one tri-state sort; action clicks never
// open the row; the ⋯ menu escapes the scroll container. The view choice is
// a per-browser preference in localStorage (QUESTIONS.md #10). Committed red,
// tagged; M4's dev stage removes the tags once green.
//
// Every row of both tables is in the DOM and the page does the scrolling (the
// tables used to virtualize their rows inside a capped scroller). The
// large-board cases build their rows with pushSnapshot's cloneTasks, never
// real fixture tasks.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const VIEW_STORAGE_KEY = 'cockpit-active-view'
const needsTable = (page: Page) => page.getByTestId('active-table-needs')
const workingTable = (page: Page) => page.getByTestId('active-table-working')
const row = (page: Page, slug: string) => page.locator(`[data-testid="table-row"][data-slug="${slug}"]`)
const col = (table: ReturnType<typeof needsTable>, key: string) => table.getByTestId(`table-col-${key}`)
const scrollerOf = (table: ReturnType<typeof needsTable>) => table.locator('xpath=ancestor::*[@data-testid="active-table-scroll"][1]')
// The slugs of the rows in the DOM, in row order.
const slugsIn = (table: ReturnType<typeof needsTable>) =>
  table.getByTestId('table-row').evaluateAll((rows) =>
    rows
      .map((r) => ({ slug: r.getAttribute('data-slug'), index: Number(r.getAttribute('aria-rowindex')) }))
      .sort((a, b) => a.index - b.index)
      .map((r) => r.slug))
// aria-rowcount counts the header row too (WAI-ARIA), so the body has one fewer.
const bodyRowCount = async (table: ReturnType<typeof needsTable>) => Number(await table.getAttribute('aria-rowcount')) - 1
const renderedRowCount = (table: ReturnType<typeof needsTable>) => table.getByTestId('table-row').count()
// The small tables must render every row, or the order assertions below would
// compare a slice. Proved once per table, against aria-rowcount.
async function expectFullyRendered(table: ReturnType<typeof needsTable>) {
  expect(await renderedRowCount(table)).toBe(await bodyRowCount(table))
}

// Fixed membership, so sort order assertions don't drift as fixtures are added.
const NEEDS = ['dev-ready', 'cr-fixes-ready', 'merge-ready']
const WORKING = ['board-metrics', 'filters-api-idle']

const SMALL_BOARD_PATCHES: Record<string, Record<string, unknown>> = {
  'dev-ready': { contextPct: 41 },
  'cr-fixes-ready': { contextPct: 74, prNumber: '42' },
  'merge-ready': { contextPct: 9 },
  'board-metrics': { status: 'working', attentionStatus: 'working', stage: 'qa', contextPct: 66 },
  'filters-api-idle': { status: 'working', attentionStatus: 'working', stage: 'dev', contextPct: 12 },
}

async function openTable(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, 'table'), VIEW_STORAGE_KEY)
  await page.goto('/')
  await expect(needsTable(page)).toBeVisible()
  await freezeLiveFeed(page)
  await pushSnapshot(page, { onlySlugs: [...NEEDS, ...WORKING], taskPatches: SMALL_BOARD_PATCHES })
  await expect(row(page, 'filters-api-idle')).toBeVisible()
  await expectFullyRendered(needsTable(page))
  await expectFullyRendered(workingTable(page))
}

// Swallows every action POST, so a CTA or menu click under test never
// reaches the fixture server's dispatch/focus routes.
async function stubActionPosts(page: Page) {
  await page.route('**/*', (route: Route) =>
    route.request().method() === 'POST' && !route.request().url().includes('/api/')
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      : route.fallback(),
  )
}

test.describe('card/table switch', () => {
  test('sits on Active only, defaults to cards, and switches to two tables with the group headings', async ({ page }) => {
    await page.goto('/')
    const toggle = page.getByTestId('active-view-switch')
    await expect(toggle).toBeVisible()
    await expect(page.getByTestId('active-view-cards')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('task-card').first()).toBeVisible()

    await page.getByTestId('active-view-table').click()
    await expect(page.getByTestId('active-view-table')).toHaveAttribute('aria-pressed', 'true')
    await expect(needsTable(page)).toBeVisible()
    await expect(page.getByTestId('task-card')).toHaveCount(0)
    // Same heading and count as the card groups.
    await expect(page.getByTestId('active-group-needs').getByTestId('active-group-count')).toBeVisible()
    await expect(page.getByTestId('active-group-working').getByTestId('active-group-count')).toBeVisible()

    await gotoBoardTab(page, 'done')
    await expect(page.getByTestId('active-view-switch')).toBeHidden()
  })

  test('the choice survives a reload, in both directions', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('active-view-table').click()
    await page.reload()
    await expect(needsTable(page)).toBeVisible()
    expect(await page.evaluate((key) => localStorage.getItem(key), VIEW_STORAGE_KEY)).toBe('table')

    await page.getByTestId('active-view-cards').click()
    await page.reload()
    await expect(page.getByTestId('task-card').first()).toBeVisible()
    await expect(needsTable(page)).toHaveCount(0)
  })

  test('blocked storage still switches the view for this page, without an error', async ({ page }) => {
    const errors = collectPageErrors(page)
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError') }
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError') }
    })
    await page.goto('/')
    await expect(page.getByTestId('active-view-cards')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('active-view-table').click()
    await expect(needsTable(page)).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('columns', () => {
  test('Needs you has Task, Project, Stage, State, Ctx, Next and actions; Working has no Next', async ({ page }) => {
    await openTable(page)
    const keysOf = (table: ReturnType<typeof needsTable>) =>
      table.locator('[data-testid^="table-col-"]').evaluateAll((cells) => cells.map((c) => c.getAttribute('data-testid')))
    expect(await keysOf(needsTable(page))).toEqual(['table-col-task', 'table-col-project', 'table-col-stage', 'table-col-state', 'table-col-ctx', 'table-col-next', 'table-col-actions'])
    expect(await keysOf(workingTable(page))).toEqual(['table-col-task', 'table-col-project', 'table-col-stage', 'table-col-state', 'table-col-ctx', 'table-col-actions'])
  })

  test('rows carry no mini rail and there is no Updated column', async ({ page }) => {
    await openTable(page)
    await expect(page.getByTestId('active-tables').getByTestId('mini-stage-node')).toHaveCount(0)
    await expect(page.getByTestId('table-col-updated')).toHaveCount(0)
  })

  test('the Task cell holds the creature with its name under it, the title link, and the branch with a copy button', async ({ page }) => {
    await openTable(page)
    const task = row(page, 'cr-fixes-ready').getByTestId('table-cell-task')
    const creature = task.getByTestId('creature')
    const name = task.getByTestId('row-creature-name')
    await expect(creature).toBeVisible()
    await expect(name).toHaveCSS('font-size', '10.5px')
    await expect(name).toHaveCSS('width', '40px')
    await expect(name).toHaveCSS('text-overflow', 'ellipsis')
    const [creatureBox, nameBox] = await Promise.all([creature.boundingBox(), name.boundingBox()])
    expect(nameBox!.y).toBeGreaterThan(creatureBox!.y + creatureBox!.height - 1)
    await expect(task.getByTestId('card-title')).toHaveAttribute('href', '/task/cr-fixes-ready')
    await expect(task.getByTestId('card-copy-btn')).toBeVisible()
  })

  test('State: Needs you shows the summary with a bold head; Working reads "Agent is running <stage>"', async ({ page }) => {
    await openTable(page)
    const needsState = row(page, 'cr-fixes-ready').getByTestId('table-cell-state')
    await expect(needsState.getByTestId('table-state-head')).toHaveCSS('font-weight', '700')
    await expect(row(page, 'board-metrics').getByTestId('table-cell-state')).toHaveAttribute('data-running-stage', 'qa')
    await expect(row(page, 'board-metrics').getByTestId('table-state-head')).toHaveCount(0)
  })

  test('Ctx: a bar and %, with Handover only above 60%', async ({ page }) => {
    await openTable(page)
    await expect(row(page, 'cr-fixes-ready').getByTestId('table-cell-ctx').getByTestId('row-handover')).toBeVisible()
    await expect(row(page, 'dev-ready').getByTestId('table-cell-ctx').getByTestId('row-handover')).toHaveCount(0)
  })

  test('Next: the main button with its secondary actions as text links under it', async ({ page }) => {
    await openTable(page)
    const next = row(page, 'dev-ready').getByTestId('table-cell-next')
    await expect(next.getByTestId('row-cta-btn')).toBeVisible()
    await expect(next.getByTestId('row-cta-link')).toHaveAttribute('data-action', 'read-plan')
    const merge = row(page, 'merge-ready').getByTestId('table-cell-next')
    await expect(merge.getByTestId('row-cta-link')).toHaveAttribute('data-action', 'open-pr')
  })

  test('actions: terminal and ⋯, with the GitHub #<n> link under them only when there is a PR', async ({ page }) => {
    await openTable(page)
    const withPr = row(page, 'cr-fixes-ready').getByTestId('table-cell-actions')
    await expect(withPr.getByTestId('card-menu-btn')).toBeVisible()
    await expect(withPr.getByTestId('card-pr-link')).toHaveAttribute('data-pr', '42')
    await expect(row(page, 'dev-ready').getByTestId('table-cell-actions').getByTestId('card-pr-link')).toHaveCount(0)
  })
})

test.describe('row clicks', () => {
  test('clicking a row opens the task, and Back returns to Active in table view', async ({ page }) => {
    await openTable(page)
    await row(page, 'dev-ready').getByTestId('table-cell-project').click()
    await expect(page).toHaveURL(/\/task\/dev-ready/)
    await page.getByTestId('detail-close').click()
    await expect(page).toHaveURL('/')
    await expect(needsTable(page)).toBeVisible()
  })

  for (const [label, locate] of [
    ['the copy button', (p: Page) => row(p, 'dev-ready').getByTestId('card-copy-btn')],
    ['the ⋯ menu button', (p: Page) => row(p, 'dev-ready').getByTestId('card-menu-btn')],
    ['the main CTA', (p: Page) => row(p, 'dev-ready').getByTestId('row-cta-btn')],
    ['a secondary link', (p: Page) => row(p, 'merge-ready').getByTestId('row-cta-link')],
    ['the PR link', (p: Page) => row(p, 'cr-fixes-ready').getByTestId('card-pr-link')],
    ['Handover', (p: Page) => row(p, 'cr-fixes-ready').getByTestId('row-handover')],
  ] as const) {
    test(`${label} does not also open the row`, async ({ page }) => {
      await stubActionPosts(page)
      await openTable(page)
      await locate(page).click()
      await expect(page.getByTestId('task-detail')).toBeHidden()
      await expect(page).toHaveURL('/')
    })
  }
})

// Master's blocked-worker approval callout (#140-#142). A worker stopped on a
// Claude Code dialog is needs-you, so its row is in the Needs you table; the
// table must not hide the dialog or its answer buttons from someone who works
// in table view (QUESTIONS.md #28). Pushed, not polled, as in the card spec.
const BLOCKED_WORKER_PATCH = { status: 'working', attentionStatus: 'needs-you', stage: 'qa', waitingReason: '', approvalPrompt: PUSHED_APPROVAL_PROMPT }

async function blockBoardMetrics(page: Page) {
  await pushSnapshot(page, {
    onlySlugs: [...NEEDS, ...WORKING],
    taskPatches: { ...SMALL_BOARD_PATCHES, 'board-metrics': { ...SMALL_BOARD_PATCHES['board-metrics'], ...BLOCKED_WORKER_PATCH } },
  })
  await expect(needsTable(page).locator('[data-testid="table-row"][data-slug="board-metrics"]')).toBeVisible()
}

test.describe('blocked workers in the table', () => {
  test('a worker stopped on a dialog is a Needs you row whose State cell carries the approval callout and its answer buttons, with no Next CTA', async ({ page }) => {
    await openTable(page)
    await blockBoardMetrics(page)
    await expect(workingTable(page).locator('[data-testid="table-row"][data-slug="board-metrics"]')).toHaveCount(0)
    const state = row(page, 'board-metrics').getByTestId('table-cell-state')
    await expect(state.getByTestId('card-approval')).toBeVisible()
    await expect(state.getByTestId('card-approval-option')).toHaveCount(PUSHED_APPROVAL_BUTTON_COUNT)
    // Its session is running: a Start/Run CTA would dispatch a second one.
    await expect(row(page, 'board-metrics').getByTestId('row-cta-btn')).toHaveCount(0)
    await expect(row(page, 'board-metrics').getByTestId('table-cell-actions').getByTestId('focus-btn')).toBeVisible()
  })

  test('an answer button does not also open the row', async ({ page }) => {
    await stubActionPosts(page)
    await openTable(page)
    await blockBoardMetrics(page)
    await row(page, 'board-metrics').getByTestId('card-approval-option').last().click()
    await expect(page.getByTestId('task-detail')).toBeHidden()
    await expect(page).toHaveURL('/')
  })
})

test.describe('sorting', () => {
  test('a header cycles ascending ▲, descending ▼, then back to the original order', async ({ page }) => {
    await openTable(page)
    const original = await slugsIn(needsTable(page))
    const header = col(needsTable(page), 'task')

    await header.click()
    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(header.getByTestId('table-sort-arrow')).toHaveText('▲')
    const asc = await slugsIn(needsTable(page))

    await header.click()
    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(header.getByTestId('table-sort-arrow')).toHaveText('▼')
    expect(await slugsIn(needsTable(page))).toEqual([...asc].reverse())

    await header.click()
    await expect(header).toHaveAttribute('aria-sort', 'none')
    await expect(header.getByTestId('table-sort-arrow')).toHaveCount(0)
    expect(await slugsIn(needsTable(page))).toEqual(original)
  })

  test('the sort is shared by both tables', async ({ page }) => {
    await openTable(page)
    await col(needsTable(page), 'ctx').click()
    await expect(col(workingTable(page), 'ctx')).toHaveAttribute('aria-sort', 'ascending')
    expect(await slugsIn(workingTable(page))).toEqual(['filters-api-idle', 'board-metrics'])
  })

  test('Ctx sorts numerically', async ({ page }) => {
    await openTable(page)
    await col(needsTable(page), 'ctx').click()
    expect(await slugsIn(needsTable(page))).toEqual(['merge-ready', 'dev-ready', 'cr-fixes-ready'])
  })

  test('Stage sorts in pipeline order, not alphabetically', async ({ page }) => {
    await openTable(page)
    await col(workingTable(page), 'stage').click()
    // dev before qa in the pipeline (alphabetical would agree here, so Needs you checks the real difference).
    expect(await slugsIn(workingTable(page))).toEqual(['filters-api-idle', 'board-metrics'])
    await pushSnapshot(page, {
      onlySlugs: [...NEEDS, ...WORKING],
      taskPatches: {
        'dev-ready': { stage: 'merge' },
        'cr-fixes-ready': { stage: 'planning' },
        'merge-ready': { stage: 'dev' },
        'board-metrics': { status: 'working', attentionStatus: 'working', stage: 'qa' },
        'filters-api-idle': { status: 'working', attentionStatus: 'working', stage: 'dev' },
      },
    })
    expect(await slugsIn(needsTable(page))).toEqual(['cr-fixes-ready', 'merge-ready', 'dev-ready'])
  })

  test('the actions column is not sortable', async ({ page }) => {
    await openTable(page)
    const actions = col(needsTable(page), 'actions')
    await expect(actions).not.toHaveAttribute('aria-sort', /.+/)
    const before = await slugsIn(needsTable(page))
    await actions.click()
    expect(await slugsIn(needsTable(page))).toEqual(before)
  })
})

test.describe('long titles', () => {
  test('a 300-character title with no spaces wraps inside its Task cell instead of running over the next columns', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'table'), VIEW_STORAGE_KEY)
    await page.goto('/')
    await expect(needsTable(page)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { onlySlugs: [...NEEDS, ...WORKING], taskPatches: { ...SMALL_BOARD_PATCHES, 'dev-ready': { ...SMALL_BOARD_PATCHES['dev-ready'], title: 'x'.repeat(300) } } })
    const title = row(page, 'dev-ready').getByTestId('card-title')
    await expect(title).toBeVisible()
    const [titleBox, stateBox] = await Promise.all([title.boundingBox(), row(page, 'dev-ready').getByTestId('table-cell-state').boundingBox()])
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(stateBox!.x)
  })
})

test.describe('narrow windows', () => {
  test.use({ viewport: { width: 900, height: 800 } })

  test('each table scrolls sideways inside its own container, not the page', async ({ page }) => {
    await openTable(page)
    const scroller = page.getByTestId('active-table-scroll').first()
    const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeGreaterThan(0)
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(pageOverflow).toBeLessThanOrEqual(0)
  })

  test('the ⋯ menu opens fully visible and on top, not clipped by the scroll container', async ({ page }) => {
    await openTable(page)
    const scroller = page.getByTestId('active-table-scroll').first()
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth })
    await row(page, 'merge-ready').getByTestId('card-menu-btn').click()
    const menu = page.getByTestId('card-menu')
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    const isOnTop = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return !!hit?.closest('[data-testid="card-menu"]')
    }, { x: box.x + box.width / 2, y: box.y + box.height - 4 })
    expect(isOnTop).toBe(true)
  })
})

// ── A large board: every row renders and the page scrolls ──────────────────
// A board far larger than the fixture tree: BIG_NEEDS Needs-you clones of
// dev-ready and BIG_WORKING Working clones of board-metrics, built only in the
// pushed snapshot (pushSnapshot's cloneTasks). Titles sort the same way as
// slugs, so "sorted by Task" has a known first and last row. Every third
// Needs-you row gets a long, multi-sentence summary so row heights vary.
const BIG_NEEDS = 120
const BIG_WORKING = 80
const bigSlug = (group: 'needs' | 'working', i: number) => `virt-${group}-${String(i).padStart(3, '0')}`
const LONG_SUMMARY = 'Waiting on your review of the plan. The plan splits the work into four parts, adds a migration and a backfill, and changes two public routes, so it needs a careful read before dev starts.'

function bigBoardClones(extra: { from: string; slug: string; fields?: Record<string, unknown> }[] = []) {
  const needs = Array.from({ length: BIG_NEEDS }, (_, i) => ({
    from: 'dev-ready',
    slug: bigSlug('needs', i),
    fields: {
      title: `Virt needs ${String(i).padStart(3, '0')}`,
      contextPct: (i * 7) % 100,
      ...(i % 3 === 0 ? { waitingReason: LONG_SUMMARY } : {}),
    },
  }))
  const working = Array.from({ length: BIG_WORKING }, (_, i) => ({
    from: 'board-metrics',
    slug: bigSlug('working', i),
    fields: { title: `Virt working ${String(i).padStart(3, '0')}`, status: 'working', attentionStatus: 'working', stage: 'dev', contextPct: (i * 3) % 100 },
  }))
  return [...needs, ...working, ...extra]
}

async function openBigTable(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, 'table'), VIEW_STORAGE_KEY)
  await page.goto('/')
  await expect(needsTable(page)).toBeVisible()
  await freezeLiveFeed(page)
  await pushSnapshot(page, { onlySlugs: [], cloneTasks: bigBoardClones() })
  await expect(needsTable(page)).toHaveAttribute('aria-rowcount', String(BIG_NEEDS + 1))
  await expect(workingTable(page)).toHaveAttribute('aria-rowcount', String(BIG_WORKING + 1))
}

test.describe('no scrolling inside the panel', () => {
  test('every row of a large board is in the DOM, and the table carries its full height', async ({ page }) => {
    await openBigTable(page)
    expect(await renderedRowCount(needsTable(page))).toBe(BIG_NEEDS)
    expect(await renderedRowCount(workingTable(page))).toBe(BIG_WORKING)
  })

  test('a table scroller has no height cap and no scrollbar of its own, so the page scrolls', async ({ page }) => {
    await openBigTable(page)
    const scroller = scrollerOf(needsTable(page))
    expect(await scroller.evaluate((el) => getComputedStyle(el).maxHeight)).toBe('none')
    expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0)
    const pageScrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
    expect(pageScrollable).toBeGreaterThan(0)
  })

  test('sorting a large table orders the full data set, top and bottom', async ({ page }) => {
    await openBigTable(page)
    await col(needsTable(page), 'task').click()
    expect(await slugsIn(needsTable(page))).toEqual(Array.from({ length: BIG_NEEDS }, (_, i) => bigSlug('needs', i)))
    await col(needsTable(page), 'task').click()
    expect(await slugsIn(needsTable(page))).toEqual(Array.from({ length: BIG_NEEDS }, (_, i) => bigSlug('needs', BIG_NEEDS - 1 - i)))
  })

  test('a row reached by scrolling the page is clickable and opens the task', async ({ page }) => {
    await openBigTable(page)
    await col(needsTable(page), 'task').click()
    await row(page, bigSlug('needs', BIG_NEEDS - 1)).getByTestId('table-cell-project').click()
    await expect(page).toHaveURL(new RegExp(bigSlug('needs', BIG_NEEDS - 1)))
  })
})
