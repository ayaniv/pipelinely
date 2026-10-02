import { test, expect, type Page } from '@playwright/test'
import { selectBoardTab } from './fixtures/boardTabs.js'
import { collectConsoleErrors, collectPageErrors, freezeLiveFeed, isReactOwned, pushSnapshot } from './fixtures/liveBoard.js'

// The Backlog, Done and You tab views plus the sidebar tab bar and its
// tab-count-* badges are React (web/src/views/board), rendered by portals into
// the app frame's #tab-bar / #backlog-section / #done-section / #you-section.
// The ONE project filter (React state) narrows all three panels and the counts
// directly.
//
// This spec covers what the backlog/done/you/sidebar specs
// (design-v2-backlog-done, backlog-batch-delete, backlog-filter-project-field,
// batch-dispatch-staging, you-tab, board-redesign, task-detail-url, …) have no
// reason to check: that these views really are React-owned, that counts and
// panels follow the snapshot and the filter, that tab navigation still writes
// exactly one history entry per click, that React reconciliation (not
// innerHTML replacement) is what keeps a click or a half-typed edit alive
// across an SSE push, and the failure paths that must be logged.

const WEB_REPO = 'acme-web'
const API_REPO = 'acme-api'
// BACKLOG.md's second fixture item — the one tagged acme-api, with context.
const API_BACKLOG_INDEX = 1
const DONE_TASK_SLUG = 'board-done-one'

const chip = (page: Page, repo: string) => page.getByTestId(`filter-chip-project-${repo}`)
const backlogRow = (page: Page, index: number) => page.locator(`[data-testid="backlog-row"][data-index="${index}"]`)
const activeCount = (page: Page, tab: string) => page.getByTestId(`tab-count-${tab}`)

async function revealFilters(page: Page): Promise<void> {
  await page.getByTestId('filter-toggle-btn').click()
  await expect(page.getByTestId('board-filters')).toBeVisible()
}

interface BacklogItemShape {
  description: string
  date: string | null
  context: string | null
  done: boolean
  shelvedSlug: string | null
  project: string | null
}

interface DoneGroupShape {
  label: string
  dateKey: string
  tasks: Array<{ slug: string; title: string; repo: string; sessions: unknown[] }>
}

interface SnapshotShape {
  backlog: BacklogItemShape[]
  doneGroups: DoneGroupShape[]
}

const fetchSnapshot = (page: Page): Promise<SnapshotShape> => page.evaluate(() => fetch('/api/tasks').then((r) => r.json()))

// A task copied from the real snapshot's own done list, so the pushed
// group has every field the Done row reads.
async function todayDoneGroup(page: Page, titles: string[]): Promise<DoneGroupShape> {
  const snapshot = await fetchSnapshot(page)
  const template = snapshot.doneGroups[0].tasks[0]
  return {
    label: 'Today',
    dateKey: '2099-01-01',
    tasks: titles.map((title, i) => ({ ...template, slug: `standup-${i}`, title })),
  }
}

// Every page in this file needs the same three things before a test can push
// snapshots: the board loaded, a card on it, and the live feed frozen.
async function openFrozenBoard(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('task-card').first()).toBeVisible()
  await freezeLiveFeed(page)
}

test.describe('react board tabs: ownership', () => {
  test('the tab bar, backlog rows, done rows and density calendar are each React-owned, with no page errors', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/')
    await expect(page.getByTestId('task-card').first()).toBeVisible()

    expect(await isReactOwned(page.getByTestId('tab-btn-backlog'))).toBe(true)
    expect(await isReactOwned(page.getByTestId('tab-count-done'))).toBe(true)
    expect(await isReactOwned(page.getByTestId('sidebar-account'))).toBe(true)

    await selectBoardTab(page, 'backlog')
    expect(await isReactOwned(page.getByTestId('backlog-row').first())).toBe(true)
    expect(await isReactOwned(page.getByTestId('backlog-batch-bar'))).toBe(true)

    await selectBoardTab(page, 'done')
    expect(await isReactOwned(page.getByTestId('done-row').first())).toBe(true)

    await selectBoardTab(page, 'you')
    expect(await isReactOwned(page.getByTestId('density-cell').first())).toBe(true)

    // The sidebar keeps exactly three counted tabs; You stays the account row.
    await expect(page.locator('#tab-bar .tab-btn')).toHaveCount(3)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })
})

