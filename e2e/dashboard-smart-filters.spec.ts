import { test, expect, type Page } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { selectBoardTab } from './fixtures/boardTabs.js'

// Smart filters on the board: a Project filter, rendered as a row of chips
// whose options are DERIVED from the tasks currently on the board, never a
// fixed enum. It narrows both the Active sessions section and the Done
// section.
//
// Superseded by the Pipelinely Pipeline redesign: the pre-redesign State
// filter (a second chip row narrowing Active sessions by attentionStatus)
// has no equivalent in the design, which filters by project only — see
// TASK.md's own resolution of this exact conflict. The state-dimension
// cases this file used to carry were removed rather than adapted; there is
// no state filter left to test.
//
// Every option-set assertion here is written as INTERNAL CONSISTENCY —
// "the chip row offers exactly the repos the rendered rows declare" —
// rather than against a hardcoded fixture list, for the same two reasons
// board-redesign.spec.ts states: the fixture set grows every time another
// feature adds one, and a test that recomputed the expected set from
// /api/tasks would just be a second implementation of the thing under test.
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts). The
// five `filters-*` fixtures exist for this suite specifically: they put a
// second and third repo on the board (acme-api, acme-web), an
// acme-api task in each of two different attention states, an
// acme-api task in Done, and one task that declares no Repo: line at
// all.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, 'fixtures', 'tasks')

// Fixtures this suite reasons about by slug.
const ACME_REPO = 'acme-api'
const ACME_PAUSED_SLUG = 'filters-api-paused'
const ACME_IDLE_SLUG = 'filters-api-idle'
const ACME_DONE_SLUG = 'filters-api-done'
const NO_REPO_SLUG = 'filters-no-repo'

test.use({ colorScheme: 'light' })

// --- helpers ---------------------------------------------------------------

function chipRow(page: Page) {
  return page.getByTestId('filter-project-chips')
}

function projectChip(page: Page, value: string) {
  return page.getByTestId(`filter-chip-project-${value}`)
}

function activeCards(page: Page) {
  return page.locator('[data-testid="task-card"]')
}

function doneRows(page: Page) {
  return page.locator('[data-testid="done-row"]')
}

// The chip VALUES the project row offers. Values are the raw repo strings,
// never the display label — a filter that round-trips its own labels would
// be untestable without selecting by text content. No leading "all" chip to
// strip (D6 of the Claude Design v2 alignment): the row is multi-select
// toggles only, and an empty selection already means every project.
async function chipValues(row: ReturnType<typeof chipRow>): Promise<string[]> {
  return row.locator('.filter-chip').evaluateAll(
    (chips) => chips.map((chipEl) => (chipEl as HTMLElement).dataset.value ?? ''),
  )
}

// "No project chip is selected" — the multi-select equivalent of the old
// single-select "the 'all' chip is active" state (D6: there is no all chip,
// so an empty selection is read off the chip row itself instead).
async function noProjectSelected(row: ReturnType<typeof chipRow>): Promise<boolean> {
  return (await row.locator('.filter-chip.is-active').count()) === 0
}

// Every distinct non-empty value of `attribute` across the matched rows, in
// sorted order — the DOM's own answer to "what is actually on the board".
async function distinctAttribute(locator: ReturnType<typeof activeCards>, attribute: string): Promise<string[]> {
  const values = await locator.evaluateAll(
    (rows, attr) => rows.map((row) => row.getAttribute(attr) ?? ''),
    attribute,
  )
  return [...new Set(values.filter(Boolean))].sort()
}

// The project chip row is revealed by the toolbar's own "filter" toggle
// (hidden by default — see board-toolbar in public/index.html), so every
// case needs it opened before it can read or click a chip.
async function waitForBoard(page: Page) {
  await expect(activeCards(page).first()).toBeVisible()
  const row = page.getByTestId('board-filters')
  if (await row.isHidden()) await page.getByTestId('filter-toggle-btn').click()
  await expect(row).toBeVisible()
}

async function sectionCount(page: Page, section: 'inprogress' | 'done'): Promise<number> {
  const text = await page.getByTestId(`tab-count-${section}`).innerText()
  return Number(text.match(/\d+/)![0])
}

