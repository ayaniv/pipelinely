import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { FIXTURE_REMOTE_TOKEN_FILE } from './fixtures/fixtureDirs'

// Remote-mode auth (privacy-remote-auth-plan), seen from a browser. Written
// red during planning; passing now that the gate exists.
//
// The fixture server listens on loopback only, so a phone is simulated the
// same way `tailscale serve` presents one: a loopback connection carrying a
// proxy header. remoteAuth.test.ts proves the server treats that as remote;
// this suite proves what the person on the phone actually sees. A genuinely
// non-loopback peer is covered in vitest (server.remoteAuth.test.ts).
//
// The server reads the token from FIXTURE_REMOTE_TOKEN_FILE on every request
// (playwright.config.ts points PIPELINELY_REMOTE_TOKEN_FILE at it), so each
// test turns remote access on or off by writing or deleting that file. It is
// never the developer's real ~/.config/pipelinely/remote-token.

// Fresh per run, never a constant in the repo: if PIPELINELY_REMOTE_TOKEN_FILE
// ever leaked into a real server's environment, that server would trust
// whatever this suite writes, and a committed token would be a public one.
function freshToken(): string {
  return randomBytes(32).toString('base64url')
}

const TOKEN = freshToken()
const PROXIED = { 'X-Forwarded-For': '100.64.1.2' }

async function enableRemoteAccess(): Promise<void> {
  await fs.mkdir(path.dirname(FIXTURE_REMOTE_TOKEN_FILE), { recursive: true })
  await fs.writeFile(FIXTURE_REMOTE_TOKEN_FILE, TOKEN, { mode: 0o600 })
}

async function disableRemoteAccess(): Promise<void> {
  await fs.rm(FIXTURE_REMOTE_TOKEN_FILE, { force: true })
}

// Every test here shares the one token file, so they cannot interleave.
test.describe.configure({ mode: 'serial' })

test.afterEach(disableRemoteAccess)

test.describe('the desktop (plain loopback) — the regression constraint', () => {
  test('opens straight into the dashboard with no login, even with remote access on', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/')
    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(page.getByTestId('remote-login-form')).toHaveCount(0)
  })

  test('shows no sign-out control in Settings', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/settings')
    await expect(page.getByTestId('settings-page')).toBeVisible()
    await expect(page.getByTestId('remote-logout-btn')).toHaveCount(0)
  })
})

test.describe('a phone reaching the dashboard remotely', () => {
  test.use({ extraHTTPHeaders: PROXIED })

  test('lands on the login form instead of the dashboard', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/')
    await expect(page.getByTestId('remote-login-form')).toBeVisible()
    await expect(page.getByTestId('active-sessions')).toHaveCount(0)
  })

  test('a deep link to a task also lands on the login form', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/task/dev-ready')
    await expect(page.getByTestId('remote-login-form')).toBeVisible()
  })

  test('a wrong token keeps the form up with an error', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/')
    await page.getByTestId('remote-login-token').fill(freshToken())
    await page.getByTestId('remote-login-submit').click()
    await expect(page.getByTestId('remote-login-error')).toBeVisible()
    await expect(page.getByTestId('remote-login-form')).toBeVisible()
  })

  test('the right token opens the live dashboard, and it survives a reload', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/')
    await page.getByTestId('remote-login-token').fill(TOKEN)
    await page.getByTestId('remote-login-submit').click()
    await expect(page.getByTestId('active-sessions')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('active-sessions')).toBeVisible()
  })

  test('signing out from Settings returns to the login form', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/')
    await page.getByTestId('remote-login-token').fill(TOKEN)
    await page.getByTestId('remote-login-submit').click()
    await page.goto('/settings')

    await page.getByTestId('remote-logout-btn').click()
    await expect(page.getByTestId('remote-login-form')).toBeVisible()
    await page.goto('/')
    await expect(page.getByTestId('remote-login-form')).toBeVisible()
  })

  // Rotating the token is the revoke-every-device action; an open phone tab
  // must notice on its next load rather than keep showing stale data.
  test('a rotated token sends a signed-in phone back to the login form', async ({ page }) => {
    await enableRemoteAccess()
    await page.goto('/')
    await page.getByTestId('remote-login-token').fill(TOKEN)
    await page.getByTestId('remote-login-submit').click()
    await expect(page.getByTestId('active-sessions')).toBeVisible()

    await fs.writeFile(FIXTURE_REMOTE_TOKEN_FILE, freshToken(), { mode: 0o600 })
    await page.reload()
    await expect(page.getByTestId('remote-login-form')).toBeVisible()
  })

  test('with remote access off, explains that instead of offering a form', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('remote-access-disabled')).toBeVisible()
    await expect(page.getByTestId('remote-login-form')).toHaveCount(0)
  })
})
