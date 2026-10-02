import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTaskFile } from './fixtures/taskFiles.js'

// The card says "Needs you: waiting for approval" while a live worker
// session for that task sits on a Claude Code permission dialog, and stops
// saying it once the dialog is gone (dashboard-show-blocked-workers).
//
// No real tmux: the e2e webServer resolves `tmux` to e2e/fixtures/bin/tmux,
// whose "live sessions" are the files in e2e/fixtures/panes/ and whose
// capture-pane output is that file's text. Each blocked-approval-* fixture
// task names its own session in TMUX_SESSION; the secondary-session case adds
// a `-cr2` sibling the same way a real pipelinely-cr dispatch does.
//
// Committed red with @pending during planning (VERIFY runs
// `--grep-invert @pending`); the dev stage removed the tag once green — same
// precedent as card-merge-cta.spec.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PANES_DIR = path.join(__dirname, 'fixtures', 'panes')

const MCP_SLUG = 'blocked-approval-mcp'
const SECONDARY_SLUG = 'blocked-approval-secondary'
const NOISE_SLUG = 'blocked-approval-noise'
const DONE_SLUG = 'blocked-approval-done'
const CLEARS_SLUG = 'blocked-approval-clears'

// What a pane looks like once the developer answered the dialog: the worker
// is back to running, with its normal input box at the bottom.
const CLEARED_PANE = [
  '⏺ Navigated to http://127.0.0.1:3030/ — the card renders.',
  '',
  '✻ Thinking… (3s · esc to interrupt)',
  '',
  '────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────',
  '  ? for shortcuts',
  '',
].join('\n')

// Comfortably above the COCKPIT_APPROVAL_POLL_MS the e2e webServer sets, so a
// pane change is picked up by at least one poll plus the SSE push.
const POLL_SETTLE_MS = 10_000
// A phone-width card.
const NARROW_VIEWPORT_WIDTH = 390

function card(page: Page, slug: string) {
  return page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
}

function approvalCallout(page: Page, slug: string) {
  return card(page, slug).getByTestId('card-approval')
}

interface ApiApprovalPrompt {
  session: string
  question: string
  summary: string
}

async function approvalPromptFromApi(page: Page, slug: string): Promise<ApiApprovalPrompt | null | undefined> {
  const response = await page.request.get('/api/tasks')
  const snapshot = (await response.json()) as { tasks: { slug: string; approvalPrompt?: ApiApprovalPrompt | null }[] }
  return snapshot.tasks.find((task) => task.slug === slug)?.approvalPrompt
}

