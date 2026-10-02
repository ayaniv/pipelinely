import { test, expect, type Page } from '@playwright/test'
import { selectBoardTab } from './fixtures/boardTabs.js'

// M7 of react-migration (see tech-design-react-migration.md): the last
// milestone. Every dashboard view lives in React, so the legacy host — the
// classic app.js, its static markup in web/index.html and the legacy.css it
// loaded — is gone, and with it the synchronous history bridge
// (window.cockpitShell.syncRouter) that kept the router and app.js's own
// pushState writes in step. Planned red (tagged @pending) and untagged once
// green, so VERIFY's `--grep-invert @pending` now runs it.
//
// Everything here is observable from outside the bundle: which requests a
// cold load makes, what the served HTML contains, which globals exist, and
// that every view is still reachable with a URL that round-trips. Selectors
// are data-testid only.

const DEMO_SLUG = 'demo-task'
const demoCard = (page: Page) => page.locator(`[data-testid="task-card"][data-slug="${DEMO_SLUG}"]`)
const shell = (page: Page) => page.getByTestId('react-shell')

// One row per route the shell serves, with the view each one shows.
const ROUTES = [
  { path: '/', route: 'inprogress', view: 'active-sessions' },
  { path: '/backlog', route: 'backlog', view: 'backlog-section' },
  { path: '/done', route: 'done', view: 'done-section' },
  { path: '/you', route: 'you', view: 'you-section' },
  { path: '/settings', route: 'settings', view: 'settings-page' },
  { path: '/help', route: 'help', view: 'help-page' },
  { path: '/docs', route: 'docs', view: 'docs-page' },
  { path: `/task/${DEMO_SLUG}`, route: 'task', view: 'task-detail' },
] as const

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

function collectRequestedPaths(page: Page): string[] {
  const paths: string[] = []
  page.on('request', (request) => paths.push(new URL(request.url()).pathname))
  return paths
}

const pathOf = (page: Page) => new URL(page.url()).pathname

