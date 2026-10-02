import { test, expect, type Page, type Route } from '@playwright/test'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens.js'
import { fetchRealSnapshot, openWithSnapshot, pushSnapshot } from './fixtures/snapshotStub.js'

// The header chrome (orchestrator ctx pill + Handover, spend, live status,
// auto-submit toggle, theme toggle), the read-only banner, and the Settings and
// Help pages are React components (web/src/views/header, web/src/views/pages).
//
// This covers what the frame / header / settings / help specs
// (design-v2-frame, design-v2-orchestrator-ctx, cockpit-ui-reconcile,
// help-feedback, cta-auto-submit-mobile, pipelinely-brand, docs-page,
// handover-dispatch) have no reason to check:
//   - the pieces track the snapshot cache, not a static DOM;
//   - the pages are mounted by their route, not hidden static markup;
//   - every fallible action (orchestrator tab, orchestrator handover,
//     settings write, theme persistence) fails observably: the failure is
//     surfaced on the control AND logged.
//
// Snapshots come from fixtures/snapshotStub.ts (see its comment for why the
// shared fixture dir can't be mutated instead).

test.use({ colorScheme: 'light', viewport: DESKTOP })

const shell = (page: Page) => page.getByTestId('react-shell')

const BOARD_METRICS_SLUG = 'board-metrics'
// board-metrics' own METRICS file: 400k in / 20k out on claude-sonnet-5.
const BOARD_METRICS_SPEND = '$1.00'

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

function collectConsoleErrors(page: Page): string[] {
  const messages: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') messages.push(msg.text())
  })
  return messages
}

test.describe('react header: ownership', () => {
  test('every chrome piece renders exactly once, with no page errors', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/')

    for (const testId of ['header-ctx', 'header-spend', 'header-live']) {
      await expect(page.getByTestId(testId)).toHaveCount(1)
    }
    await expect(page.getByTestId('theme-toggle')).toHaveCount(1)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })
})

test.describe('react header: orchestrator ctx pill', () => {
  test('follows the snapshot: cool shows the meter without Handover, hot adds it, unknown leaves only the home icon', async ({ page }) => {
    await openWithSnapshot(page, '/', (s) => { s.orchestratorContextPct = 30 })
    const snapshot = await fetchRealSnapshot(page)

    await expect(page.getByTestId('header-ctx-value')).toHaveText('30%')
    await expect(page.getByTestId('header-handover')).toHaveCount(0)
    expect(await cssOf(page.getByTestId('header-ctx-fill'), 'background-color')).toBe(TOKEN.accent)

    await pushSnapshot(page, { ...snapshot, orchestratorContextPct: 82 })
    await expect(page.getByTestId('header-ctx-value')).toHaveText('82%')
    await expect(page.getByTestId('header-handover')).toBeVisible()
    expect(await cssOf(page.getByTestId('header-ctx-fill'), 'background-color')).toBe(TOKEN.amber)

    await pushSnapshot(page, { ...snapshot, orchestratorContextPct: null })
    await expect(page.getByTestId('header-ctx')).toBeVisible()
    await expect(page.getByTestId('header-ctx-home-icon')).toBeVisible()
    await expect(page.getByTestId('header-ctx-body')).toHaveCount(0)
    await expect(page.getByTestId('header-handover')).toHaveCount(0)
    await expect(page.getByTestId('orchestrator-tab-btn')).toHaveAttribute('aria-label', 'Bring back the orchestrator tab')
  })

  test('the ctx value is folded into the home control\'s accessible name', async ({ page }) => {
    await openWithSnapshot(page, '/', (s) => { s.orchestratorContextPct = 47 })
    await expect(page.getByTestId('orchestrator-tab-btn')).toHaveAttribute('aria-label', 'Bring back the orchestrator tab (context 47%)')
  })
})

