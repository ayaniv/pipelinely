import { test, expect } from '@playwright/test'

// At phone width the sidebar is an off-canvas drawer, and the hamburger opens
// it. A cold load of a task detail starts the sidebar `is-collapsed` (icon
// rail), and the drawer must still show the tab names and counts: a drawer of
// bare icons has no labels to read.
//
// Regression: the `@media (max-width:860px)` override that undoes the
// collapsed rail was declared before the base `.is-collapsed .tab-label`
// rule at equal specificity, so the base `display:none` won.

const PHONE = { width: 390, height: 844 }
const DETAIL_SLUG = 'dev-ready'
const DRAWER_TABS = ['backlog', 'inprogress', 'done'] as const

test.use({ viewport: PHONE })

test.describe('the mobile drawer on a cold-loaded task detail', () => {
  test('shows every tab\'s label and count, not just its icon', async ({ page }) => {
    await page.goto(`/task/${DETAIL_SLUG}`)
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/is-collapsed/)

    await page.getByTestId('sidebar-open-toggle').click()
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/is-mobile-open/)

    for (const tab of DRAWER_TABS) {
      await expect(page.getByTestId(`tab-label-${tab}`)).toBeVisible()
      await expect(page.getByTestId(`tab-count-${tab}`)).toBeVisible()
    }
  })
})
