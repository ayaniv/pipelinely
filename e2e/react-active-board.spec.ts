import { test, expect, type Page } from '@playwright/test'
import { selectBoardTab } from './fixtures/boardTabs.js'
import { collectConsoleErrors, collectPageErrors, freezeLiveFeed, isReactOwned, pushSnapshot } from './fixtures/liveBoard.js'

// The active board — session cards, the project filter chips, the summary
// (pulse) strip, the weekly-focus banner and the global progress bar — is
// React, rendered by portals into the app frame's own #active-cards /
// #filter-project-chips / #summary-strip / #weekly-focus / #global-progress
// containers (web/src/views/board). The project filter is React state
// (web/src/views/board/boardFilter.ts) that narrows every board panel.
//
// This spec covers what the many board specs (board-redesign,
// design-v2-active-board, design-v2-card-followup, card-merge-cta,
// dashboard-smart-filters, merge-tab-actions, focus-button-rerender-race) have
// no reason to check: that the board really is React-owned, that React's
// reconciliation (not innerHTML replacement) is what keeps a click alive
// across an SSE push, that a chip selected here narrows the other panels, and
// the failure paths that must be logged.

const WORKING_SLUG = 'focus-dead-session'
const STAGE_CTA_SLUG = 'dev-ready'
const MERGE_SLUG = 'card-merge-ready'
const HOT_PAUSED_SLUG = 'handover-hot'
const SEE_DETAILS_SLUG = 'filters-web-needs-you'
const OTHER_REPO_SLUG = 'filters-api-idle'
const WEB_REPO = 'acme-web'
// Only ever appears on a backlog row (BACKLOG.md's third fixture item), so
// filtering to it leaves the Active board with nothing to show.
const BACKLOG_ONLY_REPO = 'acme-clock'
const API_REPO = 'acme-api'

const card = (page: Page, slug: string) => page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
const chip = (page: Page, repo: string) => page.getByTestId(`filter-chip-project-${repo}`)

// The chip row sits in #board-filters, which the toolbar's filter button reveals.
async function revealFilters(page: Page): Promise<void> {
  await page.getByTestId('filter-toggle-btn').click()
  await expect(page.getByTestId('board-filters')).toBeVisible()
}

test.describe('react active board: ownership', () => {
  test('the session cards are React-rendered into the #active-cards container, with no page errors', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/')

    const firstCard = card(page, WORKING_SLUG)
    await expect(firstCard).toBeVisible()
    expect(await isReactOwned(firstCard)).toBe(true)
    // Portalled INTO the container, not beside it.
    await expect(page.locator('#active-cards').locator(`[data-slug="${WORKING_SLUG}"]`).first()).toBeVisible()
    await expect(page.getByTestId('active-sessions')).toHaveCount(1)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })

  test('the summary strip, filter chips, weekly focus and global progress are each React-owned', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { activeProject: { projectBase: 'ownership-check', current: 1, total: 2 } })

    expect(await isReactOwned(page.getByTestId('pulse-chip-working'))).toBe(true)
    expect(await isReactOwned(page.locator('#filter-project-chips .filter-chip').first())).toBe(true)
    expect(await isReactOwned(page.getByTestId('weekly-focus-text'))).toBe(true)
    expect(await isReactOwned(page.getByTestId('global-progress-label'))).toBe(true)
  })
})

