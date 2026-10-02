import { test, expect, type Page } from '@playwright/test'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { writeTaskFile } from './fixtures/taskFiles.js'
import { selectBoardTab } from './fixtures/boardTabs.js'

// The React shell the whole page runs under: one Vite bundle, a React Router
// shell that follows the URL, and a single SSE connection feeding every view.
// react-legacy-retired.spec.ts covers what is gone (the classic script, its
// markup and stylesheet); this covers what the shell must still do — that every
// route cold-loads its view, that the router and the URL stay in step through
// back/forward, that one SSE connection reaches the board with no reload, and
// the failure paths around loading.

const LIVE_SLUG = 'react-shell-live'
const liveCard = (page: Page) => page.locator(`[data-testid="task-card"][data-slug="${LIVE_SLUG}"]`)
const demoCard = (page: Page) => page.locator('[data-testid="task-card"][data-slug="demo-task"]')
const shell = (page: Page) => page.getByTestId('react-shell')

// One row per GET route server.ts serves the dashboard shell from, with the
// view testid that route shows.
const SHELL_ROUTES = [
  { path: '/', route: 'inprogress', view: 'active-sessions' },
  { path: '/backlog', route: 'backlog', view: 'backlog-section' },
  { path: '/done', route: 'done', view: 'done-section' },
  { path: '/you', route: 'you', view: 'you-section' },
  { path: '/settings', route: 'settings', view: 'settings-page' },
  { path: '/help', route: 'help', view: 'help-page' },
  { path: '/docs', route: 'docs', view: 'docs-page' },
  { path: '/task/demo-task', route: 'task', view: 'task-detail' },
] as const

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

