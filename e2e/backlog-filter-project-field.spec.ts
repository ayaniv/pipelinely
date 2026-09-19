import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { gotoBoardTab, selectBoardTab } from './fixtures/boardTabs.js'
import { BACKLOG_PATH, withBacklogFileLock, withRestoredBacklog } from './fixtures/backlogFile.js'
import { startCanonicalServer, stopCanonicalServer } from './fixtures/canonicalServer.js'

// The dashboard's project filter used to narrow Active and Done only —
// renderFilteredBoard re-rendered those two and never touched the Backlog
// panel, and a BacklogItem had no project to filter ON in the first place.
//
// This suite covers both halves of the fix:
//   1. a backlog item can DECLARE a project, written inline as a bracket
//      prefix on its checklist line: "- [ ] [cockpit-ai] Some idea (date)";
//   2. the project chips narrow the Backlog panel the same way they already
//      narrow Active and Done, and the chip row offers backlog-declared
//      projects as options in their own right.
//
// Fixture data lives in e2e/fixtures/tasks/BACKLOG.md (see
// playwright.config.ts), whose four committed items are shaped for exactly
// this suite: two projects that live tasks also declare (cockpit-ai,
// acme-api), one project ONLY the backlog declares (acme-clock), and
// one deliberately untagged item standing in for the ~40 real entries that
// predate the field.
//
// Two invariants here are worth naming, because they are what the
// implementation is most likely to get wrong:
//
// **Index addressing.** A backlog row's data-index is its line position in
// BACKLOG.md — the server rewrites by that index (POST /backlog/edit/:index,
// /dismiss/:index, /resume/:index). Filtering must hide rows WITHOUT
// renumbering them, or an edit made under an active filter silently rewrites
// a different item's line. "the play button under a filter dispatches its
// own row" below is the regression test for that.
//
// **Backward compatibility.** An untagged line must keep parsing exactly as
// it does today, with the project simply absent — never a blank chip option,
// and never a mangled description.
//
// No assertion selects by visible copy: rows are addressed by data-testid
// plus data-index / data-project, and the chip row by data-value.

const BOARD_PROJECT = 'cockpit-ai'        // declared by both live tasks and a backlog item
const SHARED_PROJECT = 'acme-api'      // ditto, second one
const BACKLOG_ONLY_PROJECT = 'acme-clock' // declared by a backlog item and nothing else

// File-order indices into the committed fixture BACKLOG.md above.
const COCKPIT_INDEX = 0
const OVERLAP_INDEX = 1
const BACKLOG_ONLY_INDEX = 2
const UNTAGGED_INDEX = 3

test.use({ colorScheme: 'light' })

// --- helpers ---------------------------------------------------------------

function chipRow(page: Page) {
  return page.getByTestId('filter-project-chips')
}

function projectChip(page: Page, value: string) {
  return page.getByTestId(`filter-chip-project-${value}`)
}

function backlogRows(page: Page) {
  return page.locator('[data-testid="backlog-row"]')
}

function backlogRow(page: Page, index: number) {
  return page.locator(`[data-testid="backlog-row"][data-index="${index}"]`)
}

function activeCards(page: Page) {
  return page.locator('[data-testid="task-card"]')
}

function doneRows(page: Page) {
  return page.locator('[data-testid="done-row"]')
}

// The chip VALUES the project row offers, read off the chips' own data-value
// rather than their labels — a filter that round-trips its own display copy
// would be untestable without selecting by text content.
async function chipValues(page: Page): Promise<string[]> {
  return chipRow(page).locator('.filter-chip').evaluateAll(
    (chips) => chips.map((chip) => (chip as HTMLElement).dataset.value ?? ''),
  )
}

// Every distinct non-empty value of `attribute` across the matched rows, in
// sorted order — the DOM's own answer to "what is actually rendered".
async function distinctAttribute(
  locator: ReturnType<typeof backlogRows>,
  attribute: string,
): Promise<string[]> {
  const values = await locator.evaluateAll(
    (rows, attr) => rows.map((row) => row.getAttribute(attr) ?? ''),
    attribute,
  )
  return [...new Set(values.filter(Boolean))].sort()
}

// The data-index of every currently rendered backlog row, in DOM order.
async function renderedIndices(page: Page): Promise<number[]> {
  return backlogRows(page).evaluateAll(
    (rows) => rows.map((row) => Number((row as HTMLElement).dataset.index)),
  )
}

// The chip row is behind the toolbar's own filter toggle (hidden by
// default), so every case that reads or clicks a chip has to open it first.
async function openFilters(page: Page): Promise<void> {
  const row = page.getByTestId('board-filters')
  if (await row.isHidden()) await page.getByTestId('filter-toggle-btn').click()
  await expect(row).toBeVisible()
}