test.describe('react active board: granular reconciliation', () => {
  // An innerHTML rewrite of the container would recreate EVERY card node
  // whenever ANY card changed. React reconciles in place, so an unrelated
  // card's nodes must survive.
  test("changing one task's waiting reason updates that card without recreating another card's nodes", async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    await page.evaluate((slug) => {
      document.querySelector(`[data-testid="task-card"][data-slug="${slug}"] [data-testid="focus-btn"]`)!.setAttribute('data-stable-marker', '1')
    }, WORKING_SLUG)

    await pushSnapshot(page, { taskPatches: { [STAGE_CTA_SLUG]: { waitingReason: 'plan reviewed, ready for dev — edited mid-test' } } })

    await expect(card(page, STAGE_CTA_SLUG).getByTestId('card-note')).toContainText('edited mid-test')
    await expect(card(page, WORKING_SLUG).getByTestId('focus-btn')).toHaveAttribute('data-stable-marker', '1')
  })

  test('a card moves between the Needs-you and Working groups as its attention status changes, and an emptied group disappears', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    // focus-dead-session is a fixture with a dead tab, so it is `orphaned` —
    // which pins it to Needs-you whatever its attention status; the patches
    // clear that so the attention status alone decides the bucket.
    await pushSnapshot(page, {
      onlySlugs: [WORKING_SLUG, STAGE_CTA_SLUG],
      taskPatches: {
        [WORKING_SLUG]: { status: 'working', attentionStatus: 'needs-you', orphaned: false },
        [STAGE_CTA_SLUG]: { attentionStatus: 'needs-you' },
      },
    })
    await expect(page.getByTestId('active-group-needs').locator(`[data-testid="task-card"][data-slug="${WORKING_SLUG}"]`)).toBeVisible()
    await expect(page.getByTestId('active-group-working')).toHaveCount(0)

    await pushSnapshot(page, {
      onlySlugs: [WORKING_SLUG, STAGE_CTA_SLUG],
      taskPatches: {
        [WORKING_SLUG]: { status: 'working', attentionStatus: 'working', orphaned: false },
        [STAGE_CTA_SLUG]: { attentionStatus: 'needs-you' },
      },
    })
    await expect(page.getByTestId('active-group-working').locator(`[data-testid="task-card"][data-slug="${WORKING_SLUG}"]`)).toBeVisible()
    await expect(page.getByTestId('active-group-needs').locator(`[data-testid="task-card"][data-slug="${WORKING_SLUG}"]`)).toHaveCount(0)
  })

  // Replaces focus-button-rerender-race.spec.ts's "board card: clicking
  // Terminal survives a same-content dashboard re-render landing mid-click".
  // What guarantees the click is React's reconciliation skipping the DOM
  // write for an unchanged card, so the real mechanism is driven:
  // an actual SSE push through the page's own es.onmessage between mousedown
  // and mouseup (same technique as react-task-detail.spec.ts).
  test('clicking Terminal on a card survives a same-content SSE push landing mid-click', async ({ page }) => {
    await page.goto('/')
    const btn = card(page, WORKING_SLUG).getByTestId('focus-btn')
    await expect(btn).toBeVisible()
    const snapshot = await page.evaluate(() => fetch('/api/tasks').then((r) => r.json()))
    await btn.scrollIntoViewIfNeeded()
    const box = await btn.boundingBox()
    if (!box) throw new Error('focus button has no bounding box')

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/focus/${WORKING_SLUG}`) && r.method() === 'POST'),
      (async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.evaluate((payload) => {
          window.es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(payload) }))
        }, snapshot)
        await page.mouse.up()
      })(),
    ])
    expect(req).toBeTruthy()
  })
})

test.describe('react active board: project filter', () => {
  test('selecting chips narrows the cards, multi-selects, updates the tab count, and clearing restores everything', async ({ page }) => {
    await page.goto('/')
    await revealFilters(page)
    await expect(card(page, OTHER_REPO_SLUG)).toBeVisible()
    const totalCards = await page.getByTestId('task-card').count()

    await chip(page, API_REPO).click()
    await expect(chip(page, API_REPO)).toHaveClass(/is-active/)
    const apiCardRepos = await page.getByTestId('task-card').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.repo))
    expect(apiCardRepos.length).toBeGreaterThan(0)
    expect(new Set(apiCardRepos)).toEqual(new Set([API_REPO]))
    await expect(page.getByTestId('tab-count-inprogress')).toHaveText(String(apiCardRepos.length))

    // Multi-select (D6): a second chip ADDS its repo rather than replacing.
    await chip(page, WEB_REPO).click()
    await expect(card(page, SEE_DETAILS_SLUG)).toBeVisible()
    await expect(card(page, OTHER_REPO_SLUG)).toBeVisible()

    await chip(page, API_REPO).click()
    await chip(page, WEB_REPO).click()
    await expect(page.locator('#filter-project-chips .filter-chip.is-active')).toHaveCount(0)
    await expect(page.getByTestId('task-card')).toHaveCount(totalCards)
  })

  // The filter is shared by every panel, so a chip selected on the Active board
  // must also narrow the Backlog panel. BACKLOG.md's fixture items are tagged cockpit-ai /
  // acme-api / acme-clock / (untagged).
  test('a chip selected on the Active board still narrows the Backlog panel', async ({ page }) => {
    await page.goto('/')
    await revealFilters(page)
    await expect(card(page, OTHER_REPO_SLUG)).toBeVisible()
    await selectBoardTab(page, 'backlog')
    const unfilteredRows = await page.getByTestId('backlog-row').count()
    expect(unfilteredRows).toBeGreaterThan(1)

    await selectBoardTab(page, 'inprogress')
    await chip(page, API_REPO).click()
    await selectBoardTab(page, 'backlog')

    await expect(page.getByTestId('backlog-row')).toHaveCount(1)
  })

  test('a selected project that disappears from the board is dropped rather than stranding an empty board', async ({ page }) => {
    await page.goto('/')
    await revealFilters(page)
    await expect(card(page, SEE_DETAILS_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    await chip(page, WEB_REPO).click()
    await expect(page.getByTestId('task-card')).toHaveCount(1)

    await pushSnapshot(page, { dropRepo: WEB_REPO })

    await expect(chip(page, WEB_REPO)).toHaveCount(0)
    await expect(page.locator('#filter-project-chips .filter-chip.is-active')).toHaveCount(0)
    await expect(card(page, OTHER_REPO_SLUG)).toBeVisible()
  })

  test('a project present only on the backlog leaves the Active board on the shared empty state, with a zero tab count', async ({ page }) => {
    await page.goto('/')
    await revealFilters(page)
    await expect(card(page, OTHER_REPO_SLUG)).toBeVisible()

    await chip(page, BACKLOG_ONLY_REPO).click()

    await expect(page.getByTestId('active-sessions').getByTestId('board-empty-state')).toBeVisible()
    await expect(page.getByTestId('task-card')).toHaveCount(0)
    await expect(page.getByTestId('tab-count-inprogress')).toHaveText('0')
  })
})

test.describe('react active board: summary strip', () => {
  test('the pulse chips count working and waiting sessions from what the board is showing', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    // working = STATUS working and not needing you; waiting = needs-you.
    await pushSnapshot(page, {
      onlySlugs: ['demo-task', WORKING_SLUG, STAGE_CTA_SLUG],
      taskPatches: {
        'demo-task': { status: 'working', attentionStatus: 'working' },
        [WORKING_SLUG]: { status: 'working', attentionStatus: 'needs-you', orphaned: false },
        [STAGE_CTA_SLUG]: { attentionStatus: 'needs-you' },
      },
    })

    await expect(page.getByTestId('pulse-chip-working')).toHaveText(/^\s*1\s+working\s*$/)
    await expect(page.getByTestId('pulse-chip-waiting')).toHaveText(/^\s*2\s+waiting\s*$/)
    await expect(page.getByTestId('tab-count-inprogress')).toHaveText('3')
  })
})

test.describe('react active board: weekly focus', () => {
  // Every case intercepts POST /weekly-focus: the real route persists to a
  // committed fixture file every other spec's server shares.
  test('clicking the banner opens an editor with the current text, and Enter saves it optimistically via POST /weekly-focus', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/weekly-focus', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { weeklyFocus: 'ship the react board' })
    await expect(page.getByTestId('weekly-focus-text')).toHaveText('ship the react board')

    await page.getByTestId('weekly-focus-text').click()
    const input = page.getByTestId('weekly-focus-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('ship the react board')

    await input.fill('  ship the whole migration  ')
    await input.press('Enter')

    await expect(page.getByTestId('weekly-focus-text')).toHaveText('ship the whole migration')
    await expect(input).toBeHidden()
    expect(bodies).toEqual([{ text: 'ship the whole migration' }])
  })

  test('Escape cancels the edit without saving anything', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/weekly-focus', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { weeklyFocus: 'keep me' })

    await page.getByTestId('weekly-focus-text').click()
    await page.getByTestId('weekly-focus-input').fill('never saved')
    await page.getByTestId('weekly-focus-input').press('Escape')

    await expect(page.getByTestId('weekly-focus-text')).toHaveText('keep me')
    expect(bodies).toEqual([])
  })

  test('a snapshot arriving mid-edit does not clobber what is being typed', async ({ page }) => {
    await page.route('**/weekly-focus', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { weeklyFocus: 'before' })

    await page.getByTestId('weekly-focus-text').click()
    const input = page.getByTestId('weekly-focus-input')
    await input.fill('typing in progress')
    await pushSnapshot(page, { weeklyFocus: 'changed elsewhere' })

    await expect(input).toHaveValue('typing in progress')
    await input.press('Enter')
    await expect(page.getByTestId('weekly-focus-text')).toHaveText('typing in progress')
  })

  // The failure is observable (logged), and the text reverts to the server's value instead of showing something never saved.
  test('a failed save is logged with a [action] prefix instead of vanishing', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/weekly-focus', (route) => route.abort('failed'))
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { weeklyFocus: 'server text' })
    await expect(page.getByTestId('weekly-focus-text')).toHaveText('server text')

    await page.getByTestId('weekly-focus-text').click()
    await page.getByTestId('weekly-focus-input').fill('will not persist')
    await page.getByTestId('weekly-focus-input').press('Enter')

    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
    // The visible outcome: the unsaved text does not stick.
    await expect(page.getByTestId('weekly-focus-text')).toHaveText('server text')
  })

  test('a non-2xx save response is logged too', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/weekly-focus', (route) => route.fulfill({ status: 500, body: 'boom' }))
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { weeklyFocus: 'server text' })
    await expect(page.getByTestId('weekly-focus-text')).toHaveText('server text')

    await page.getByTestId('weekly-focus-text').click()
    await page.getByTestId('weekly-focus-input').fill('will not persist either')
    await page.getByTestId('weekly-focus-input').press('Enter')

    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
    // The visible outcome: the unsaved text does not stick.
    await expect(page.getByTestId('weekly-focus-text')).toHaveText('server text')
  })

  test('the header shows the Sunday–Thursday week range', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('weekly-focus-dates')).toHaveText(/\d.*–.*\d/)
  })
})

test.describe('react active board: global progress', () => {
  test('shows the active project with its ratio and a proportional fill, and hides again when there is none', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    await pushSnapshot(page, { activeProject: { projectBase: 'react-migration', current: 3, total: 4 } })
    const bar = page.locator('#global-progress')
    await expect(bar).toBeVisible()
    await expect(bar.getByTestId('global-progress-label')).toHaveText('react-migration')
    await expect(bar.getByTestId('global-progress-ratio')).toHaveText('3/4')
    expect(await bar.getByTestId('global-progress-fill').evaluate((el) => (el as HTMLElement).style.width)).toBe('75%')

    await pushSnapshot(page, { activeProject: null })
    await expect(bar).toBeHidden()
    await expect(bar.getByTestId('global-progress-label')).toHaveCount(0)
  })

  test('a project with zero total steps renders no bar rather than dividing by zero', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    await pushSnapshot(page, { activeProject: { projectBase: 'empty-plan', current: 0, total: 0 } })

    await expect(page.locator('#global-progress')).toBeHidden()
  })
})

test.describe('react active board: card actions', () => {
  test('a "See details" footer CTA opens that task\'s detail view', async ({ page }) => {
    await page.goto('/')
    await card(page, SEE_DETAILS_SLUG).getByTestId('card-cta-btn').click()

    await expect(page).toHaveURL(`/task/${SEE_DETAILS_SLUG}`)
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  test('clicking a card\'s title opens its detail view; clicking a button inside it does not also open it', async ({ page }) => {
    await page.goto('/')
    await page.route('**/focus/**', (route) => route.fulfill({ status: 200, body: '{}' }))
    await card(page, WORKING_SLUG).getByTestId('focus-btn').click()
    await expect(page).toHaveURL('/')

    await card(page, WORKING_SLUG).locator('.card-title').click()
    await expect(page).toHaveURL(`/task/${WORKING_SLUG}`)
  })

  test('the stage CTA posts the stage to /stage-skill, and a server failure flashes the button and logs an [action] error', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    const requests: { url: string; body: unknown }[] = []
    await page.route('**/stage-skill/**', async (route) => {
      requests.push({ url: route.request().url(), body: route.request().postDataJSON() })
      await route.fulfill({ status: 500, body: 'boom' })
    })
    await page.goto('/')

    const cta = card(page, STAGE_CTA_SLUG).getByTestId('card-cta-btn')
    await cta.click()

    await expect(cta).toHaveClass(/btn-err/)
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toContain(`/stage-skill/${STAGE_CTA_SLUG}`)
    expect(requests[0].body).toEqual({ stage: 'dev', autoSubmit: false })
  })

  test('the stage CTA succeeding flashes it as staged', async ({ page }) => {
    await page.route('**/stage-skill/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"submitted":false}' }))
    await page.goto('/')

    const cta = card(page, STAGE_CTA_SLUG).getByTestId('card-cta-btn')
    await cta.click()

    await expect(cta).toHaveClass(/btn-ok/)
  })

  test('a hot, parked card offers Handover, and it stages through /pipelinely-handover', async ({ page }) => {
    const requests: string[] = []
    await page.route('**/pipelinely-handover/**', async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"submitted":false}' })
    })
    await page.goto('/')

    const pill = card(page, HOT_PAUSED_SLUG).getByTestId('card-handover')
    await expect(pill).toBeVisible()
    await pill.click()

    await expect(pill).toHaveClass(/btn-ok/)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain(`/pipelinely-handover/${HOT_PAUSED_SLUG}`)
  })

  test('Merge asks for confirmation, and declining sends nothing', async ({ page }) => {
    const requests: string[] = []
    await page.route('**/merge-pr/**', (route) => { requests.push(route.request().url()); return route.fulfill({ status: 200, body: '{}' }) })
    page.once('dialog', (dialog) => dialog.dismiss())
    await page.goto('/')

    await card(page, MERGE_SLUG).getByTestId('card-merge-pr-btn').click()

    await expect(card(page, MERGE_SLUG).getByTestId('merge-banner')).toHaveCount(0)
    expect(requests).toEqual([])
  })

  test('a successful merge asks for confirmation, posts once, shows no banner, and leaves the button usable', async ({ page }) => {
    const requests: string[] = []
    await page.route('**/merge-pr/**', (route) => {
      requests.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prNumber: '42' }) })
    })
    page.once('dialog', (dialog) => dialog.accept())
    await page.goto('/')

    const mergeBtn = card(page, MERGE_SLUG).getByTestId('card-merge-pr-btn')
    await mergeBtn.click()

    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toContain(`/merge-pr/${MERGE_SLUG}`)
    await expect(mergeBtn).toBeEnabled()
    await expect(card(page, MERGE_SLUG).getByTestId('merge-banner')).toHaveCount(0)
  })

  // The merge itself runs through mergeTask (api/mergeTask.ts, shared with the
  // Merge tab, see CardFooter.tsx), which reports a rejection as this banner rather
  // than a console line.
  test('a rejected merge persists a banner listing every blocker line', async ({ page }) => {
    await page.route('**/merge-pr/**', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'checks are failing\nbranch is behind main' }) }),
    )
    page.once('dialog', (dialog) => dialog.accept())
    await page.goto('/')

    const mergeBtn = card(page, MERGE_SLUG).getByTestId('card-merge-pr-btn')
    await mergeBtn.click()

    const banner = card(page, MERGE_SLUG).getByTestId('merge-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('data-tone', 'error')
    await expect(banner.getByTestId('merge-banner-line')).toHaveCount(2)
    // Back to clickable once the request settled — not stranded disabled.
    await expect(mergeBtn).toBeEnabled()
  })

  test('the card menu\'s off-focus toggle marks the card, and the shared client state survives an SSE push', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()

    await card(page, WORKING_SLUG).getByTestId('card-menu-btn').click()
    await card(page, WORKING_SLUG).getByTestId('card-menu-toggle-off-focus').click()

    await expect(card(page, WORKING_SLUG).locator('.drift-pill')).toBeVisible()

    const snapshot = await page.evaluate(() => fetch('/api/tasks').then((r) => r.json()))
    await page.evaluate((payload) => {
      window.es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(payload) }))
    }, snapshot)
    await expect(card(page, WORKING_SLUG).locator('.drift-pill')).toBeVisible()
  })

  // No committed fixture carries a PLAN.md (task.plan is null everywhere), so
  // the donut card (PlanCard) is driven
  // with a hand-built snapshot instead.
  test('a task with a parsed plan gets its plan-progress donut card beside its session card, and a plan with no milestones gets none', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, WORKING_SLUG)).toBeVisible()
    await freezeLiveFeed(page)

    await pushSnapshot(page, {
      taskPatches: {
        [WORKING_SLUG]: { plan: { total: 5, done: 2, milestones: [] } },
        [STAGE_CTA_SLUG]: { plan: { total: 0, done: 0, milestones: [] } },
      },
    })

    await expect(page.getByTestId('plan-card-progress')).toHaveText('2/5')
    await expect(page.getByTestId('plan-card')).toHaveCount(1)
  })
})