test.describe('react header: orchestrator home button', () => {
  test('a non-canonical instance renders it disabled with the read-only reason', async ({ page }) => {
    await openWithSnapshot(page, '/', (s) => { s.isCanonical = false })

    const button = page.getByTestId('orchestrator-tab-btn')
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', /not the canonical dashboard instance/)
  })

  test('a canonical instance enables it; a successful POST flashes a check then restores the icon and meter', async ({ page }) => {
    await page.route('**/orchestrator/tab', (route) => route.fulfill({ status: 200, json: {} }))
    await openWithSnapshot(page, '/', (s) => { s.isCanonical = true; s.orchestratorContextPct = 30 })

    const button = page.getByTestId('orchestrator-tab-btn')
    await expect(button).toBeEnabled()
    await button.click()

    await expect(button).toHaveClass(/btn-ok/)
    await expect(page.getByTestId('orchestrator-tab-status')).toHaveText('✓')
    await expect(page.getByTestId('header-ctx-home-icon')).toBeHidden()
    await expect(page.getByTestId('header-ctx-value')).toBeHidden()

    await expect(page.getByTestId('header-ctx-home-icon')).toBeVisible({ timeout: 4000 })
    await expect(page.getByTestId('header-ctx-value')).toBeVisible()
    await expect(page.getByTestId('orchestrator-tab-status')).toBeHidden()
    await expect(button).not.toHaveClass(/btn-ok/)
  })

  // The click-driven flash outcomes themselves (server message, "no server")
  // are asserted in design-v2-orchestrator-ctx.spec.ts; what this adds
  // is that each failure is also LOGGED.
  for (const { name, stub, expectedLabel } of [
    { name: 'a non-2xx response', stub: (route: Route) => route.fulfill({ status: 503, json: { error: 'orchestrator not running' } }), expectedLabel: 'orchestrator not running' },
    { name: 'a thrown fetch', stub: (route: Route) => route.abort('connectionrefused'), expectedLabel: 'no server' },
  ]) {
    test(`${name} is logged with the failing route, and the flash shows why`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page)
      await page.route('**/orchestrator/tab', stub)
      await openWithSnapshot(page, '/', (s) => { s.isCanonical = true })

      await page.getByTestId('orchestrator-tab-btn').click()

      await expect(page.getByTestId('orchestrator-tab-btn')).toHaveClass(/btn-err/)
      await expect(page.getByTestId('orchestrator-tab-status')).toHaveText(expectedLabel)
      expect(consoleErrors.some((line) => line.includes('[action]') && line.includes('/orchestrator/tab'))).toBe(true)
    })
  }

  test('a second click while the first is in flight does not send a second request', async ({ page }) => {
    let requestCount = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/orchestrator/tab', async (route) => {
      requestCount++
      await gate
      await route.fulfill({ status: 200, json: {} })
    })
    await openWithSnapshot(page, '/', (s) => { s.isCanonical = true })

    const button = page.getByTestId('orchestrator-tab-btn')
    await button.click()
    await expect(button).toBeDisabled()
    await button.click({ force: true })
    release()

    await expect(button).toHaveClass(/btn-ok/)
    expect(requestCount).toBe(1)
  })
})

test.describe('react header: orchestrator Handover segment', () => {
  test('clicking it stages an orchestrator handover and reports the outcome', async ({ page }) => {
    let posts = 0
    await page.route('**/orchestrator/pipelinely-handover', (route) => { posts++; return route.fulfill({ status: 200, json: {} }) })
    await openWithSnapshot(page, '/', (s) => { s.isCanonical = true; s.orchestratorContextPct = 82 })

    const segment = page.getByTestId('header-handover')
    await segment.click()

    await expect(segment).toHaveClass(/btn-ok/)
    await expect(segment).toHaveText('✓ staged')
    expect(posts).toBe(1)
  })

  test('a 503 surfaces the server\'s message and logs; the segment stays clickable', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/orchestrator/pipelinely-handover', (route) => route.fulfill({ status: 503, json: { error: 'no orchestrator session' } }))
    await openWithSnapshot(page, '/', (s) => { s.isCanonical = true; s.orchestratorContextPct = 82 })

    const segment = page.getByTestId('header-handover')
    await segment.click()

    await expect(segment).toHaveClass(/btn-err/)
    await expect(segment).toHaveText('no orchestrator session')
    await expect(segment).toBeEnabled()
    expect(consoleErrors.some((line) => line.includes('[action]') && line.includes('/orchestrator/pipelinely-handover'))).toBe(true)
  })
})

test.describe('react header: spend pill', () => {
  test('sums only the active on-board tasks, and follows later snapshots', async ({ page }) => {
    const snapshot = await openWithSnapshot(page, '/', (s) => {
      s.tasks = s.tasks.filter((t) => t.slug === BOARD_METRICS_SLUG)
    })
    await expect(page.getByTestId('header-spend')).toContainText(BOARD_METRICS_SPEND)

    const metricsTask = snapshot.tasks[0]
    const doneCopy = { ...metricsTask, slug: 'board-metrics-done-copy', status: 'done' }
    const offBoardCopy = { ...metricsTask, slug: 'board-metrics-offboard-copy', showsOnBoard: false }
    await pushSnapshot(page, { ...snapshot, tasks: [metricsTask, doneCopy, offBoardCopy] })
    await expect(page.getByTestId('header-spend')).toContainText(BOARD_METRICS_SPEND)

    await pushSnapshot(page, { ...snapshot, tasks: [metricsTask, { ...metricsTask, slug: 'board-metrics-second-copy' }] })
    await expect(page.getByTestId('header-spend')).toContainText('$2.00')

    await pushSnapshot(page, { ...snapshot, tasks: [] })
    await expect(page.getByTestId('header-spend')).toContainText('$0.00')
  })
})