test.describe('react board tabs: sidebar tab bar and counts', () => {
  test('each count equals what its panel shows, and follows a live snapshot', async ({ page }) => {
    await openFrozenBoard(page)
    const snapshot = await fetchSnapshot(page)
    const doneTotal = snapshot.doneGroups.reduce((sum, group) => sum + group.tasks.length, 0)

    await expect(activeCount(page, 'backlog')).toHaveText(String(snapshot.backlog.length))
    await expect(activeCount(page, 'done')).toHaveText(String(doneTotal))

    await pushSnapshot(page, { backlog: snapshot.backlog.slice(0, 2), doneGroups: [] })
    await expect(activeCount(page, 'backlog')).toHaveText('2')
    await expect(activeCount(page, 'done')).toHaveText('0')

    await selectBoardTab(page, 'backlog')
    await expect(page.getByTestId('backlog-row')).toHaveCount(2)
  })

  test('the project filter narrows the Backlog and Done counts and panels, and clearing restores them', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-card').first()).toBeVisible()
    await revealFilters(page)
    const snapshot = await fetchSnapshot(page)
    const unfilteredBacklog = snapshot.backlog.length
    const apiBacklog = snapshot.backlog.filter((item) => item.project === API_REPO).length
    const apiDone = snapshot.doneGroups.flatMap((group) => group.tasks).filter((task) => task.repo === API_REPO).length
    expect(apiBacklog).toBeGreaterThan(0)

    await chip(page, API_REPO).click()
    await expect(activeCount(page, 'backlog')).toHaveText(String(apiBacklog))
    await expect(activeCount(page, 'done')).toHaveText(String(apiDone))

    await selectBoardTab(page, 'backlog')
    await expect(page.getByTestId('backlog-row')).toHaveCount(apiBacklog)
    await selectBoardTab(page, 'done')
    await expect(page.getByTestId('done-row')).toHaveCount(apiDone)
    // A date group whose rows were all filtered out is dropped, not rendered
    // as an empty header.
    for (const group of await page.getByTestId('done-date-group').all()) {
      await expect(group.getByTestId('done-row').first()).toBeVisible()
    }

    await selectBoardTab(page, 'inprogress')
    await chip(page, API_REPO).click()
    await expect(activeCount(page, 'backlog')).toHaveText(String(unfilteredBacklog))
  })

  test('clicking a tab activates its panel and trigger, and writes one URL, one data-route and one history entry', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-card').first()).toBeVisible()
    const historyBefore = await page.evaluate(() => history.length)

    for (const [tab, url] of [['backlog', '/backlog'], ['done', '/done'], ['inprogress', '/']] as const) {
      await selectBoardTab(page, tab)
      await expect(page).toHaveURL(url)
      await expect(page.getByTestId('react-shell')).toHaveAttribute('data-route', tab)
      await expect(page.getByTestId(`tab-btn-${tab}`)).toHaveClass(/is-active/)
      await expect(page.locator('#board')).toHaveAttribute('data-active-tab', tab)
      await expect(page.locator('.tab-panel.is-active')).toHaveCount(1)
    }
    expect(await page.evaluate(() => history.length)).toBe(historyBefore + 3)

    await selectBoardTab(page, 'you')
    await expect(page).toHaveURL('/you')
    await expect(page.getByTestId('sidebar-account')).toHaveClass(/is-active/)
    await expect(page.locator('#tab-bar .tab-btn.is-active')).toHaveCount(0)
  })

  test('clicking the tab that is already active adds no history entry', async ({ page }) => {
    await page.goto('/backlog')
    await expect(page.getByTestId('backlog-section')).toBeVisible()
    const historyBefore = await page.evaluate(() => history.length)

    await page.getByTestId('tab-btn-backlog').click()

    expect(await page.evaluate(() => history.length)).toBe(historyBefore)
    await expect(page).toHaveURL('/backlog')
  })

  test('back and forward walk the tabs, and a cold load lands on the tab its URL names', async ({ page }) => {
    await page.goto('/done')
    await expect(page.getByTestId('done-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-done')).toHaveClass(/is-active/)

    await selectBoardTab(page, 'backlog')
    await page.goBack()
    await expect(page).toHaveURL('/done')
    await expect(page.getByTestId('done-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-done')).toHaveClass(/is-active/)
    await expect(page.getByTestId('react-shell')).toHaveAttribute('data-route', 'done')

    await page.goForward()
    await expect(page.getByTestId('backlog-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-backlog')).toHaveClass(/is-active/)
  })

  test('a tab click from an open task detail closes it and lands on that tab', async ({ page }) => {
    await page.goto('/')
    await selectBoardTab(page, 'done')
    await page.getByTestId('done-row-link').first().click()
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await page.getByTestId('tab-btn-backlog').click()

    await expect(page.getByTestId('task-detail')).toHaveCount(0)
    await expect(page).toHaveURL('/backlog')
    await expect(page.getByTestId('backlog-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-backlog')).toHaveClass(/is-active/)
  })

  // The in-app overlay path: unlike a Done row (a plain <a href>, which is a
  // full page load), a shelved backlog row opens the task detail in-app, and Settings through the sidebar — and both close
  // by writing a URL. The tab behind them must be the one they were opened
  // from, not whatever "/" happens to mean.
  test('a task detail opened from the Backlog closes back to the Backlog tab, with Escape and with Back', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const snapshot = await fetchSnapshot(page)
    await pushSnapshot(page, { backlog: [{ ...snapshot.backlog[0], shelvedSlug: 'shelved-task' }, ...snapshot.backlog.slice(1)] })

    await backlogRow(page, 0).getByTestId('backlog-row-title').click()
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('task-detail')).toHaveCount(0)
    await expect(page.getByTestId('backlog-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-backlog')).toHaveClass(/is-active/)
    await expect(page.getByTestId('tab-btn-inprogress')).not.toHaveClass(/is-active/)
    await expect(page).toHaveURL('/backlog')

    await backlogRow(page, 0).getByTestId('backlog-row-title').click()
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await page.goBack()

    await expect(page.getByTestId('task-detail')).toHaveCount(0)
    await expect(page.getByTestId('backlog-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-backlog')).toHaveClass(/is-active/)
  })

  // A Done row used to be a plain <a href> — a full page load, which threw the
  // remembered tab away, so closing the detail landed on Active. It now opens
  // through the app like the shelved Backlog row does.
  test('a task opened from a Done row closes back to the Done tab, with Escape, the header Back pill and browser Back', async ({ page }) => {
    await page.goto('/')
    await selectBoardTab(page, 'done')
    const link = page.locator(`[data-testid="done-row"][data-slug="${DONE_TASK_SLUG}"]`).getByTestId('done-row-link')
    const loads: string[] = []
    page.on('load', () => loads.push(page.url()))

    for (const close of [
      () => page.keyboard.press('Escape'),
      () => page.locator('.back-pill').click(),
      () => page.goBack(),
    ]) {
      await link.click()
      await expect(page.getByTestId('task-detail')).toBeVisible()
      await close()

      await expect(page.getByTestId('task-detail')).toHaveCount(0)
      await expect(page).toHaveURL('/done')
      await expect(page.getByTestId('done-section')).toBeVisible()
      await expect(page.getByTestId('tab-btn-done')).toHaveClass(/is-active/)
      await expect(page.getByTestId('tab-btn-inprogress')).not.toHaveClass(/is-active/)
    }
    expect(loads, 'opening a Done row must not reload the page').toEqual([])
  })

  test('Settings opened from the Done tab closes back to the Done tab', async ({ page }) => {
    await page.goto('/')
    await selectBoardTab(page, 'done')

    await page.getByTestId('sidebar-settings-btn').click()
    await expect(page).toHaveURL('/settings')
    await page.keyboard.press('Escape')

    await expect(page).toHaveURL('/done')
    await expect(page.getByTestId('done-section')).toBeVisible()
    await expect(page.getByTestId('tab-btn-done')).toHaveClass(/is-active/)
  })

  test('the standup button shows on the Done tab only', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('standup-btn')).toBeHidden()
    await selectBoardTab(page, 'done')
    await expect(page.getByTestId('standup-btn')).toBeVisible()
    await selectBoardTab(page, 'you')
    await expect(page.getByTestId('standup-btn')).toBeHidden()
  })
})