async function backlogTabCount(page: Page): Promise<number> {
  const text = await page.getByTestId('tab-count-backlog').innerText()
  return Number(text.match(/\d+/)![0])
}

// Lands on the Backlog panel with the filter bar open — the starting state
// for nearly every case below. `origin` is '' for the shared
// (non-canonical) webServer's own baseURL, or a canonical test server's own
// absolute origin — see the single case below that clicks backlog-play-btn,
// one of canonical-dispatch-gate's proactively-disabled CTAs on a
// non-canonical instance.
async function openBacklogWithFilters(page: Page, origin = ''): Promise<void> {
  await gotoBoardTab(page, 'backlog', origin)
  await expect(backlogRows(page).first()).toBeVisible()
  await openFilters(page)
}

// --- the field itself ------------------------------------------------------

test.describe('a backlog item carries a project', () => {
  test('a tagged row exposes its project and an untagged row exposes none', async ({ page }) => {
    await openBacklogWithFilters(page)

    await expect(backlogRow(page, COCKPIT_INDEX)).toHaveAttribute('data-project', BOARD_PROJECT)
    await expect(backlogRow(page, OVERLAP_INDEX)).toHaveAttribute('data-project', SHARED_PROJECT)
    await expect(backlogRow(page, BACKLOG_ONLY_INDEX)).toHaveAttribute('data-project', BACKLOG_ONLY_PROJECT)

    // Absent, not empty: a blank data-project would become a blank chip
    // option the moment projectOptions reads it.
    expect(
      await backlogRow(page, UNTAGGED_INDEX).evaluate((row) => row.hasAttribute('data-project')),
    ).toBe(false)
  })

  test('a tagged row renders a visible project badge, an untagged row renders none', async ({ page }) => {
    await openBacklogWithFilters(page)

    await expect(backlogRow(page, COCKPIT_INDEX).getByTestId('backlog-row-project')).toHaveText(BOARD_PROJECT)
    await expect(backlogRow(page, OVERLAP_INDEX).getByTestId('backlog-row-project')).toHaveText(SHARED_PROJECT)
    await expect(backlogRow(page, BACKLOG_ONLY_INDEX).getByTestId('backlog-row-project')).toHaveText(BACKLOG_ONLY_PROJECT)

    // No placeholder/empty badge for an untagged item — the element itself
    // must not be rendered, not just rendered blank.
    await expect(backlogRow(page, UNTAGGED_INDEX).getByTestId('backlog-row-project')).toHaveCount(0)
  })

  test('the bracket tag is stripped from the rendered description', async ({ page }) => {
    await openBacklogWithFilters(page)

    // Backward compatibility, stated as a property rather than against the
    // fixture's copy: no rendered title may still be carrying its own tag.
    const titles = await page.getByTestId('backlog-row-title').allInnerTexts()
    expect(titles.length).toBe(4)
    for (const title of titles) expect(title.trim()).not.toMatch(/^\[/)
  })

  test('an untagged item still renders as a full, working row', async ({ page }) => {
    await openBacklogWithFilters(page)

    const row = backlogRow(page, UNTAGGED_INDEX)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('backlog-row-title')).not.toBeEmpty()
    await expect(row.getByTestId('backlog-row-date')).toHaveText('2026-08-20')
    await expect(row.getByTestId('backlog-play-btn')).toBeVisible()
    await expect(row.getByTestId('backlog-edit-btn')).toBeVisible()
  })
})

// --- option derivation -----------------------------------------------------

test.describe('chip options include backlog-declared projects', () => {
  test('the chip row offers exactly the union of board and backlog projects', async ({ page }) => {
    await page.goto('/')
    await expect(activeCards(page).first()).toBeVisible()
    await openFilters(page)

    const activeProjects = await distinctAttribute(activeCards(page), 'data-repo')
    const doneProjects = await distinctAttribute(doneRows(page), 'data-repo')

    await selectBoardTab(page, 'backlog')
    const backlogProjects = await distinctAttribute(backlogRows(page), 'data-project')

    const expected = [...new Set([...activeProjects, ...doneProjects, ...backlogProjects])].sort()
    expect(await chipValues(page)).toEqual(expected)
  })

  test('a project only the backlog declares is still offered', async ({ page }) => {
    await openBacklogWithFilters(page)

    // Non-vacuous: the project really is absent from every board row, and
    // really is present as a chip.
    expect(await distinctAttribute(activeCards(page), 'data-repo')).not.toContain(BACKLOG_ONLY_PROJECT)
    expect(await chipValues(page)).toContain(BACKLOG_ONLY_PROJECT)
  })

  test('an untagged item contributes no blank chip option', async ({ page }) => {
    await openBacklogWithFilters(page)

    const offered = await chipValues(page)
    expect(offered.length).toBeGreaterThan(1)
    expect(offered.every((value) => value.trim().length > 0)).toBe(true)
  })
})

