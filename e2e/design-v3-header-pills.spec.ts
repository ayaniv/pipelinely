import { test, expect, type Page } from '@playwright/test'
import { selectBoardTab } from './fixtures/boardTabs'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'

// dashboard-v3-update M1 — the Active tab's toolbar: Push forward, then + New task
// (Push forward is the stub Babysit pill's replacement, gated by babysitWiring.ts;
// its own behaviour is pinned in push-forward.spec.ts)
// (REQUEST-v3-full.md §1 "Toolbar row", was CLAUDE_CODE_PROMPT_v3.md "Header
// and tabs"; Pipelinely Dashboard v3.dc.html lines 224-240 and the New task modal at the top of the body). Both actions
// are not both real: New task is a stub (`startTaskInClaude({ prompt, project })`),
// so these cases pin the UI contract around it — gating, modal behaviour — not
// a backend effect.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const HOT_A = 'dev-ready'
const HOT_B = 'cr-fixes-ready'
const COOL = 'merge-ready'

async function openFrozenBoard(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('task-card').first()).toBeVisible()
  await freezeLiveFeed(page)
}

const retiredBabysit = (page: Page) => page.getByTestId('babysit-pill')
const pushForward = (page: Page) => page.getByTestId('push-forward-pill')
const newTaskPill = (page: Page) => page.getByTestId('new-task-pill')
const modal = (page: Page) => page.getByTestId('new-task-modal')

test.describe('header pills: Active only', () => {
  test('Push forward and New task render after the pulse chips on Active and on no other tab', async ({ page }) => {
    await page.goto('/')
    await expect(newTaskPill(page)).toBeVisible()
    await expect(pushForward(page)).toBeVisible()
    await expect(retiredBabysit(page)).toHaveCount(0)

    // Order within the toolbar: working chip, waiting chip, Push forward, New task.
    const order = await page.getByTestId('pulse-chip-working').locator('xpath=..').evaluate((toolbar) =>
      Array.from(toolbar.querySelectorAll('[data-testid]'))
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => ['pulse-chip-working', 'pulse-chip-waiting', 'push-forward-pill', 'new-task-pill'].includes(id ?? '')))
    expect(order).toEqual(['pulse-chip-working', 'pulse-chip-waiting', 'push-forward-pill', 'new-task-pill'])

    for (const tab of ['done', 'backlog'] as const) {
      await selectBoardTab(page, tab)
      await expect(newTaskPill(page)).toBeHidden()
      await expect(pushForward(page)).toBeHidden()
      // The focus band and pulse chips stay on every tab.
      await expect(page.getByTestId('pulse-chip-working')).toBeVisible()
    }
  })

  test('New task is filled ink', async ({ page }) => {
    await page.goto('/')
    expect(await cssOf(newTaskPill(page), 'background-color')).toBe(TOKEN.ink)
  })
})

test.describe('the stub Babysit pill is retired', () => {
  test('a stuck session does not bring it back: Push forward is the only agent pill', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, {
      onlySlugs: [HOT_A, HOT_B, COOL],
      taskPatches: { [HOT_A]: { contextPct: 72 }, [HOT_B]: { contextPct: 91 }, [COOL]: { contextPct: 20 } },
    })
    await expect(newTaskPill(page)).toBeVisible()
    await expect(pushForward(page)).toBeVisible()
    await expect(retiredBabysit(page)).toHaveCount(0)
  })
})

