import { test, expect, type Page, type Request, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The card half of answering a blocked worker's Claude Code dialog from the
// dashboard (dashboard-answer-blocked-workers M1): the callout from
// dashboard-show-blocked-workers grows the dialog's question, one button per
// visible option, and a Cancel (Esc) button, each saying which key it sends.
//
// The e2e webServer is not the canonical instance, so a real click is always
// refused by the server (and the fake multiplexer in e2e/fixtures/bin/ records
// any write attempt, which must stay empty). The client's handling of the
// other outcomes is driven by fulfilling POST /answer-dialog/:slug with
// page.route — it checks what the card sends and what it shows, never a real
// key press.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WRITE_ATTEMPTS_LOG = path.join(__dirname, 'fixtures', 'fake-mux', 'write-attempts.log')

const BLOCKED_SLUG = 'answer-dialog-perm'
const BLOCKED_SESSION = `worker-${BLOCKED_SLUG}`
const NOT_BLOCKED_SLUG = 'answer-dialog-none'
const ANSWER_ROUTE = `**/answer-dialog/${BLOCKED_SLUG}`

const POLL_SETTLE_MS = 10_000
// How long to wait for a request that must not be sent.
const NO_REQUEST_WAIT_MS = 1_500
// A phone-width card, where option 2's persistent-grant scope would be the
// first thing an ellipsis cut off.
const NARROW_VIEWPORT_WIDTH = 390

interface ApiApprovalPrompt {
  session: string
  options: { number: number; label: string }[]
  fingerprint: string
}

function card(page: Page, slug: string) {
  return page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
}

function callout(page: Page, slug: string) {
  return card(page, slug).getByTestId('card-approval')
}

function optionButton(page: Page, key: string) {
  return callout(page, BLOCKED_SLUG).locator(`[data-testid="card-approval-option"][data-key="${key}"]`)
}

function result(page: Page) {
  return callout(page, BLOCKED_SLUG).getByTestId('card-approval-result')
}

async function promptFromApi(page: Page): Promise<ApiApprovalPrompt> {
  const response = await page.request.get('/api/tasks')
  const snapshot = (await response.json()) as { tasks: { slug: string; approvalPrompt?: ApiApprovalPrompt | null }[] }
  return snapshot.tasks.find((task) => task.slug === BLOCKED_SLUG)!.approvalPrompt!
}

async function readWriteAttempts(): Promise<string> {
  try {
    return await fs.readFile(WRITE_ATTEMPTS_LOG, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

// Whether the answer route sees more than `allowedCount` requests within
// NO_REQUEST_WAIT_MS. Start it before the action: route handlers run
// asynchronously, so a count read right after a click proves nothing.
function sendsMoreThan(page: Page, allowedCount: number): Promise<boolean> {
  let seenCount = 0
  const isAnswerRequest = (request: Request) => new URL(request.url()).pathname === `/answer-dialog/${BLOCKED_SLUG}`
  return page
    .waitForRequest((request) => isAnswerRequest(request) && ++seenCount > allowedCount, { timeout: NO_REQUEST_WAIT_MS })
    .then(() => true, () => false)
}

function fulfillWith(status: number, body: Record<string, unknown>) {
  return (route: Route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test.describe('answering a blocked worker from its card', () => {
  test.beforeAll(async () => {
    await fs.rm(WRITE_ATTEMPTS_LOG, { force: true })
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(callout(page, BLOCKED_SLUG)).toBeVisible({ timeout: POLL_SETTLE_MS })
  })

  test.afterEach(async () => {
    expect(await readWriteAttempts()).toBe('')
  })

  test('the callout shows the dialog question and one button per option, plus Cancel', async ({ page }) => {
    await expect(callout(page, BLOCKED_SLUG).getByTestId('card-approval-question')).not.toBeEmpty()
    const buttons = callout(page, BLOCKED_SLUG).getByTestId('card-approval-option')
    await expect(buttons).toHaveCount(4)
    expect(await buttons.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-key')))).toEqual(['1', '2', '3', 'Escape'])
  })

  test('each button names the key it sends and the option it picks', async ({ page }) => {
    const prompt = await promptFromApi(page)
    for (const option of prompt.options) {
      const button = optionButton(page, String(option.number))
      await expect(button.getByTestId('card-approval-option-key')).toHaveText(String(option.number))
      await expect(button.getByTestId('card-approval-option-label')).toHaveText(option.label)
    }
    await expect(optionButton(page, 'Escape').getByTestId('card-approval-option-key')).toHaveText('Esc')
  })

  test('every option label and the summary are readable in full without hovering, even on a narrow card', async ({ page }) => {
    await page.setViewportSize({ width: NARROW_VIEWPORT_WIDTH, height: 900 })
    const prompt = await promptFromApi(page)
    const longest = prompt.options.reduce((a, b) => (b.label.length > a.label.length ? b : a))
    await expect(optionButton(page, String(longest.number)).getByTestId('card-approval-option-label')).toHaveText(longest.label)
    const clipped = await callout(page, BLOCKED_SLUG)
      .locator('[data-testid="card-approval-option-label"], [data-testid="card-approval-summary"]')
      .evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth).map((element) => element.textContent))
    expect(clipped).toEqual([])
  })

  test('a card with no detected dialog offers no answer buttons', async ({ page }) => {
    await expect(card(page, NOT_BLOCKED_SLUG)).toBeVisible()
    await expect(card(page, NOT_BLOCKED_SLUG).getByTestId('card-approval-option')).toHaveCount(0)
  })

  test('a real click on the non-canonical fixture server is refused, says so, and the dialog stays', async ({ page }) => {
    await optionButton(page, '1').click()
    await expect(result(page)).toHaveAttribute('data-outcome', 'not-canonical')
    await expect(result(page)).not.toBeEmpty()
    await expect(callout(page, BLOCKED_SLUG)).toBeVisible()
  })

  test('the click sends the session, the option and the fingerprint it rendered, and nothing else', async ({ page }) => {
    const prompt = await promptFromApi(page)
    const bodies: unknown[] = []
    await page.route(ANSWER_ROUTE, async (route) => {
      bodies.push(route.request().postDataJSON())
      await fulfillWith(200, { outcome: 'answered', session: BLOCKED_SESSION, option: 2 })(route)
    })
    await optionButton(page, '2').click()
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered')
    expect(bodies).toEqual([{ session: BLOCKED_SESSION, option: 2, fingerprint: prompt.fingerprint }])
  })

  test('Cancel sends the cancel option, not a number', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route(ANSWER_ROUTE, async (route) => {
      bodies.push(route.request().postDataJSON())
      await fulfillWith(200, { outcome: 'answered', session: BLOCKED_SESSION, option: 'cancel' })(route)
    })
    await optionButton(page, 'Escape').click()
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered')
    expect((bodies[0] as { option: unknown }).option).toBe('cancel')
  })

  test('a dialog that changed since render is reported and the buttons come back', async ({ page }) => {
    await page.route(ANSWER_ROUTE, fulfillWith(409, { reason: 'dialog-changed', error: 'The dialog changed since this card rendered — nothing was sent.' }))
    await optionButton(page, '1').click()
    await expect(result(page)).toHaveAttribute('data-outcome', 'dialog-changed')
    await expect(optionButton(page, '1')).toBeEnabled()
  })

  test('a send the server could not confirm is reported as unconfirmed, never as answered', async ({ page }) => {
    await page.route(ANSWER_ROUTE, fulfillWith(202, { outcome: 'unconfirmed', session: BLOCKED_SESSION, option: 1 }))
    await optionButton(page, '1').click()
    await expect(result(page)).toHaveAttribute('data-outcome', 'unconfirmed')
  })

  test('after an unconfirmed send the buttons stay locked, so a second key cannot follow', async ({ page }) => {
    let requestCount = 0
    await page.route(ANSWER_ROUTE, async (route) => {
      requestCount++
      await fulfillWith(202, { outcome: 'unconfirmed', session: BLOCKED_SESSION, option: 1 })(route)
    })
    await optionButton(page, '1').click()
    await expect(result(page)).toHaveAttribute('data-outcome', 'unconfirmed')
    await expect(optionButton(page, '2')).toBeDisabled()
    const isSecondRequestSent = sendsMoreThan(page, 0)
    await optionButton(page, '2').click({ force: true })
    expect(await isSecondRequestSent).toBe(false)
    expect(requestCount).toBe(1)
  })

  test.describe('keyboard activation', () => {
    for (const key of ['Enter', 'Space']) {
      test(`${key} on a focused option sends exactly one request and does not open the detail view`, async ({ page }) => {
        let requestCount = 0
        await page.route(ANSWER_ROUTE, async (route) => {
          requestCount++
          await fulfillWith(200, { outcome: 'answered', session: BLOCKED_SESSION, option: 1 })(route)
        })
        await optionButton(page, '1').focus()
        const isExtraRequestSent = sendsMoreThan(page, 1)

        await page.keyboard.press(key)

        await expect(result(page)).toHaveAttribute('data-outcome', 'answered')
        expect(await isExtraRequestSent).toBe(false)
        expect(requestCount).toBe(1)
        await expect(page.getByTestId('task-detail')).toHaveCount(0)
      })
    }
  })

  test('a double click sends one request', async ({ page }) => {
    let requestCount = 0
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route(ANSWER_ROUTE, async (route) => {
      requestCount++
      await held
      await fulfillWith(200, { outcome: 'answered', session: BLOCKED_SESSION, option: 1 })(route)
    })
    await optionButton(page, '1').dblclick()
    await expect(optionButton(page, '1')).toBeDisabled()
    release()
    await expect(result(page)).toHaveAttribute('data-outcome', 'answered')
    expect(requestCount).toBe(1)
  })
})