test.describe('legacy host retired', () => {
  test('the served HTML carries no legacy markup, script or stylesheet', async ({ request }) => {
    const html = await (await request.get('/')).text()

    expect(html).not.toContain('legacy-host')
    expect(html).not.toContain('/legacy/')
    expect(html).not.toContain('sidebar-collapsed-init')
  })

  test('the legacy script and stylesheet are no longer served', async ({ request }) => {
    expect((await request.get('/legacy/app.js')).status()).toBe(404)
    expect((await request.get('/legacy/legacy.css')).status()).toBe(404)
  })

  for (const { path: routePath, route, view } of ROUTES) {
    test(`cold load of ${routePath} requests nothing under /legacy and shows its view`, async ({ page }) => {
      const pageErrors = collectPageErrors(page)
      const requestedPaths = collectRequestedPaths(page)
      await page.goto(routePath)

      await expect(shell(page)).toHaveAttribute('data-route', route)
      await expect(page.getByTestId(view)).toBeVisible()
      await expect(page.getByTestId('legacy-host')).toHaveCount(0)
      expect(requestedPaths.filter((requestedPath) => requestedPath.startsWith('/legacy'))).toEqual([])
      expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
    })
  }

  test('the page has no legacy script, stylesheet link or bridge global', async ({ page }) => {
    await page.goto('/')
    await expect(demoCard(page)).toBeVisible()

    await expect(page.locator('script[src*="legacy"]')).toHaveCount(0)
    await expect(page.locator('link[rel="stylesheet"][href*="legacy"]')).toHaveCount(0)

    const bridges = await page.evaluate(() => ({
      cockpitLegacy: typeof (window as unknown as Record<string, unknown>).cockpitLegacy,
      cockpitShell: typeof (window as unknown as Record<string, unknown>).cockpitShell,
    }))
    expect(bridges).toEqual({ cockpitLegacy: 'undefined', cockpitShell: 'undefined' })
  })

  // The CSS moved into the React tree as-is (one global stylesheet), so the
  // page must still be styled by a bundled sheet rather than by nothing.
  test('the styling ships in the bundle, not a separate legacy sheet', async ({ page }) => {
    await page.goto('/')
    await expect(demoCard(page)).toBeVisible()

    const stylesheetHrefs = await page.evaluate(() =>
      Array.from(document.styleSheets, (sheet) => sheet.href).filter((href): href is string => href !== null),
    )
    expect(stylesheetHrefs.length).toBeGreaterThan(0)
    for (const href of stylesheetHrefs) expect(new URL(href).pathname.startsWith('/assets/')).toBe(true)

    // A real layout rule, not merely a loaded sheet: the sidebar is a fixed
    // column beside the content, which only holds while its CSS applies.
    const sidebarWidth = await page.getByTestId('app-sidebar').evaluate((el) => el.getBoundingClientRect().width)
    expect(sidebarWidth).toBeGreaterThan(60)
    expect(sidebarWidth).toBeLessThan(400)
  })

  test.describe('the URL is the router\'s alone and still round-trips', () => {
    test('switching board tabs pushes the tab URL, and Back returns through them', async ({ page }) => {
      await page.goto('/')
      await expect(demoCard(page)).toBeVisible()

      await selectBoardTab(page, 'backlog')
      expect(pathOf(page)).toBe('/backlog')
      await expect(shell(page)).toHaveAttribute('data-route', 'backlog')

      await selectBoardTab(page, 'done')
      expect(pathOf(page)).toBe('/done')

      await page.goBack()
      expect(pathOf(page)).toBe('/backlog')
      await expect(shell(page)).toHaveAttribute('data-route', 'backlog')
      await expect(page.getByTestId('backlog-section')).toBeVisible()

      await page.goForward()
      expect(pathOf(page)).toBe('/done')
      await expect(page.getByTestId('done-section')).toBeVisible()
    })

    test('opening a task pushes /task/<slug>, the Back pill returns to the tab it came from', async ({ page }) => {
      await page.goto('/')
      await selectBoardTab(page, 'inprogress')
      await demoCard(page).click()

      expect(pathOf(page)).toBe(`/task/${DEMO_SLUG}`)
      await expect(shell(page)).toHaveAttribute('data-route', 'task')
      await expect(page.getByTestId('task-detail')).toBeVisible()

      await page.getByTestId('detail-close').click()
      expect(pathOf(page)).toBe('/')
      await expect(shell(page)).toHaveAttribute('data-route', 'inprogress')
      await expect(page.getByTestId('task-detail')).toHaveCount(0)
    })

    test('browser Back and Forward move between the board and an open task', async ({ page }) => {
      await page.goto('/')
      await demoCard(page).click()
      await expect(page.getByTestId('task-detail')).toBeVisible()

      await page.goBack()
      expect(pathOf(page)).toBe('/')
      await expect(page.getByTestId('task-detail')).toHaveCount(0)
      await expect(shell(page)).toHaveAttribute('data-route', 'inprogress')

      await page.goForward()
      expect(pathOf(page)).toBe(`/task/${DEMO_SLUG}`)
      await expect(page.getByTestId('task-detail')).toBeVisible()
    })

    test('Escape closes an open task and returns to the board URL', async ({ page }) => {
      await page.goto(`/task/${DEMO_SLUG}`)
      await expect(page.getByTestId('task-detail')).toBeVisible()

      await page.keyboard.press('Escape')
      expect(pathOf(page)).toBe('/')
      await expect(page.getByTestId('task-detail')).toHaveCount(0)
    })

    test('Docs opens from the sidebar with its own URL, and Escape leaves it', async ({ page }) => {
      await page.goto('/')
      await expect(demoCard(page)).toBeVisible()

      await page.getByTestId('sidebar-docs-btn').click()
      expect(pathOf(page)).toBe('/docs')
      await expect(shell(page)).toHaveAttribute('data-route', 'docs')
      await expect(page.getByTestId('docs-page')).toBeVisible()
      await expect(page.getByTestId('docs-body')).not.toBeEmpty()

      await page.keyboard.press('Escape')
      expect(pathOf(page)).toBe('/')
      await expect(page.getByTestId('docs-page')).toHaveCount(0)
    })

    test('a failed Docs load shows the error and does not break the shell', async ({ page }) => {
      await page.route('**/api/docs', (route) => route.fulfill({ status: 500, body: '{}' }))
      const pageErrors = collectPageErrors(page)
      await page.goto('/docs')

      await expect(page.getByTestId('docs-error')).toBeVisible()
      await expect(shell(page)).toHaveAttribute('data-route', 'docs')
      expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
    })

    test('a /task/<unknown-slug> URL lands on the board without throwing', async ({ page }) => {
      const pageErrors = collectPageErrors(page)
      await page.goto('/task/no-such-task')

      await expect(page.getByTestId('task-detail')).toHaveCount(0)
      await expect(shell(page)).toBeVisible()
      expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
    })
  })
})