// --- filtering the Backlog panel -------------------------------------------

test.describe('the project filter narrows the Backlog panel', () => {
  test('selecting a project shows only that project\'s backlog rows', async ({ page }) => {
    await openBacklogWithFilters(page)
    const before = await backlogRows(page).count()

    await projectChip(page, BOARD_PROJECT).click()

    const visible = backlogRows(page)
    await expect(visible).toHaveCount(1)
    expect(await visible.count()).toBeLessThan(before)
    expect(await distinctAttribute(visible, 'data-project')).toEqual([BOARD_PROJECT])
  })

  test('selecting a backlog-only project empties Active and Done but keeps its backlog rows', async ({ page }) => {
    await openBacklogWithFilters(page)

    await projectChip(page, BACKLOG_ONLY_PROJECT).click()

    await expect(backlogRow(page, BACKLOG_ONLY_INDEX)).toBeVisible()
    await expect(backlogRows(page)).toHaveCount(1)

    await selectBoardTab(page, 'inprogress')
    await expect(activeCards(page)).toHaveCount(0)

    await selectBoardTab(page, 'done')
    await expect(doneRows(page)).toHaveCount(0)
  })

  test('multi-select unions the selected projects', async ({ page }) => {
    await openBacklogWithFilters(page)

    await projectChip(page, BOARD_PROJECT).click()
    await projectChip(page, SHARED_PROJECT).click()

    await expect(backlogRows(page)).toHaveCount(2)
    expect(await distinctAttribute(backlogRows(page), 'data-project')).toEqual(
      [BOARD_PROJECT, SHARED_PROJECT].sort(),
    )
  })

  test('an untagged backlog item is hidden once any project is selected', async ({ page }) => {
    await openBacklogWithFilters(page)
    await expect(backlogRow(page, UNTAGGED_INDEX)).toBeVisible()

    await projectChip(page, BOARD_PROJECT).click()

    // Same rule a task with no Repo: line already follows — see
    // dashboard-smart-filters.spec.ts.
    await expect(backlogRow(page, UNTAGGED_INDEX)).toHaveCount(0)
  })

  test('the backlog tab count follows the filter', async ({ page }) => {
    await openBacklogWithFilters(page)
    expect(await backlogTabCount(page)).toBe(await backlogRows(page).count())

    await projectChip(page, BOARD_PROJECT).click()

    expect(await backlogTabCount(page)).toBe(await backlogRows(page).count())
    expect(await backlogTabCount(page)).toBe(1)
  })

})

// --- index addressing under a filter ---------------------------------------

test.describe('filtering hides rows without renumbering them', () => {
  test('a visible row keeps its file-order data-index', async ({ page }) => {
    await openBacklogWithFilters(page)

    await projectChip(page, BACKLOG_ONLY_PROJECT).click()

    // The only visible row is the THIRD line in the file. Were the filter
    // applied before indices were bound, this row would render as index 0
    // and every write against it would hit the wrong line.
    expect(await renderedIndices(page)).toEqual([BACKLOG_ONLY_INDEX])
  })

  test('the play button under a filter dispatches its own row, not the row at that position', async ({ page }) => {
    // backlog-play-btn is one of canonical-dispatch-gate's proactively-
    // disabled CTAs on a non-canonical instance (see index.html's
    // renderBacklog) — this suite's own shared webServer deliberately never
    // sets COCKPIT_DISPATCH_ENABLED, so this one test runs its own
    // dedicated, canonical instance to see the button enabled at all. Every
    // other case in this file never clicks it and stays on the shared
    // server.
    const canonicalUrl = await startCanonicalServer()
    try {
      const dispatched: { description: string; project: string | null }[] = []
      await page.route('**/backlog/dispatch', async (route) => {
        dispatched.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, body: '' })
      })

      await openBacklogWithFilters(page, canonicalUrl)
      const expectedTitle = (await backlogRow(page, BACKLOG_ONLY_INDEX)
        .getByTestId('backlog-row-title').innerText()).trim()

      await projectChip(page, BACKLOG_ONLY_PROJECT).click()
      await backlogRow(page, BACKLOG_ONLY_INDEX).getByTestId('backlog-play-btn').click()

      await expect.poll(() => dispatched.length).toBe(1)
      expect(dispatched[0].description).toBe(expectedTitle)
      // The project travels with the dispatch so the orchestrator doesn't
      // have to re-derive a repo the item already declares.
      expect(dispatched[0].project).toBe(BACKLOG_ONLY_PROJECT)
    } finally {
      await stopCanonicalServer(canonicalUrl)
    }
  })

  test('the batch bar counts only rows the filter leaves visible', async ({ page }) => {
    await openBacklogWithFilters(page)

    await page.getByTestId('backlog-select-checkbox').first().check()
    await expect(page.getByTestId('backlog-batch-bar')).toHaveClass(/is-open/)

    // Selecting a project that excludes the checked item must not leave a
    // batch bar advertising an item the developer can no longer see.
    await projectChip(page, BACKLOG_ONLY_PROJECT).click()

    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('0')
    await expect(page.getByTestId('backlog-batch-bar')).not.toHaveClass(/is-open/)
  })
})