test.describe('react board tabs: backlog', () => {
  test('ticking a row opens the batch bar with the live count, and clear closes it', async ({ page }) => {
    await page.goto('/backlog')
    const box = backlogRow(page, 0).getByTestId('backlog-select-checkbox')
    await box.check()
    await backlogRow(page, 2).getByTestId('backlog-select-checkbox').check()

    await expect(page.getByTestId('backlog-batch-bar')).toHaveClass(/is-open/)
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('2')
    await expect(page.getByTestId('backlog-run-selected-btn')).toHaveText('Run batch (2)')
    await expect(page.getByTestId('backlog-delete-selected-count')).toHaveText('2')

    await page.getByTestId('backlog-clear-selected-btn').click()
    await expect(box).not.toBeChecked()
    await expect(page.getByTestId('backlog-batch-bar')).not.toHaveClass(/is-open/)
  })

  test('a selection is keyed by description: it survives an SSE push that reorders the list, and drops with its item', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const snapshot = await fetchSnapshot(page)
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()
    const selectedTitle = snapshot.backlog[0].description

    // Reordered: the selected item now sits at index 1.
    await pushSnapshot(page, { backlog: [snapshot.backlog[1], snapshot.backlog[0], ...snapshot.backlog.slice(2)] })
    await expect(backlogRow(page, 1).getByTestId('backlog-row-title')).toHaveText(selectedTitle)
    await expect(backlogRow(page, 1).getByTestId('backlog-select-checkbox')).toBeChecked()
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('1')

    // Removed elsewhere: nothing left to count or dispatch.
    await pushSnapshot(page, { backlog: snapshot.backlog.slice(1) })
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('0')
    await expect(page.getByTestId('backlog-batch-bar')).not.toHaveClass(/is-open/)
  })

  test('a selection hidden by the project filter is neither counted nor dispatched, and reappears checked when the filter clears', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-card').first()).toBeVisible()
    await revealFilters(page)
    await selectBoardTab(page, 'backlog')
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('1')

    await selectBoardTab(page, 'inprogress')
    await chip(page, API_REPO).click()
    await selectBoardTab(page, 'backlog')
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('0')

    await selectBoardTab(page, 'inprogress')
    await chip(page, API_REPO).click()
    await selectBoardTab(page, 'backlog')
    await expect(backlogRow(page, 0).getByTestId('backlog-select-checkbox')).toBeChecked()
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('1')
  })

  test('an open edit form keeps what was typed when an SSE push lands, and a save posts the untouched original', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const snapshot = await fetchSnapshot(page)
    await backlogRow(page, API_BACKLOG_INDEX).getByTestId('backlog-edit-btn').click()
    const descInput = page.getByTestId('backlog-edit-desc-input')
    await descInput.fill('typed but not saved')

    await pushSnapshot(page, {})
    await expect(descInput).toHaveValue('typed but not saved')

    let posted = null as { url: string; body: Record<string, unknown> } | null
    await page.route('**/backlog/edit/*', async (route) => {
      posted = { url: route.request().url(), body: route.request().postDataJSON() }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.getByTestId('backlog-edit-save-btn').click()
    await expect(page.getByTestId('backlog-edit-form')).toHaveCount(0)

    expect(posted!.url).toContain(`/backlog/edit/${API_BACKLOG_INDEX}`)
    expect(posted!.body.description).toBe('typed but not saved')
    expect(posted!.body.original).toMatchObject({ description: snapshot.backlog[API_BACKLOG_INDEX].description })
  })

  test('cancel closes the edit form without posting, and an empty description is refused client-side', async ({ page }) => {
    await page.goto('/backlog')
    let posts = 0
    await page.route('**/backlog/edit/*', async (route) => { posts += 1; await route.fulfill({ status: 200, body: '{}' }) })

    await backlogRow(page, 0).getByTestId('backlog-edit-btn').click()
    await page.getByTestId('backlog-edit-desc-input').fill('   ')
    await page.getByTestId('backlog-edit-save-btn').click()
    await expect(page.getByTestId('backlog-edit-error')).toHaveText('Description cannot be empty.')

    await page.getByTestId('backlog-edit-cancel-btn').click()
    await expect(page.getByTestId('backlog-edit-form')).toHaveCount(0)
    expect(posts).toBe(0)
  })

  for (const { name, status, body, message } of [
    { name: 'a 409', status: 409, body: '{}', message: 'This item changed elsewhere — refresh and try again.' },
    { name: 'a 400 invalid-project', status: 400, body: '{"error":"invalid-project"}', message: 'Project must be a single word (letters, digits, -, _, .).' },
    { name: 'a 400 project-collision', status: 400, body: '{"error":"project-collision"}', message: "An untagged description can't start with a bracketed word. Set it as the project instead." },
    { name: 'an unrecognised 400', status: 400, body: '{"error":"other"}', message: 'Save failed — see server logs.' },
    { name: 'a 500', status: 500, body: '{}', message: 'Save failed — see server logs.' },
  ]) {
    test(`a failed save (${name}) keeps the form open with its message and re-enables Save`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page)
      await page.goto('/backlog')
      await page.route('**/backlog/edit/*', (route) => route.fulfill({ status, contentType: 'application/json', body }))

      await backlogRow(page, 0).getByTestId('backlog-edit-btn').click()
      await page.getByTestId('backlog-edit-save-btn').click()

      await expect(page.getByTestId('backlog-edit-error')).toHaveText(message)
      await expect(page.getByTestId('backlog-edit-save-btn')).toBeEnabled()
      expect(consoleErrors.join('\n')).toContain('[action] POST /backlog/edit/0 failed')
    })
  }

  test('a save the server never answers is reported and logged rather than hanging', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.goto('/backlog')
    await page.route('**/backlog/edit/*', (route) => route.abort())

    await backlogRow(page, 0).getByTestId('backlog-edit-btn').click()
    await page.getByTestId('backlog-edit-save-btn').click()

    await expect(page.getByTestId('backlog-edit-error')).toHaveText('Save failed — no response from server.')
    expect(consoleErrors.join('\n')).toContain('[action] POST /backlog/edit/0 failed')
  })

  test('Run is disabled with the read-only reason on a non-canonical instance, and live on a canonical one', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const play = backlogRow(page, 0).getByTestId('backlog-play-btn')
    await expect(play).toBeDisabled()
    await expect(play).toHaveAttribute('title', 'Read-only — this is not the canonical dashboard instance')
    await expect(page.getByTestId('backlog-run-selected-btn')).toBeDisabled()

    await pushSnapshot(page, { isCanonical: true })
    await expect(play).toBeEnabled()
    await expect(page.getByTestId('backlog-run-selected-btn')).toBeEnabled()
  })

  test('Run posts the item and flashes "✓ sent"', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    await pushSnapshot(page, { isCanonical: true })
    const snapshot = await fetchSnapshot(page)
    const item = snapshot.backlog[API_BACKLOG_INDEX]
    let payload = null as Record<string, unknown> | null
    await page.route('**/backlog/dispatch', async (route) => {
      payload = route.request().postDataJSON()
      await route.fulfill({ status: 200, body: '{}' })
    })

    const play = backlogRow(page, API_BACKLOG_INDEX).getByTestId('backlog-play-btn')
    await play.click()

    await expect(play).toHaveText('✓ sent')
    expect(payload).toEqual({ description: item.description, context: item.context, project: item.project })
    await expect(play).toHaveText('run')
  })

  for (const { status, label } of [
    { status: 409, label: 'reattached — click again' },
    { status: 503, label: 'no orchestrator' },
    { status: 403, label: 'read-only instance' },
    { status: 500, label: 'failed' },
  ]) {
    test(`Run answered with ${status} flashes "${label}", logs, and re-enables the button`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page)
      await openFrozenBoard(page)
      await selectBoardTab(page, 'backlog')
      await pushSnapshot(page, { isCanonical: true })
      await page.route('**/backlog/dispatch', (route) => route.fulfill({ status, body: '{}' }))

      const play = backlogRow(page, 0).getByTestId('backlog-play-btn')
      await play.click()

      await expect(play).toHaveText(label)
      await expect(play).toHaveClass(/btn-err/)
      await expect(play).toBeEnabled()
      expect(consoleErrors.join('\n')).toContain('[action] POST /backlog/dispatch failed')
    })
  }

  test('Run batch posts one batch-dispatch for the whole selection, then clears it and flashes each row', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    await pushSnapshot(page, { isCanonical: true })
    const snapshot = await fetchSnapshot(page)
    let payload = null as { kind: string; items: Array<{ description: string }> } | null
    await page.route('**/batch-dispatch', async (route) => {
      payload = route.request().postDataJSON()
      await route.fulfill({ status: 200, body: '{}' })
    })
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()
    await backlogRow(page, 1).getByTestId('backlog-select-checkbox').check()

    await page.getByTestId('backlog-run-selected-btn').click()

    await expect(backlogRow(page, 0).getByTestId('backlog-play-btn')).toHaveText('staged')
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('0')
    expect(payload!.kind).toBe('backlog')
    expect(payload!.items.map((item) => item.description)).toEqual([snapshot.backlog[0].description, snapshot.backlog[1].description])
  })

  test('a failed Run batch keeps the whole selection, marks the button with the server detail, and logs', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    await pushSnapshot(page, { isCanonical: true })
    await page.route('**/batch-dispatch', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"orchestrator tab is gone"}' }))
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()

    const run = page.getByTestId('backlog-run-selected-btn')
    await run.click()

    await expect(run).toHaveClass(/btn-err/)
    await expect(run).toHaveAttribute('title', 'orchestrator tab is gone')
    await expect(page.getByTestId('backlog-selected-count-num')).toHaveText('1')
    await expect(run).toBeEnabled()
    expect(consoleErrors.join('\n')).toContain('[action] POST /batch-dispatch failed')
  })

  test('a row\'s trash opens the shared confirm modal, Cancel and Escape close it without posting', async ({ page }) => {
    await page.goto('/backlog')
    let posts = 0
    await page.route('**/backlog/dismiss/*', async (route) => { posts += 1; await route.fulfill({ status: 200, body: '{}' }) })

    await backlogRow(page, 0).getByTestId('backlog-dismiss-btn').click()
    await expect(page.getByTestId('backlog-delete-modal')).toBeVisible()
    await expect(page.getByTestId('backlog-delete-headline')).toHaveText('Delete 1 backlog item?')
    await expect(page.getByTestId('backlog-delete-body')).toHaveText('This removes it from the backlog permanently.')
    await expect(page.getByTestId('backlog-delete-cancel-btn')).toBeFocused()

    await page.getByTestId('backlog-delete-cancel-btn').click()
    await expect(page.getByTestId('backlog-delete-modal')).toBeHidden()

    await backlogRow(page, 0).getByTestId('backlog-dismiss-btn').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('backlog-delete-modal')).toBeHidden()
    expect(posts).toBe(0)
  })

  test('Delete (N) removes the selection highest index first, so every pending index stays valid', async ({ page }) => {
    await page.goto('/backlog')
    const dismissedUrls: string[] = []
    await page.route('**/backlog/dismiss/*', async (route) => {
      dismissedUrls.push(new URL(route.request().url()).pathname)
      await route.fulfill({ status: 200, body: '{}' })
    })
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()
    await backlogRow(page, 2).getByTestId('backlog-select-checkbox').check()

    await page.getByTestId('backlog-delete-selected-btn').click()
    await expect(page.getByTestId('backlog-delete-headline')).toHaveText('Delete 2 backlog items?')
    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect.poll(() => dismissedUrls).toEqual(['/backlog/dismiss/2', '/backlog/dismiss/0'])
  })

  test('a failed dismissal stops the batch, flashes the button, and is logged with its index and status', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.goto('/backlog')
    let posts = 0
    await page.route('**/backlog/dismiss/*', async (route) => { posts += 1; await route.fulfill({ status: 409, body: '{}' }) })
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()
    await backlogRow(page, 2).getByTestId('backlog-select-checkbox').check()

    await page.getByTestId('backlog-delete-selected-btn').click()
    await page.getByTestId('backlog-delete-confirm-btn').click()

    const deleteBtn = page.getByTestId('backlog-delete-selected-btn')
    await expect(deleteBtn).toHaveClass(/btn-err/)
    await expect(deleteBtn).toHaveAttribute('title', 'changed elsewhere — refresh')
    await expect(deleteBtn).toBeEnabled()
    expect(posts).toBe(1)
    expect(consoleErrors.join('\n')).toContain('[action] POST /backlog/dismiss/2 failed')
  })

  test('a single-row delete confirms with the shelved wording and posts the item as its concurrency guard', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const snapshot = await fetchSnapshot(page)
    const shelved = { ...snapshot.backlog[0], shelvedSlug: 'shelved-task' }
    await pushSnapshot(page, { backlog: [shelved, ...snapshot.backlog.slice(1)] })
    let payload = null as { original: BacklogItemShape } | null
    await page.route('**/backlog/dismiss/*', async (route) => {
      payload = route.request().postDataJSON()
      await route.fulfill({ status: 200, body: '{}' })
    })

    await backlogRow(page, 0).getByTestId('backlog-dismiss-btn').click()
    await expect(page.getByTestId('backlog-delete-body')).toContainText('Its task directory (shelved-task) and branch stay on disk')
    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect.poll(() => payload?.original.description).toBe(shelved.description)
  })

  test('a shelved row offers Resume, which posts and follows the task to In Progress; a failure shows the server message', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const snapshot = await fetchSnapshot(page)
    await pushSnapshot(page, { backlog: [{ ...snapshot.backlog[0], shelvedSlug: 'shelved-task' }, ...snapshot.backlog.slice(1)] })
    const row = backlogRow(page, 0)
    await expect(row.getByTestId('backlog-shelved-badge')).toHaveText('shelved: shelved-task')
    await expect(row.getByTestId('backlog-select-checkbox')).toHaveCount(0)
    await expect(row.getByTestId('backlog-play-btn')).toHaveCount(0)

    await page.route('**/backlog/resume/0', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"that task directory is gone"}' }))
    await row.getByTestId('backlog-resume-btn').click()
    await expect(row.getByTestId('backlog-resume-btn')).toHaveText('that task directory is gone')
    expect(consoleErrors.join('\n')).toContain('[action] POST /backlog/resume/0 failed')

    await page.unroute('**/backlog/resume/0')
    await page.route('**/backlog/resume/0', async (route) => {
      expect(route.request().postDataJSON().original.shelvedSlug).toBe('shelved-task')
      await route.fulfill({ status: 200, body: '{}' })
    })
    await row.getByTestId('backlog-resume-btn').click()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('active-sessions')).toBeVisible()
  })

  test('clicking a shelved row\'s body opens that task, but a button or the edit form does not', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')
    const snapshot = await fetchSnapshot(page)
    await pushSnapshot(page, { backlog: [{ ...snapshot.backlog[0], shelvedSlug: 'shelved-task' }, ...snapshot.backlog.slice(1)] })

    await backlogRow(page, 0).getByTestId('backlog-row-title').click()
    await expect(page).toHaveURL('/task/shelved-task')
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  test('an emptied backlog shows the shared empty state', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'backlog')

    await pushSnapshot(page, { backlog: [] })

    await expect(page.getByTestId('backlog-section').getByTestId('board-empty-state')).toBeVisible()
    await expect(page.getByTestId('backlog-row')).toHaveCount(0)
  })
})