// --- option derivation -----------------------------------------------------

test.describe('smart filter options are derived, not enumerated', () => {
  test('the project filter offers exactly the union of board and backlog-declared repos', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    const activeRepos = await distinctAttribute(activeCards(page), 'data-repo')
    const doneRepos = await distinctAttribute(doneRows(page), 'data-repo')
    // A backlog item can declare its own project too (backlog-filter-project-field)
    // — offering a project only the backlog has ideas for is deliberate (D2):
    // it's the honest answer to "show me everything for this project."
    const backlogRepos = await distinctAttribute(page.locator('[data-testid="backlog-row"]'), 'data-project')
    const onBoard = [...new Set([...activeRepos, ...doneRepos, ...backlogRepos])].sort()

    expect(await chipValues(chipRow(page))).toEqual(onBoard)
  })

  test('a repo no task declares is not offered', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    const offered = await chipValues(chipRow(page))

    // Non-vacuous both ways: the fixtures really do put more than one repo
    // on the board, and a plausible repo name that no fixture declares is
    // really absent.
    expect(offered.length).toBeGreaterThan(1)
    expect(offered).toContain(ACME_REPO)
    expect(offered).not.toContain('a-repo-no-fixture-declares')
  })

  test('a task with no Repo: line contributes no blank project option and stays visible unfiltered', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    await expect(page.locator(`[data-testid="task-card"][data-slug="${NO_REPO_SLUG}"]`)).toBeVisible()

    const offered = await chipValues(chipRow(page))
    expect(offered.every((value) => value.trim().length > 0)).toBe(true)
  })
})

// --- filtering behaviour ---------------------------------------------------

test.describe('project filter', () => {
  test('selecting a project narrows the active board to that project only', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)
    const totalBefore = await activeCards(page).count()

    await projectChip(page, ACME_REPO).click()

    const visible = activeCards(page)
    await expect(visible).toHaveCount(2)
    expect(await visible.count()).toBeLessThan(totalBefore)
    expect(await distinctAttribute(visible, 'data-repo')).toEqual([ACME_REPO])
    await expect(page.locator(`[data-testid="task-card"][data-slug="${ACME_IDLE_SLUG}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="task-card"][data-slug="${ACME_PAUSED_SLUG}"]`)).toBeVisible()
  })

  test('selecting a project narrows the Done section too', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)
    const doneBefore = await doneRows(page).count()

    await projectChip(page, ACME_REPO).click()

    const visible = doneRows(page)
    await expect(visible).toHaveCount(1)
    expect(await visible.count()).toBeLessThan(doneBefore)
    expect(await distinctAttribute(visible, 'data-repo')).toEqual([ACME_REPO])

    // Done rows only enter the DOM's visible flow on the Done tab (the
    // filter bar itself sits above the tab bar, so the filter selected above
    // stays in effect across the switch).
    await selectBoardTab(page, 'done')
    await expect(page.locator(`[data-testid="done-row"][data-slug="${ACME_DONE_SLUG}"]`)).toBeVisible()
  })

  test('a task with no Repo: line is hidden once any project is selected', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    await projectChip(page, ACME_REPO).click()

    await expect(page.locator(`[data-testid="task-card"][data-slug="${NO_REPO_SLUG}"]`)).toHaveCount(0)
  })

  test('the section counts follow the project filter', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    await projectChip(page, ACME_REPO).click()

    expect(await sectionCount(page, 'inprogress')).toBe(await activeCards(page).count())
    expect(await sectionCount(page, 'done')).toBe(await doneRows(page).count())
  })

  test('the pulse chips follow the project filter', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    await projectChip(page, ACME_REPO).click()

    for (const [testid, selector] of [
      ['pulse-chip-waiting', '[data-status="needs-you"]'],
      // Working counts by raw lifecycle status, not attentionStatus — see
      // board-redesign.spec.ts's file header comment.
      ['pulse-chip-working', '[data-lifecycle-status="working"]:not([data-status="needs-you"])'],
    ]) {
      const cardCount = await page
        .locator(`[data-testid="task-card"]${selector}`)
        .count()
      const chipText = await page.getByTestId(testid).innerText()
      expect(Number(chipText.match(/\d+/)![0]), `${testid} should equal the visible ${selector} card count`).toBe(cardCount)
    }
  })

  // Note: the pre-redesign version of this suite combined project + state to
  // guarantee a non-vacuous empty intersection. With only the project
  // dimension left (state has no design equivalent — see this file's header
  // comment), every option the chip row itself offers is derived FROM at
  // least one visible card, so a project-only selection can never produce
  // the filtered-empty state; that path is exercised structurally, not
  // covered by an integration case here.

  test('Clear resets the chip row and restores every card', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)
    const totalBefore = await activeCards(page).count()
    const doneBefore = await doneRows(page).count()

    await projectChip(page, ACME_REPO).click()
    expect(await activeCards(page).count()).toBeLessThan(totalBefore)

    await page.getByTestId('filter-clear').click()

    await expect.poll(() => noProjectSelected(chipRow(page))).toBe(true)
    await expect(activeCards(page)).toHaveCount(totalBefore)
    await expect(doneRows(page)).toHaveCount(doneBefore)
    await expect(page.getByTestId('board-empty-state')).toHaveCount(0)
  })
})