test.describe('react shell', () => {
  for (const { path: routePath, route, view } of SHELL_ROUTES) {
    test(`cold load of ${routePath} renders its view inside the React shell`, async ({ page }) => {
      const pageErrors = collectPageErrors(page)
      await page.goto(routePath)

      await expect(shell(page)).toHaveAttribute('data-route', route)
      await expect(page.getByTestId(view)).toBeVisible()
      expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
    })
  }

  test('the page is the Vite bundle: one hashed module script, served from /assets', async ({ page }) => {
    await page.goto('/')
    await expect(shell(page)).toBeVisible()

    const scripts = page.locator('script[type="module"][src^="/assets/"]')
    await expect(scripts).not.toHaveCount(0)
    const src = await scripts.first().getAttribute('src')
    expect((await page.request.get(src!)).status()).toBe(200)
  })

  // The SSE bridge's EventSource is exposed as `es` for exactly one reason:
  // specs push a snapshot through the same `onmessage` a real message takes.
  test('the SSE connection is exposed as es, with an onmessage handler specs can drive', async ({ page }) => {
    await page.goto('/')
    await expect(demoCard(page)).toBeVisible()

    expect(await page.evaluate(() => typeof window.es?.onmessage)).toBe('function')
  })

  test('the router follows the URL through tab switches, opening a task, and back/forward', async ({ page }) => {
    await page.goto('/')
    await expect(shell(page)).toHaveAttribute('data-route', 'inprogress')

    await selectBoardTab(page, 'backlog')
    await expect(page).toHaveURL('/backlog')
    await expect(shell(page)).toHaveAttribute('data-route', 'backlog')

    await selectBoardTab(page, 'inprogress')
    await demoCard(page).locator('.card-title').click()
    await expect(page).toHaveURL('/task/demo-task')
    await expect(shell(page)).toHaveAttribute('data-route', 'task')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(shell(page)).toHaveAttribute('data-route', 'inprogress')
    await expect(page.getByTestId('task-detail')).toBeHidden()

    await page.goForward()
    await expect(shell(page)).toHaveAttribute('data-route', 'task')
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  // Both tests below rewrite the same fixture task's STATUS file
  // (LIVE_SLUG) — serialized so they can't race each other's writes the way
  // dashboard-smart-filters.spec.ts's own "the option set tracks the live
  // task list" block does for its shared transient fixture.
  test.describe.serial('react-shell-live fixture', () => {
    test('an SSE push reaches the board with no reload, over a single /events connection', async ({ page }) => {
      const eventStreams: string[] = []
      page.on('request', (req) => { if (new URL(req.url()).pathname === '/events') eventStreams.push(req.url()) })

      await withRestoredFixtureFiles(LIVE_SLUG, ['STATUS'], async () => {
        await page.goto('/')
        await expect(liveCard(page)).toHaveAttribute('data-lifecycle-status', 'working')

        await writeTaskFile(LIVE_SLUG, 'STATUS', 'waiting: react shell live-update probe\n')

        // chokidar/fsevents coalescing on macOS alone is ~1s; 10s is headroom, not an expectation.
        await expect(liveCard(page)).toHaveAttribute('data-lifecycle-status', 'waiting', { timeout: 10_000 })
      })

      // The bridge's EventSource is the only one.
      expect(eventStreams).toHaveLength(1)
    })

    // web/src/data/snapshotCoordinator.ts's own acceptance requirement
    // (tech-design.md, "Explicit bootstrap arbitration"): a cold /api/tasks
    // response that resolves after SSE has already pushed a newer snapshot
    // must not regress the visible board. The delayed response body is
    // captured before the STATUS edit below, so releasing it late proves the
    // coordinator ignores it rather than merely proving it never arrived.
    test('a cold /api/tasks response delayed past an already-accepted SSE push does not regress the board', async ({ page }) => {
      await withRestoredFixtureFiles(LIVE_SLUG, ['STATUS'], async () => {
        let releaseDelayedResponse: () => void = () => {}
        const delayed = new Promise<void>((resolve) => { releaseDelayedResponse = resolve })

        await page.route('**/api/tasks', async (route) => {
          const response = await route.fetch()
          const staleBody = await response.text()
          await delayed
          await route.fulfill({ response, body: staleBody })
        })

        await page.goto('/')
        // This first read comes from SSE's own initial push (server.ts writes
        // one on connect) — the cold response is still held back.
        await expect(liveCard(page)).toHaveAttribute('data-lifecycle-status', 'working')

        await writeTaskFile(LIVE_SLUG, 'STATUS', 'waiting: bootstrap race probe\n')
        await expect(liveCard(page)).toHaveAttribute('data-lifecycle-status', 'waiting', { timeout: 10_000 })

        // Release the cold response now — its captured body still says
        // 'working', from before the STATUS edit above.
        releaseDelayedResponse()
        await page.waitForTimeout(500)
        await expect(liveCard(page)).toHaveAttribute('data-lifecycle-status', 'waiting')
      })
    })
  })
})

test.describe('react shell failure paths', () => {
  test('when /events cannot connect, the live indicator shows the error state and the cold load still renders the board', async ({ page }) => {
    await page.route('**/events', (route) => route.abort())
    await page.goto('/')

    await expect(page.locator('#live-dot')).toHaveClass(/is-error/)
    await expect(demoCard(page)).toBeVisible()
  })

  test('when the cold /api/tasks load fails, the board still fills from SSE and the failure is logged', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    await page.route('**/api/tasks', (route) => route.fulfill({ status: 500, body: 'boom' }))

    await page.goto('/')

    await expect(demoCard(page)).toBeVisible()
    // The browser's own "Failed to load resource: 500" line would satisfy a
    // looser match — the [snapshot] prefix is the app's own log, which used
    // to be a silent .catch(() => {}).
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[snapshot]'))).toBe(true)
  })

  // Same two-sided scoping check design-v2-frame.spec.ts applies to /art —
  // see its comment for why an un-encoded `..` would prove nothing.
  for (const mount of ['/assets']) {
    test(`${mount} rejects an encoded traversal attempt`, async ({ request }) => {
      const res = await request.get(`${mount}/%2e%2e%2f%2e%2e%2f%2e%2e%2fsrc%2fserver.ts`)
      expect(res.status()).not.toBe(200)
    })

    test(`${mount} does not also serve the rest of the build output`, async ({ request }) => {
      // dist/index.html exists and is served by name from the shell routes,
      // so a mount rooted at dist/ instead of dist${mount} would return it.
      const res = await request.get(`${mount}/index.html`)
      expect(res.status()).not.toBe(200)
    })
  }
})