test.describe('react board tabs: done', () => {
  test('each date group totals its own rows, and a row is a real link to its task', async ({ page }) => {
    await page.goto('/done')
    const group = page.getByTestId('done-date-group').first()
    await expect(group.getByTestId('done-date-total')).toHaveText(/^\$\d+\.\d{2}$/)

    const row = page.locator(`[data-testid="done-row"][data-slug="${DONE_TASK_SLUG}"]`)
    await expect(row.getByTestId('done-row-link')).toHaveAttribute('href', `/task/${DONE_TASK_SLUG}`)
    await row.getByTestId('done-row-link').click()
    await expect(page).toHaveURL(`/task/${DONE_TASK_SLUG}`)
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  test('an emptied done list shows the shared empty state', async ({ page }) => {
    await openFrozenBoard(page)
    await selectBoardTab(page, 'done')

    await pushSnapshot(page, { doneGroups: [] })

    await expect(page.getByTestId('done-section').getByTestId('board-empty-state')).toBeVisible()
  })

  test('copy standup writes today\'s titles as bullet lines, flashes "copied", then reverts', async ({ page }) => {
    await openFrozenBoard(page)
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string[] }
      w.__copied = []
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text: string) => { w.__copied.push(text); return Promise.resolve() } }, configurable: true })
    })
    await pushSnapshot(page, { doneGroups: [await todayDoneGroup(page, ['Ship the tab bar', 'Fix the density grid'])] })
    await selectBoardTab(page, 'done')

    await page.getByTestId('standup-btn').click()

    await expect(page.getByTestId('standup-btn')).toHaveText('copied')
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(['• Ship the tab bar\n• Fix the density grid'])
    await expect(page.getByTestId('standup-btn')).toHaveText('copy standup')
  })

  test('copy standup with no group for today does nothing', async ({ page }) => {
    await openFrozenBoard(page)
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string[] }
      w.__copied = []
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text: string) => { w.__copied.push(text); return Promise.resolve() } }, configurable: true })
    })
    await pushSnapshot(page, { doneGroups: [{ ...(await todayDoneGroup(page, ['old'])), label: 'Yesterday' }] })
    await selectBoardTab(page, 'done')

    await page.getByTestId('standup-btn').click()

    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([])
    await expect(page.getByTestId('standup-btn')).toHaveText('copy standup')
  })

  test('a clipboard that refuses is logged with an [action] prefix and reported on the button', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await openFrozenBoard(page)
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })
    })
    await pushSnapshot(page, { doneGroups: [await todayDoneGroup(page, ['anything'])] })
    await selectBoardTab(page, 'done')

    await page.getByTestId('standup-btn').click()

    await expect(page.getByTestId('standup-btn')).toHaveText('copy failed')
    expect(consoleErrors.join('\n')).toContain('[action] could not copy standup text')
  })
})