test.describe('New task modal', () => {
  test('opens with its prompt focused and the first project chip selected', async ({ page }) => {
    await page.goto('/')
    await newTaskPill(page).click()
    await expect(modal(page)).toBeVisible()
    await expect(modal(page)).toHaveAttribute('role', 'dialog')
    await expect(page.getByTestId('new-task-prompt')).toBeFocused()

    const chips = page.getByTestId('new-task-project-chip')
    expect(await chips.count()).toBeGreaterThan(1)
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="new-task-project-chip"][aria-pressed="true"]')).toHaveCount(1)
  })

  test('the chips are the same project list the board filter offers', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()
    const filterProjects = await page.locator('[data-testid^="filter-chip-project-"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!.replace('filter-chip-project-', '')))
    await newTaskPill(page).click()
    const modalProjects = await page.getByTestId('new-task-project-chip').evaluateAll((els) => els.map((el) => el.getAttribute('data-project')))
    expect(modalProjects).toEqual(filterProjects)
  })

  test('picking a project chip moves the single selection', async ({ page }) => {
    await page.goto('/')
    await newTaskPill(page).click()
    const second = page.getByTestId('new-task-project-chip').nth(1)
    await second.click()
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="new-task-project-chip"][aria-pressed="true"]')).toHaveCount(1)
  })

  test('Start in Claude stays disabled until the prompt has non-blank text', async ({ page }) => {
    await page.goto('/')
    await newTaskPill(page).click()
    const start = page.getByTestId('new-task-start-btn')
    await expect(start).toBeDisabled()
    await page.getByTestId('new-task-prompt').fill('   ')
    await expect(start).toBeDisabled()
    await page.getByTestId('new-task-prompt').fill('Add a CSV export to the audit log')
    await expect(start).toBeEnabled()
  })

  test('Start in Claude closes the modal, and a reopened modal starts empty', async ({ page }) => {
    await page.goto('/')
    await newTaskPill(page).click()
    await page.getByTestId('new-task-prompt').fill('Add a CSV export to the audit log')
    await page.getByTestId('new-task-start-btn').click()
    await expect(modal(page)).toBeHidden()
    await newTaskPill(page).click()
    await expect(page.getByTestId('new-task-prompt')).toHaveValue('')
  })

  for (const [how, dismiss] of [
    ['Cancel', (page: Page) => page.getByTestId('new-task-cancel-btn').click()],
    ['the scrim', (page: Page) => page.getByTestId('new-task-scrim').click({ position: { x: 5, y: 5 } })],
    ['Escape', (page: Page) => page.keyboard.press('Escape')],
  ] as const) {
    test(`${how} dismisses without starting anything and returns focus to the pill`, async ({ page }) => {
      await page.goto('/')
      await newTaskPill(page).click()
      await page.getByTestId('new-task-prompt').fill('draft that should be discarded')
      await dismiss(page)
      await expect(modal(page)).toBeHidden()
      await expect(newTaskPill(page)).toBeFocused()
    })
  }

  test('a click inside the card does not dismiss it', async ({ page }) => {
    await page.goto('/')
    await newTaskPill(page).click()
    await modal(page).click({ position: { x: 10, y: 10 } })
    await expect(modal(page)).toBeVisible()
  })
})

// REQUEST-v3-full.md §1 lists three pulse chips (Working / Waiting / off
// focus) on every tab; master renders only the first two. The off-focus
// state is client-only (clientState.offFocusSlugs), so the count is driven
// through the card menu. The menu item is looked up from `page`, not the
// card, because M4 moves the open menu into a portal.
test.describe('off focus pulse chip', () => {
  test('there is no off focus chip while every task is in focus', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('pulse-chip-working')).toBeVisible()
    await expect(page.getByTestId('pulse-chip-off-focus')).toHaveCount(0)
  })

  test('marking a card off focus shows the count after the waiting chip, on every tab', async ({ page }) => {
    await page.goto('/')
    await page.locator(`[data-testid="task-card"][data-slug="${HOT_A}"]`).getByTestId('card-menu-btn').click()
    await page.getByTestId('card-menu-toggle-off-focus').click()
    const chip = page.getByTestId('pulse-chip-off-focus')
    await expect(chip).toHaveAttribute('data-count', '1')
    const [waitingBox, chipBox] = await Promise.all([page.getByTestId('pulse-chip-waiting').boundingBox(), chip.boundingBox()])
    expect(chipBox!.x).toBeGreaterThan(waitingBox!.x)

    for (const tab of ['done', 'backlog'] as const) {
      await selectBoardTab(page, tab)
      await expect(chip).toBeVisible()
      await expect(chip).toHaveAttribute('data-count', '1')
    }
  })
})
