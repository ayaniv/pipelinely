import { test, expect, type Page, type Request, type Route } from '@playwright/test'

// The sidebar's Help item becomes a real page (/help) whose one job is to
// STAGE `/pipelinely-feedback <message>` into the orchestrator's own session — never
// to submit it. See tech-design-help-feedback-tab.md.
//
// Two halves, split the same way handover-dispatch.spec.ts splits them:
//   - this file proves what the dashboard SHOWS and SENDS (the page opens,
//     the URL, the request shape, the reported outcome), with every
//     orchestrator-side POST route-stubbed.
//   - that the route composes `/pipelinely-feedback <message>` and writes it through
//     stageInSession (submit:false), with newlines collapsed, is proved
//     against the real handler in src/server.helpFeedback.test.ts, where
//     focusTab can be mocked.
//
// `ui` project, local-safe by construction: the only cases that reach the
// real server are the two contract cases at the bottom, which assert the
// request-validation boundary (400) and the canonical-dispatch gate (403).
// writeToOrchestrator checks isCanonicalDispatchInstance() before it reads
// ORCHESTRATOR_SESSION or takes the lock, so neither case touches a pointer
// file, osascript, or tmux.
//
// Selectors are data-testid only; no assertion selects by visible copy.

const MESSAGE = 'the stepper collapses the wrong node on a milestone task'

// Every dispatch-shaped POST the page makes. `otherDispatch` exists to prove
// the NEGATIVE — Send never goes out through a sibling write route.
const OTHER_DISPATCH_ROUTES = [
  '/stage-skill/',
  '/focus/',
  '/pipelinely-handover',
  '/orchestrator/pipelinely-handover',
  '/backlog/dispatch',
  '/batch-dispatch',
]

interface RecordedPosts {
  feedback: unknown[]
  otherDispatch: string[]
}

function recordDispatchPosts(page: Page): RecordedPosts {
  const recorded: RecordedPosts = { feedback: [], otherDispatch: [] }
  page.on('request', (req: Request) => {
    if (req.method() !== 'POST') return
    const { pathname } = new URL(req.url())
    if (pathname === '/help/pipelinely-feedback') {
      recorded.feedback.push(req.postDataJSON())
      return
    }
    if (OTHER_DISPATCH_ROUTES.some((route) => pathname.startsWith(route))) recorded.otherDispatch.push(pathname)
  })
  return recorded
}

async function stubFeedback(page: Page, status: number, body?: unknown): Promise<void> {
  await page.route('**/help/pipelinely-feedback', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) }),
  )
}

// Holds the route open until `release` is called — lets a test observe the
// in-flight state (button disabled) deterministically instead of racing a
// real response. Same helper shape as handover-dispatch.spec.ts's.
async function holdFeedback(page: Page): Promise<{ release: () => Promise<void> }> {
  const held: Route[] = []
  await page.route('**/help/pipelinely-feedback', (route) => { held.push(route) })
  return {
    release: async () => {
      await expect.poll(() => held.length).toBeGreaterThan(0)
      await Promise.all(held.map((route) => route.fulfill({ status: 200, body: '{}' })))
    },
  }
}

function helpPage(page: Page) {
  return page.getByTestId('help-page')
}

function messageInput(page: Page) {
  return page.getByTestId('help-feedback-input')
}

function sendBtn(page: Page) {
  return page.getByTestId('help-feedback-send')
}

async function openHelpFromSidebar(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('sidebar-help-btn').click()
  await expect(helpPage(page)).toBeVisible()
}

