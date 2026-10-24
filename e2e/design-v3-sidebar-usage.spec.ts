import { test, expect, type Page } from '@playwright/test'
import { DESKTOP } from './fixtures/designTokens'

// dashboard-v3-update M0 — sidebar tab order, the account row's collapsible
// Settings / Usage / Docs / Help group, and the Usage view that now owns the
// work-density heatmap (REQUEST-v3-full.md §1, was CLAUDE_CODE_PROMPT_v3.md "Sidebar" and "Header and
// tabs"; Pipelinely Dashboard v3.dc.html `userOpen` / `openUsage`). The You
// tab is replaced by Usage. Was committed red, tagged @pending; M0's dev stage
// removed the tags once green.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const GROUP_ITEMS = ['sidebar-settings-btn', 'sidebar-usage-btn', 'sidebar-docs-btn', 'sidebar-help-btn']

const account = (page: Page) => page.getByTestId('sidebar-account')
const group = (page: Page) => page.getByTestId('sidebar-account-menu')

async function openGroup(page: Page) {
  await account(page).click()
  await expect(group(page)).toHaveAttribute('data-open', 'true')
}

test.describe('sidebar tab order', () => {
  test('the counted tabs read Active, Done, Backlog', async ({ page }) => {
    await page.goto('/')
    const tabs = await page.locator('#tab-bar .tab-btn').evaluateAll((els) => els.map((el) => el.getAttribute('data-tab')))
    expect(tabs).toEqual(['inprogress', 'done', 'backlog'])
  })
})

test.describe('account row toggles the Settings / Usage / Docs / Help group', () => {
  test('the group starts closed and its items are not reachable', async ({ page }) => {
    await page.goto('/')
    await expect(group(page)).toHaveAttribute('data-open', 'false')
    await expect(account(page)).toHaveAttribute('aria-expanded', 'false')
    for (const id of GROUP_ITEMS) await expect(page.getByTestId(id)).toBeHidden()
  })

  test('clicking the account row opens the group above it, in order, without navigating', async ({ page }) => {
    await page.goto('/')
    await openGroup(page)
    await expect(account(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page).toHaveURL('/')

    const order = await group(page).evaluate((el) =>
      Array.from(el.querySelectorAll('[data-testid]')).map((item) => item.getAttribute('data-testid')))
    expect(order.filter((id) => id && id.startsWith('sidebar-') && id.endsWith('-btn'))).toEqual(GROUP_ITEMS)
    for (const id of GROUP_ITEMS) await expect(page.getByTestId(id)).toBeVisible()

    // The group sits above the account row. Measure once the open transition
    // (a translateY lift) has settled, not mid-animation.
    await expect(group(page)).toHaveCSS('transform', 'none')
    const [groupBox, accountBox] = await Promise.all([group(page).boundingBox(), account(page).boundingBox()])
    expect(groupBox!.y + groupBox!.height).toBeLessThanOrEqual(accountBox!.y + 1)
  })

  test('the chevron rotates open and back', async ({ page }) => {
    await page.goto('/')
    const chevron = page.getByTestId('sidebar-account-chevron')
    await expect(chevron).toHaveCSS('transform', 'none')
    await openGroup(page)
    await expect(chevron).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)')
    await account(page).click()
    await expect(group(page)).toHaveAttribute('data-open', 'false')
    await expect(chevron).toHaveCSS('transform', 'none')
    for (const id of GROUP_ITEMS) await expect(page.getByTestId(id)).toBeHidden()
  })

  test('the group animates height and opacity rather than snapping', async ({ page }) => {
    await page.goto('/')
    const transition = await group(page).evaluate((el) => getComputedStyle(el).transitionProperty)
    expect(transition).toMatch(/grid-template-rows|height|max-height/)
    expect(transition).toMatch(/opacity|all/)
  })

  test('Settings in the group still opens the Settings page', async ({ page }) => {
    await page.goto('/')
    await openGroup(page)
    await page.getByTestId('sidebar-settings-btn').click()
    await expect(page).toHaveURL('/settings')
  })
})

test.describe('Usage view', () => {
  test('Usage opens the Usage view with the heatmap and leaves the group open', async ({ page }) => {
    await page.goto('/')
    await openGroup(page)
    await page.getByTestId('sidebar-usage-btn').click()
    await expect(page).toHaveURL('/usage')
    await expect(page.getByTestId('usage-section')).toBeVisible()
    await expect(page.getByTestId('usage-section').getByTestId('density-cell').first()).toBeVisible()
    await expect(page.getByTestId('usage-section').getByTestId('density-total')).toBeVisible()
    await expect(group(page)).toHaveAttribute('data-open', 'true')
  })

  test('a cold load of /usage renders the heatmap', async ({ page }) => {
    await page.goto('/usage')
    await expect(page.getByTestId('usage-section').getByTestId('density-cell').first()).toBeVisible()
  })

  test('the old /you URL lands on Usage instead of an empty page', async ({ page }) => {
    await page.goto('/you')
    await expect(page).toHaveURL('/usage')
    await expect(page.getByTestId('usage-section')).toBeVisible()
  })
})

test.describe('account group highlight follows the page showing', () => {
  const currentItems = (page: Page) =>
    page.locator('[data-testid^="sidebar-"][data-testid$="-btn"][aria-current="page"]')

  test('Usage, then Docs, then a board tab: the highlight moves and then clears', async ({ page }) => {
    await page.goto('/')
    await openGroup(page)

    await page.getByTestId('sidebar-usage-btn').click()
    await expect(page).toHaveURL('/usage')
    await expect(group(page)).toHaveAttribute('data-open', 'true')
    await expect(page.getByTestId('sidebar-usage-btn')).toHaveAttribute('aria-current', 'page')
    await expect(account(page)).not.toHaveClass(/is-active/)

    await page.getByTestId('sidebar-docs-btn').click()
    await expect(page).toHaveURL('/docs')
    await expect(page.getByTestId('sidebar-docs-btn')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('sidebar-usage-btn')).not.toHaveAttribute('aria-current', 'page')

    await page.getByTestId('tab-btn-done').click()
    await expect(page).toHaveURL('/done')
    await expect(currentItems(page)).toHaveCount(0)
    await expect(account(page)).not.toHaveClass(/is-active/)
  })

  test('with the group closed, the account row is marked on /usage only', async ({ page }) => {
    await page.goto('/usage')
    await expect(group(page)).toHaveAttribute('data-open', 'false')
    await expect(account(page)).toHaveClass(/is-active/)
    await openGroup(page)
    await expect(page.getByTestId('sidebar-usage-btn')).toHaveAttribute('aria-current', 'page')
    await expect(account(page)).not.toHaveClass(/is-active/)

    await page.goto('/settings')
    await expect(group(page)).toHaveAttribute('data-open', 'false')
    await expect(account(page)).not.toHaveClass(/is-active/)
  })
})