test.describe('react header: live status', () => {
  test('goes live on connect, reconnecting on error, and back to live', async ({ page }) => {
    await page.goto('/')
    const status = page.getByTestId('header-live-text')
    await expect(status).toHaveText('live')
    await expect(page.getByTestId('header-live-dot')).toHaveClass(/is-live/)

    await page.evaluate(() => {
      const source = (window as unknown as { es: EventSource }).es
      source.onerror!(new Event('error'))
    })
    await expect(status).toHaveText('reconnecting')
    await expect(page.getByTestId('header-live-dot')).toHaveClass(/is-error/)
    await expect(page.getByTestId('header-live-halo')).toHaveClass(/is-error/)
    await expect(page.getByTestId('header-live-dot')).not.toHaveClass(/is-live/)

    await page.evaluate(() => {
      const source = (window as unknown as { es: EventSource }).es
      source.onopen!(new Event('open'))
    })
    await expect(status).toHaveText('live')
    await expect(page.getByTestId('header-live-dot')).toHaveClass(/is-live/)
    await expect(page.getByTestId('header-live-halo')).toHaveClass(/is-live/)
  })

  test('with /events unreachable it never claims to be live', async ({ page }) => {
    await page.route('**/events', (route) => route.abort())
    await page.goto('/')
    await expect(page.getByTestId('header-live-text')).not.toHaveText('live')
    await expect(page.getByTestId('header-live-dot')).not.toHaveClass(/is-live/)
  })
})

test.describe('react header: theme toggle', () => {
  test('flips the effective theme, its glyph and its accessible name, and persists the choice', async ({ page }) => {
    await page.goto('/')
    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme')
    await expect(toggle).toHaveText('☾')

    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme')
    await expect(toggle).toHaveText('☀')
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('dark')

    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(toggle).toHaveText('☾')
  })

  test('with no explicit choice it follows a live OS scheme change', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('theme-toggle')).toHaveText('☾')

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.getByTestId('theme-toggle')).toHaveText('☀')
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
  })

  test('an explicit choice is not overridden by a later OS scheme change', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('theme-toggle')).toHaveText('☀')

    await page.emulateMedia({ colorScheme: 'light' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.getByTestId('theme-toggle')).toHaveText('☀')
  })

  test('when storage throws, the theme still flips and the failure is logged', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new Error('storage blocked') }
    })
    await page.goto('/')

    await page.getByTestId('theme-toggle').click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('theme-toggle')).toHaveText('☀')
    expect(consoleErrors.some((line) => line.includes('[theme]'))).toBe(true)
  })
})

test.describe('react header: read-only banner', () => {
  test('shows on a non-canonical instance and tracks the snapshot\'s isCanonical', async ({ page }) => {
    const snapshot = await openWithSnapshot(page, '/', (s) => { s.isCanonical = false })
    await expect(page.getByTestId('read-only-banner')).toBeVisible()

    await pushSnapshot(page, { ...snapshot, isCanonical: true })
    await expect(page.getByTestId('read-only-banner')).toHaveCount(0)

    await pushSnapshot(page, { ...snapshot, isCanonical: false })
    await expect(page.getByTestId('read-only-banner')).toBeVisible()
  })

  test('is not shown before the first snapshot has said which instance this is', async ({ page }) => {
    await page.route('**/api/tasks', (route) => route.abort())
    await page.route('**/events', (route) => route.abort())
    await page.goto('/')
    await expect(shell(page)).toBeVisible()
    await expect(page.getByTestId('read-only-banner')).toHaveCount(0)
  })
})