// --- live task list changes ------------------------------------------------

// These mutate the shared fixture task dir, so they run serially against
// each other. Every other case in this file derives its expectations from
// the DOM at the instant it reads it, so a transient extra card cannot
// break them.
test.describe.serial('the option set tracks the live task list', () => {
  const TEMP_SLUG = 'filters-temp-transient'
  const TEMP_REPO = 'transient-fixture-repo'
  const tempDir = path.join(TASKS_DIR, TEMP_SLUG)

  async function createTempTask() {
    await fs.mkdir(tempDir, { recursive: true })
    await fs.writeFile(
      path.join(tempDir, 'TASK.md'),
      `# Transient fixture\n\n## Workspace\n- Repo: ${TEMP_REPO}\n- Branch: claude/${TEMP_SLUG}\n\n## Mode: implement\n`,
    )
    await fs.writeFile(path.join(tempDir, 'STATUS'), 'waiting: transient e2e fixture\n')
  }

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('a newly appearing repo becomes a project option without a reload', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)
    expect(await chipValues(chipRow(page))).not.toContain(TEMP_REPO)

    await createTempTask()

    await expect
      .poll(async () => chipValues(chipRow(page)), { timeout: 15_000 })
      .toContain(TEMP_REPO)
  })

  test('a selected project that disappears resets the filter instead of stranding an empty board', async ({ page }) => {
    await createTempTask()
    await page.goto('/')
    await waitForBoard(page)

    await expect
      .poll(async () => chipValues(chipRow(page)), { timeout: 15_000 })
      .toContain(TEMP_REPO)
    await projectChip(page, TEMP_REPO).click()
    await expect(activeCards(page)).toHaveCount(1)

    await fs.rm(tempDir, { recursive: true, force: true })

    await expect.poll(() => noProjectSelected(chipRow(page)), { timeout: 15_000 }).toBe(true)
    expect(await activeCards(page).count()).toBeGreaterThan(1)
    await expect(page.getByTestId('board-empty-state')).toHaveCount(0)
  })

  test('an active filter survives an SSE-driven re-render', async ({ page }) => {
    await page.goto('/')
    await waitForBoard(page)

    await projectChip(page, ACME_REPO).click()
    await expect(activeCards(page)).toHaveCount(2)

    // Any task-dir write rebroadcasts the whole task list, which re-runs
    // renderDashboard/renderDoneGroups from scratch.
    await createTempTask()
    await expect
      .poll(async () => chipValues(chipRow(page)), { timeout: 15_000 })
      .toContain(TEMP_REPO)

    await expect(projectChip(page, ACME_REPO)).toHaveClass(/is-active/)
    await expect(activeCards(page)).toHaveCount(2)
    expect(await distinctAttribute(activeCards(page), 'data-repo')).toEqual([ACME_REPO])
  })
})