test.describe('sidebar Help item', () => {
  test('is a real button, the same shape as the Settings item next to it', async ({ page }) => {
    await page.goto('/')
    const btn = page.getByTestId('sidebar-help-btn')
    await expect(btn).toBeVisible()
    expect(await btn.evaluate((el) => el.tagName)).toBe('BUTTON')
    await expect(btn).toHaveAttribute('type', 'button')
  })

  test('clicking it opens the Help page at its own /help URL and hides the board', async ({ page }) => {
    await page.goto('/')
    await expect(helpPage(page)).toBeHidden()

    await page.getByTestId('sidebar-help-btn').click()

    await expect(helpPage(page)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/help')
    await expect(page.getByTestId('board-column')).toBeHidden()
  })

  test('a cold load of /help opens the page without a click', async ({ page }) => {
    await page.goto('/help')
    await expect(helpPage(page)).toBeVisible()
    await expect(page.getByTestId('board-column')).toBeHidden()
  })

  test('Help and Settings are mutually exclusive — opening one closes the other', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-page')).toBeVisible()

    await page.getByTestId('sidebar-help-btn').click()
    await expect(helpPage(page)).toBeVisible()
    await expect(page.getByTestId('settings-page')).toBeHidden()

    await page.getByTestId('sidebar-settings-btn').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()
    await expect(helpPage(page)).toBeHidden()
  })

  test('a sidebar tab click leaves the Help page and brings the board back', async ({ page }) => {
    await openHelpFromSidebar(page)

    await page.getByTestId('tab-btn-backlog').click()

    await expect(helpPage(page)).toBeHidden()
    await expect(page.getByTestId('board-column')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/backlog')
  })

  test('browser Back from /help returns to the board', async ({ page }) => {
    await openHelpFromSidebar(page)

    await page.goBack()

    await expect(helpPage(page)).toBeHidden()
    await expect(page.getByTestId('board-column')).toBeVisible()
  })
})

test.describe('Help page — Send stages the feedback command', () => {
  // A multi-line <textarea>, not a single-line <input> — the newline hazard
  // this used to block at the client is now closed at the server instead
  // (normalizeWhitespace in POST /help/pipelinely-feedback, proved for real, unmocked,
  // in src/server.helpFeedback.test.ts). See tech-design-help-feedback-tab.md.
  test('the message field is a multi-line textarea, chat-style', async ({ page }) => {
    await openHelpFromSidebar(page)
    const input = messageInput(page)
    expect(await input.evaluate((el) => el.tagName)).toBe('TEXTAREA')
  })

  test('the explanation of what Send does renders after the textarea and button, not before them', async ({ page }) => {
    await openHelpFromSidebar(page)
    const panel = page.getByTestId('help-feedback-panel')

    const composerBeforeDesc = await panel.evaluate((el) => {
      const composer = el.querySelector('.help-feedback-composer')
      const desc = el.querySelector('.page-row-desc')
      if (!composer || !desc) throw new Error('expected elements not found')
      return !!(composer.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING)
    })

    expect(composerBeforeDesc).toBe(true)
  })

  test('Send starts disabled and stays disabled for a whitespace-only message; clicking it sends nothing', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await openHelpFromSidebar(page)

    await expect(sendBtn(page)).toBeDisabled()

    await messageInput(page).fill('   ')
    await expect(sendBtn(page)).toBeDisabled()
    await sendBtn(page).click({ force: true })

    expect(posts.feedback).toEqual([])
    expect(posts.otherDispatch).toEqual([])
  })

  test('typing a message enables Send; clicking it posts exactly one /help/pipelinely-feedback carrying that message', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubFeedback(page, 200)
    await openHelpFromSidebar(page)

    await messageInput(page).fill(MESSAGE)
    await expect(sendBtn(page)).toBeEnabled()
    await sendBtn(page).click()

    await expect.poll(() => posts.feedback).toEqual([{ message: MESSAGE }])
    expect(posts.otherDispatch).toEqual([])
  })

  test('a successful stage reports itself, clears the field and re-disables Send', async ({ page }) => {
    await stubFeedback(page, 200)
    await openHelpFromSidebar(page)

    await messageInput(page).fill(MESSAGE)
    await sendBtn(page).click()

    await expect(sendBtn(page)).toHaveClass(/btn-ok/)
    await expect(messageInput(page)).toHaveValue('')
    await expect(sendBtn(page)).toBeDisabled()
  })

  test('a fast double-click sends exactly one request while the first is in flight', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    const held = await holdFeedback(page)
    await openHelpFromSidebar(page)

    await messageInput(page).fill(MESSAGE)
    await sendBtn(page).dblclick()
    await expect(sendBtn(page)).toBeDisabled()
    await held.release()

    await expect(messageInput(page)).toHaveValue('')
    expect(posts.feedback).toEqual([{ message: MESSAGE }])
  })

  test('a Contact support mailto link is offered alongside the composer', async ({ page }) => {
    await openHelpFromSidebar(page)

    const link = page.getByTestId('help-support-link')
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'mailto:ayaniv@gmail.com?subject=pipelinely')
  })
})

test.describe('Help page — Send reports failures honestly', () => {
  test('a 503 (orchestrator not running) shows the error state and keeps the message for a retry', async ({ page }) => {
    await stubFeedback(page, 503, { error: 'Orchestrator not running — no ORCHESTRATOR_SESSION found' })
    await openHelpFromSidebar(page)

    await messageInput(page).fill(MESSAGE)
    await sendBtn(page).click()

    await expect(sendBtn(page)).toHaveClass(/btn-err/)
    await expect(messageInput(page)).toHaveValue(MESSAGE)
    await expect(sendBtn(page)).toBeEnabled()
  })

  test('a 403 (read-only instance) shows the error state rather than a false success', async ({ page }) => {
    await stubFeedback(page, 403, { error: 'This dashboard is read-only' })
    await openHelpFromSidebar(page)

    await messageInput(page).fill(MESSAGE)
    await sendBtn(page).click()

    await expect(sendBtn(page)).toHaveClass(/btn-err/)
    await expect(sendBtn(page)).toBeEnabled()
  })

  test('a server that is down shows the error state rather than nothing', async ({ page }) => {
    await page.route('**/help/pipelinely-feedback', (route) => route.abort('connectionrefused'))
    await openHelpFromSidebar(page)

    await messageInput(page).fill(MESSAGE)
    await sendBtn(page).click()

    await expect(sendBtn(page)).toHaveClass(/btn-err/)
    await expect(sendBtn(page)).toBeEnabled()
  })
})

// Against the real route, unstubbed. Both cases stop before any session
// pointer is read: validation rejects the first outright, and
// writeToOrchestrator rejects the second on isCanonicalDispatchInstance()
// alone (this suite's webServer deliberately never sets
// COCKPIT_DISPATCH_ENABLED — see playwright.config.ts).
test.describe('POST /help/pipelinely-feedback — real-server contract', () => {
  test('a whitespace-only message is rejected with 400 before anything is staged', async ({ request }) => {
    const res = await request.post('/help/pipelinely-feedback', { data: { message: '   \n  ' } })
    expect(res.status()).toBe(400)
  })

  test('a missing message is rejected with 400', async ({ request }) => {
    const res = await request.post('/help/pipelinely-feedback', { data: {} })
    expect(res.status()).toBe(400)
  })

  test('a real message gets past validation and is stopped by the canonical-dispatch gate, not by validation', async ({ request }) => {
    const res = await request.post('/help/pipelinely-feedback', { data: { message: MESSAGE } })
    expect(res.status()).toBe(403)
  })
})