test.describe('react settings page', () => {
  test('is mounted by its route: absent from the DOM on the board, present and the only view on /settings', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/')
    await expect(page.getByTestId('settings-page')).toHaveCount(0)

    await page.getByTestId('sidebar-settings-btn').click()

    await expect(shell(page)).toHaveAttribute('data-route', 'settings')
    expect(new URL(page.url()).pathname).toBe('/settings')
    await expect(page.getByTestId('settings-page')).toHaveCount(1)
    await expect(page.getByTestId('settings-page')).toBeVisible()
    await expect(page.getByTestId('board-column')).toBeHidden()
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })

  test('a cold load of /settings shows the page without a click', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-page')).toBeVisible()
    await expect(page.getByTestId('board-column')).toBeHidden()
  })

  test('the auto mode switch reflects the snapshot and follows a change made elsewhere', async ({ page }) => {
    const snapshot = await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false } })
    const autoModeSwitch = page.getByTestId('settings-auto-mode-switch')
    await expect(autoModeSwitch).not.toBeChecked()

    await pushSnapshot(page, { ...snapshot, settings: { autoMode: true } })
    await expect(autoModeSwitch).toBeChecked()
  })

  test('toggling posts the new value and keeps it', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      bodies.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, json: { autoMode: true } })
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false } })

    await page.getByTestId('settings-auto-mode-switch').click()

    await expect(page.getByTestId('settings-auto-mode-switch')).toBeChecked()
    expect(bodies).toEqual([{ autoMode: true }])
  })

  test('a rejected write reverts the switch and logs the failure', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      return route.fulfill({ status: 500, json: { error: 'disk full' } })
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false } })

    await page.getByTestId('settings-auto-mode-switch').click()

    await expect(page.getByTestId('settings-auto-mode-switch')).not.toBeChecked()
    expect(consoleErrors.some((line) => line.includes('[settings]'))).toBe(true)
  })

  test('a thrown fetch also reverts the switch and logs', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      return route.abort('connectionrefused')
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: true } })

    await page.getByTestId('settings-auto-mode-switch').click()

    await expect(page.getByTestId('settings-auto-mode-switch')).toBeChecked()
    expect(consoleErrors.some((line) => line.includes('[settings]'))).toBe(true)
  })

  test('Escape leaves the page: URL back to /, page unmounted, board visible', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-page')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByTestId('settings-page')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/')
    await expect(page.getByTestId('board-column')).toBeVisible()
    await expect(page.locator('body')).not.toHaveClass(/full-page-open/)
  })

  test('a sidebar tab click leaves the page and lands on that tab', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('tab-btn-backlog').click()

    await expect(page.getByTestId('settings-page')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/backlog')
    await expect(page.getByTestId('board-column')).toBeVisible()
  })

  test('browser Back from /settings returns to the board', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('sidebar-settings-btn').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()

    await page.goBack()

    await expect(page.getByTestId('settings-page')).toHaveCount(0)
    await expect(page.getByTestId('board-column')).toBeVisible()
  })
})

test.describe('react help page', () => {
  test('is mounted by its route, and its Send stays disabled until there is real content', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/')
    await expect(page.getByTestId('help-page')).toHaveCount(0)

    await page.getByTestId('sidebar-help-btn').click()

    await expect(shell(page)).toHaveAttribute('data-route', 'help')
    await expect(page.getByTestId('help-page')).toHaveCount(1)
    await expect(page.getByTestId('board-column')).toBeHidden()
    await expect(page.getByTestId('help-feedback-send')).toBeDisabled()
    await page.getByTestId('help-feedback-input').fill('   ')
    await expect(page.getByTestId('help-feedback-send')).toBeDisabled()
    await page.getByTestId('help-feedback-input').fill('something real')
    await expect(page.getByTestId('help-feedback-send')).toBeEnabled()
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })

  test('a failed send keeps the typed message, and a logged error records why', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/help/pipelinely-feedback', (route) => route.fulfill({ status: 503, json: { error: 'no orchestrator session' } }))
    await page.goto('/help')

    await page.getByTestId('help-feedback-input').fill('keep me')
    await page.getByTestId('help-feedback-send').click()

    await expect(page.getByTestId('help-feedback-send')).toHaveClass(/btn-err/)
    await expect(page.getByTestId('help-feedback-send')).toHaveText('no orchestrator session')
    await expect(page.getByTestId('help-feedback-input')).toHaveValue('keep me')
    expect(consoleErrors.some((line) => line.includes('[action]') && line.includes('/help/pipelinely-feedback'))).toBe(true)
  })

  test('a successful send clears the composer and disables Send again', async ({ page }) => {
    await page.route('**/help/pipelinely-feedback', (route) => route.fulfill({ status: 200, json: {} }))
    await page.goto('/help')

    await page.getByTestId('help-feedback-input').fill('ship it')
    await page.getByTestId('help-feedback-send').click()

    await expect(page.getByTestId('help-feedback-input')).toHaveValue('')
    await expect(page.getByTestId('help-feedback-send')).toBeDisabled()
  })

  test('Escape leaves the page', async ({ page }) => {
    await page.goto('/help')
    // Wait for the page itself before pressing Escape, so the key can't land
    // before the help page (and its key handler) has mounted.
    await expect(page.getByTestId('help-page')).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('help-page')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/')
  })
})

test.describe('full pages are mutually exclusive', () => {
  test('opening Docs from Settings closes Settings, and opening Settings from Docs closes Docs', async ({ page }) => {
    await page.route('**/api/docs', (route) => route.fulfill({ json: { html: '<p>guide</p>' } }))
    await page.goto('/settings')

    await page.getByTestId('sidebar-docs-btn').click()
    await expect(page.getByTestId('docs-page')).toBeVisible()
    await expect(page.getByTestId('settings-page')).toHaveCount(0)

    await page.getByTestId('sidebar-settings-btn').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()
    await expect(page.getByTestId('docs-page')).toBeHidden()
    await expect(page.locator('body')).toHaveClass(/full-page-open/)
  })
})