test.describe('blocked-on-approval workers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('a session showing a permission dialog puts its card in the needs-you state with the callout', async ({ page }) => {
    await expect(card(page, MCP_SLUG)).toHaveAttribute('data-status', 'needs-you', { timeout: POLL_SETTLE_MS })
    await expect(approvalCallout(page, MCP_SLUG)).toBeVisible()
    await expect(approvalCallout(page, MCP_SLUG).getByTestId('card-approval-label')).toBeVisible()
    await expect(approvalCallout(page, MCP_SLUG)).toHaveAttribute('data-session', `worker-${MCP_SLUG}`)
  })

  test('the callout summarises what the dialog is asking, in full and wrapped, never clipped', async ({ page }) => {
    // Narrow enough that a one-line, ellipsis-clipped summary would cut text off.
    await page.setViewportSize({ width: NARROW_VIEWPORT_WIDTH, height: 900 })
    const summary = approvalCallout(page, MCP_SLUG).getByTestId('card-approval-summary')
    await expect(summary).toBeVisible({ timeout: POLL_SETTLE_MS })
    await expect(summary).toContainText('playwright - browser_navigate')
    // The whole summary is on the card, not behind a hover title: a hidden
    // scope of a persistent grant is a safety problem (answer-dialog M1).
    const prompt = await approvalPromptFromApi(page, MCP_SLUG)
    await expect(summary).toHaveText(prompt!.summary)
    const layout = await summary.evaluate((el) => {
      const computed = getComputedStyle(el)
      return { whiteSpace: computed.whiteSpace, textOverflow: computed.textOverflow, isClipped: el.scrollWidth > el.clientWidth }
    })
    expect(layout.whiteSpace).not.toBe('nowrap')
    expect(layout.textOverflow).not.toBe('ellipsis')
    expect(layout.isClipped).toBe(false)
  })

  test('the blocked card keeps the terminal button to reach its tab', async ({ page }) => {
    await expect(approvalCallout(page, MCP_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
    await expect(card(page, MCP_SLUG).getByTestId('focus-btn')).toBeVisible()
  })

  test('a blocked card sits in the Needs you group and counts toward the waiting pulse chip', async ({ page }) => {
    await expect(approvalCallout(page, MCP_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
    await expect(page.getByTestId('active-group-needs').locator(`[data-testid="task-card"][data-slug="${MCP_SLUG}"]`)).toBeVisible()
    // Both numbers read in one evaluation and polled together: the approval
    // poll changes the needs-you count at runtime (the clears case below
    // flips its pane on the same shared server), so counting cards first and
    // then waiting for the chip to match that stale count would flake.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const chip = document.querySelector('[data-testid="pulse-chip-waiting"] .pulse-chip-value')?.textContent ?? null
          const cards = String(document.querySelectorAll('[data-testid="task-card"][data-status="needs-you"]').length)
          return chip === cards
        }),
      )
      .toBe(true)
  })

  test('a dialog in a secondary session (-cr2) is detected and names that session', async ({ page }) => {
    await expect(approvalCallout(page, SECONDARY_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
    await expect(approvalCallout(page, SECONDARY_SLUG)).toHaveAttribute('data-session', `worker-${SECONDARY_SLUG}-cr2`)
    await expect(approvalCallout(page, SECONDARY_SLUG).getByTestId('card-approval-summary')).toContainText('npx vitest run')
  })

  test('dialog-shaped scrollback and a staged prompt shaped like a selected option are not a blocked state', async ({ page }) => {
    // Wait for the blocked fixture first, so this negative assertion runs
    // after at least one poll has completed rather than passing vacuously.
    await expect(approvalCallout(page, MCP_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
    await expect(card(page, NOISE_SLUG)).toBeVisible()
    await expect(approvalCallout(page, NOISE_SLUG)).toHaveCount(0)
    await expect(card(page, NOISE_SLUG)).not.toHaveAttribute('data-status', 'needs-you')
    expect(await approvalPromptFromApi(page, NOISE_SLUG)).toBeNull()
  })

  test('a done task is never reported as blocked, even if its pane still shows a dialog', async ({ page }) => {
    await expect(approvalCallout(page, MCP_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
    expect(await approvalPromptFromApi(page, DONE_SLUG)).toBeNull()
    await expect(page.locator(`[data-slug="${DONE_SLUG}"] [data-testid="card-approval"]`)).toHaveCount(0)
  })

  test('the API carries the derived prompt without changing STATUS on disk', async ({ page }) => {
    const statusBefore = await readTaskFile(MCP_SLUG, 'STATUS')
    await expect(approvalCallout(page, MCP_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
    const prompt = await approvalPromptFromApi(page, MCP_SLUG)
    expect(prompt?.session).toBe(`worker-${MCP_SLUG}`)
    expect(prompt?.question).toBe('Do you want to proceed?')
    expect(await readTaskFile(MCP_SLUG, 'STATUS')).toBe(statusBefore)
  })
})

test.describe('blocked state clears when the dialog is answered', () => {
  const panePath = path.join(PANES_DIR, `worker-${CLEARS_SLUG}.txt`)
  let originalPane: string

  test.beforeEach(async ({ page }) => {
    originalPane = await fs.readFile(panePath, 'utf-8')
    await page.goto('/')
  })

  test.afterEach(async () => {
    await fs.writeFile(panePath, originalPane)
  })

  test('the callout disappears once the pane no longer shows the dialog, and returns when it does', async ({ page }) => {
    await expect(approvalCallout(page, CLEARS_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })

    await fs.writeFile(panePath, CLEARED_PANE)
    await expect(approvalCallout(page, CLEARS_SLUG)).toHaveCount(0, { timeout: POLL_SETTLE_MS })
    await expect(card(page, CLEARS_SLUG)).not.toHaveAttribute('data-status', 'needs-you')

    await fs.writeFile(panePath, originalPane)
    await expect(approvalCallout(page, CLEARS_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
  })
})