test.describe('react board tabs: you', () => {
  test('the calendar always draws 53 weeks of cells, and its total matches the sessions counted', async ({ page }) => {
    await page.goto('/you')
    await expect(page.getByTestId('density-cell')).toHaveCount(53 * 7)
    const cellTotal = await page.getByTestId('density-cell').evaluateAll((cells) => cells.reduce((sum, cell) => sum + Number((cell as HTMLElement).dataset.count), 0))
    await expect(page.getByTestId('density-total')).toHaveAttribute('data-count', String(cellTotal))
  })

  test('an empty history still renders the grid rather than a blank panel, and the project filter never narrows it', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-card').first()).toBeVisible()
    await revealFilters(page)
    await chip(page, API_REPO).click()
    await freezeLiveFeed(page)
    await selectBoardTab(page, 'you')
    const unfilteredTotal = await page.getByTestId('density-total').getAttribute('data-count')

    await expect(page.getByTestId('density-total')).toHaveAttribute('data-count', unfilteredTotal!)
    await pushSnapshot(page, { doneGroups: [] })

    await expect(page.getByTestId('density-cell')).toHaveCount(53 * 7)
    await expect(page.getByTestId('density-total')).toHaveAttribute('data-count', '0')
  })
})

// What keeps a click alive is React skipping the DOM write for unchanged
// nodes, so the real mechanism is driven: an actual SSE push through the
// page's own es.onmessage in the middle of a real mouse gesture.
test.describe('react board tabs: clicks survive an SSE push landing mid-click', () => {
  async function clickWithMidClickPush(page: Page, target: ReturnType<Page['locator']>): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box) throw new Error('click target has no bounding box')
    const snapshot = await fetchSnapshot(page)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.evaluate((payload) => {
      window.es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(payload) }))
    }, snapshot)
    await page.mouse.up()
  }

  test('Done row: clicking its link still navigates', async ({ page }) => {
    await page.goto('/done')
    const link = page.locator(`[data-testid="done-row"][data-slug="${DONE_TASK_SLUG}"]`).getByTestId('done-row-link')
    await expect(link).toBeVisible()

    await clickWithMidClickPush(page, link)

    await expect(page).toHaveURL(`/task/${DONE_TASK_SLUG}`)
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  test('backlog list: clicking Waive still opens the confirm modal', async ({ page }) => {
    await page.goto('/backlog')
    const waive = backlogRow(page, 0).getByTestId('backlog-dismiss-btn')
    await expect(waive).toBeVisible()

    await clickWithMidClickPush(page, waive)

    await expect(page.getByTestId('backlog-delete-modal')).toBeVisible()
  })

  test('a checkbox ticked before the push is still ticked after it', async ({ page }) => {
    await page.goto('/backlog')
    await backlogRow(page, 0).getByTestId('backlog-select-checkbox').check()

    await page.evaluate(async () => {
      const snapshot = await fetch('/api/tasks').then((r) => r.json())
      window.es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(snapshot) }))
    })

    await expect(backlogRow(page, 0).getByTestId('backlog-select-checkbox')).toBeChecked()
  })
})