// --- writing a project -----------------------------------------------------

test.describe('the edit form can set a project', () => {
  test('the project input is pre-filled from the item and offers known projects', async ({ page }) => {
    await openBacklogWithFilters(page)

    await backlogRow(page, COCKPIT_INDEX).getByTestId('backlog-edit-btn').click()

    const input = page.getByTestId('backlog-edit-project-input')
    await expect(input).toHaveValue(BOARD_PROJECT)

    // Suggestions come from the same derived option set the chips use, so a
    // retag can't invent a project the board has never heard of by typo alone.
    const listId = await input.getAttribute('list')
    expect(listId).toBeTruthy()
    const options = await page.locator(`#${listId} option`).evaluateAll(
      (opts) => opts.map((opt) => (opt as HTMLOptionElement).value),
    )
    expect(options).toContain(BOARD_PROJECT)
    expect(options).toContain(BACKLOG_ONLY_PROJECT)
  })

  test('an untagged item opens with an empty project input', async ({ page }) => {
    await openBacklogWithFilters(page)

    await backlogRow(page, UNTAGGED_INDEX).getByTestId('backlog-edit-btn').click()

    await expect(page.getByTestId('backlog-edit-project-input')).toHaveValue('')
  })

  test('saving a project writes the bracket tag to BACKLOG.md and re-tags the row', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await openBacklogWithFilters(page)

        await backlogRow(page, UNTAGGED_INDEX).getByTestId('backlog-edit-btn').click()
        await page.getByTestId('backlog-edit-project-input').fill(SHARED_PROJECT)
        await page.getByTestId('backlog-edit-save-btn').click()

        await expect(backlogRow(page, UNTAGGED_INDEX)).toHaveAttribute('data-project', SHARED_PROJECT)

        const raw = await fs.readFile(BACKLOG_PATH, 'utf-8')
        const line = raw.split('\n').filter((l) => l.startsWith('- [ ] '))[UNTAGGED_INDEX]
        expect(line).toMatch(new RegExp(`^- \\[ \\] \\[${SHARED_PROJECT}\\] `))
        // The rest of the line survives the rewrite untouched.
        expect(line).toMatch(/\(2026-08-20\)$/)
      })
    })
  })

  test('clearing the project input removes the tag', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await openBacklogWithFilters(page)

        await backlogRow(page, COCKPIT_INDEX).getByTestId('backlog-edit-btn').click()
        await page.getByTestId('backlog-edit-project-input').fill('')
        await page.getByTestId('backlog-edit-save-btn').click()

        await expect(backlogRow(page, COCKPIT_INDEX)).toBeVisible()
        // expect.poll, not a one-shot evaluate() read: the save click fires
        // an async POST + re-render, and unlike the sibling "saving a
        // project" case above (an auto-retrying `toHaveAttribute`), a single
        // synchronous read here can land before that re-render completes —
        // reliably enough under a fully-parallel run's CPU contention to
        // read the stale pre-save DOM and see the attribute still present.
        await expect.poll(
          () => backlogRow(page, COCKPIT_INDEX).evaluate((row) => row.hasAttribute('data-project')),
        ).toBe(false)

        const raw = await fs.readFile(BACKLOG_PATH, 'utf-8')
        const line = raw.split('\n').filter((l) => l.startsWith('- [ ] '))[COCKPIT_INDEX]
        expect(line).not.toMatch(/^- \[ \] \[/)
      })
    })
  })

  test('a rejected project name surfaces an error instead of writing a broken line', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await openBacklogWithFilters(page)

        await backlogRow(page, UNTAGGED_INDEX).getByTestId('backlog-edit-btn').click()
        // A space makes it un-round-trippable: the bracket tag is a single
        // bare token by construction, so this has to be refused rather than
        // written and silently re-parsed as part of the description.
        await page.getByTestId('backlog-edit-project-input').fill('not a slug')
        await page.getByTestId('backlog-edit-save-btn').click()

        await expect(page.getByTestId('backlog-edit-error')).toBeVisible()
        await expect(page.getByTestId('backlog-edit-form')).toBeVisible()

        const raw = await fs.readFile(BACKLOG_PATH, 'utf-8')
        expect(raw).not.toContain('[not a slug]')
      })
    })
  })
})
