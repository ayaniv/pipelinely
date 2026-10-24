import { test, expect, type Page, type Route } from '@playwright/test'
import { DESKTOP } from './fixtures/designTokens.js'
import { openWithSnapshot, pushSnapshot, type SnapshotShape } from './fixtures/snapshotStub.js'

// settings-disable-weekly-focus — the Settings switch hides the "focus for this
// week" pane and, server-side, turns the focus into nothing. Fixtures only:
// snapshots come from fixtures/snapshotStub.ts and POST /settings is
// intercepted, so neither the shared SETTINGS.json nor WEEKLY_FOCUS is ever
// written (the `ui` project shares one fixture dir across parallel workers).

test.use({ colorScheme: 'light', viewport: DESKTOP })

const FOCUS_TEXT = 'ship the focus switch'

const withFocus = (isEnabled: boolean) => (snapshot: SnapshotShape) => {
  snapshot.weeklyFocus = isEnabled ? FOCUS_TEXT : ''
  snapshot.settings = { ...snapshot.settings, weeklyFocusEnabled: isEnabled } as SnapshotShape['settings']
}

// Records every POST /settings body and answers 200; GETs fall through.
async function recordSettingsPosts(page: Page): Promise<unknown[]> {
  const bodies: unknown[] = []
  await page.route('**/settings', (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  return bodies
}

test.describe('weekly focus pane', () => {
  test('is on the board while the setting is on', async ({ page }) => {
    await openWithSnapshot(page, '/', withFocus(true))
    await expect(page.getByTestId('weekly-focus-hero')).toBeVisible()
    await expect(page.getByTestId('weekly-focus-text')).toHaveText(FOCUS_TEXT)
  })

  test('is gone from the board while the setting is off, hero and all', async ({ page }) => {
    await openWithSnapshot(page, '/', (snapshot) => {
      withFocus(false)(snapshot)
      snapshot.weeklyFocus = FOCUS_TEXT // a stale stored focus must not leak through either
    })
    await expect(page.getByTestId('board-column')).toBeVisible()
    await expect(page.getByTestId('weekly-focus-hero')).toHaveCount(0)
    await expect(page.getByTestId('weekly-focus-text')).toHaveCount(0)
  })

  test('disappears and comes back as the setting changes, without a reload', async ({ page }) => {
    const snapshot = await openWithSnapshot(page, '/', withFocus(true))
    await expect(page.getByTestId('weekly-focus-hero')).toBeVisible()

    withFocus(false)(snapshot)
    await pushSnapshot(page, snapshot)
    await expect(page.getByTestId('weekly-focus-hero')).toHaveCount(0)

    withFocus(true)(snapshot)
    await pushSnapshot(page, snapshot)
    await expect(page.getByTestId('weekly-focus-text')).toHaveText(FOCUS_TEXT)
  })
})

test.describe('weekly focus Settings switch', () => {
  test('is on by default and describes what it does', async ({ page }) => {
    await openWithSnapshot(page, '/settings', withFocus(true))
    await expect(page.getByTestId('settings-weekly-focus-switch')).toBeChecked()
    await expect(page.getByTestId('settings-weekly-focus-description')).toContainText('focus')
  })

  test('turning it off posts only the flag, and the board then has no pane', async ({ page }) => {
    const bodies = await recordSettingsPosts(page)
    const snapshot = await openWithSnapshot(page, '/settings', withFocus(true))

    await page.getByTestId('settings-weekly-focus-switch').click()
    await expect.poll(() => bodies).toEqual([{ weeklyFocusEnabled: false }])
    await expect(page.getByTestId('settings-weekly-focus-switch')).not.toBeChecked()

    withFocus(false)(snapshot)
    await pushSnapshot(page, snapshot)
    await page.getByTestId('tab-btn-inprogress').click()
    await expect(page.getByTestId('board-column')).toBeVisible()
    await expect(page.getByTestId('weekly-focus-hero')).toHaveCount(0)
  })

  test('is operable from the keyboard', async ({ page }) => {
    const bodies = await recordSettingsPosts(page)
    await openWithSnapshot(page, '/settings', withFocus(true))

    await page.getByTestId('settings-weekly-focus-switch').focus()
    await page.keyboard.press('Space')

    await expect.poll(() => bodies).toEqual([{ weeklyFocusEnabled: false }])
  })

  test('a failed write reverts the switch and logs', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    await page.route('**/settings', (route: Route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: 500, body: '{}' }) : route.fallback())
    await openWithSnapshot(page, '/settings', withFocus(true))

    await page.getByTestId('settings-weekly-focus-switch').click()

    await expect(page.getByTestId('settings-weekly-focus-switch')).toBeChecked()
    expect(consoleErrors.some((line) => line.includes('[settings]'))).toBe(true)
  })
})
