import { test, expect, type Page } from '@playwright/test'
import { openWithSnapshot, pushSnapshot } from './fixtures/snapshotStub.js'

// pipelinely-babysit-skill-plan M0 — the recorded QA-start consent. The developer
// approved running the Playwright `ui` project without asking (2026-10-03),
// but only in conversation: nothing a later orchestrator session reads. This
// setting is the one place that consent lives (SETTINGS.json `qaStartPolicy`),
// and auto mode, /pipelinely-babysit and the Push forward pill all read it,
// never anything else. The default is "ask every time".
//
// Snapshots are stubbed (fixtures/snapshotStub.ts) and every write is mocked
// with page.route, so the shared fixture SETTINGS.json is never touched.

const PREAPPROVED = 'cockpit-ai-ui-preapproved'
const ASK = 'ask-every-time'

const qaSwitch = (page: Page) => page.getByTestId('settings-qa-preapproval-switch')

function collectConsoleErrors(page: Page): string[] {
  const messages: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') messages.push(msg.text())
  })
  return messages
}

test.describe('QA start consent setting', () => {
  test('asks every time when the setting was never recorded', async ({ page }) => {
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: true } })
    await expect(qaSwitch(page)).not.toBeChecked()
  })

  test('reflects the recorded setting and follows a change made elsewhere', async ({ page }) => {
    const snapshot = await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false, qaStartPolicy: ASK } })
    await expect(qaSwitch(page)).not.toBeChecked()

    await pushSnapshot(page, { ...snapshot, settings: { autoMode: false, qaStartPolicy: PREAPPROVED } })
    await expect(qaSwitch(page)).toBeChecked()
  })

  test('the auto mode switch is not consent: turning it on leaves QA asking', async ({ page }) => {
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      return route.fulfill({ status: 200, json: {} })
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false, qaStartPolicy: ASK } })

    await page.getByTestId('settings-auto-mode-switch').click()

    await expect(page.getByTestId('settings-auto-mode-switch')).toBeChecked()
    await expect(qaSwitch(page)).not.toBeChecked()
  })

  test('turning it on posts exactly the recorded value and keeps it', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      bodies.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, json: {} })
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false, qaStartPolicy: ASK } })

    await qaSwitch(page).click()

    await expect(qaSwitch(page)).toBeChecked()
    expect(bodies).toEqual([{ qaStartPolicy: PREAPPROVED }])
  })

  test('turning it off posts ask-every-time', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      bodies.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, json: {} })
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false, qaStartPolicy: PREAPPROVED } })

    await qaSwitch(page).click()

    await expect(qaSwitch(page)).not.toBeChecked()
    expect(bodies).toEqual([{ qaStartPolicy: ASK }])
  })

  test('a rejected write reverts the switch to "ask" and logs the failure', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      return route.fulfill({ status: 500, json: { error: 'disk full' } })
    })
    await openWithSnapshot(page, '/settings', (s) => { s.settings = { autoMode: false, qaStartPolicy: ASK } })

    await qaSwitch(page).click()

    await expect(qaSwitch(page)).not.toBeChecked()
    expect(consoleErrors.some((line) => line.includes('[settings]'))).toBe(true)
  })
})
