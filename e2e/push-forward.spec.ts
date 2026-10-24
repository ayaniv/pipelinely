import { test, expect, type Page, type Route } from '@playwright/test'
import { selectBoardTab } from './fixtures/boardTabs'
import { openWithSnapshot } from './fixtures/snapshotStub.js'

// pipelinely-babysit-skill-plan M2 — the Active toolbar's "Push forward" pill,
// which replaces the stub Babysit pill that #154 hid behind isBabysitWired()
// (M2 flips that accessor). One click asks the server to run one
// /pipelinely-babysit sweep (POST /babysit); the pill reports only what the
// server says happened, never a success it did not get. Its needs-you list is
// derived on the client from the same decideNextAction the sweep uses, with
// the same recorded qaStartPolicy setting.
//
// Every case that clicks mocks POST /babysit with page.route, except the last,
// which lets the click reach the fixture server: that server is never the
// canonical orchestrator, so nothing can be written to a real session.

const BABYSIT_ROUTE = '**/babysit'

// Fixture tasks, each at a known hand-off (e2e/fixtures/tasks/<slug>/STATUS).
const MERGE_READY = 'card-merge-ready' // QA passed, ready to merge -> needs you (merge)
const CR_COMMENTS = 'cr-fixes-ready' // triage and dispatch cr-fixes -> needs you (review-comments)
const CR_READY = 'cr-ready' // PR open, ready for CR -> the sweep's to push, not yours
const UI_VERIFY = 'npx tsc --noEmit && npx playwright test --project=ui --grep-invert @pending'

const pill = (page: Page) => page.getByTestId('push-forward-pill')
const needsYouToggle = (page: Page) => page.getByTestId('push-forward-needs-you-toggle')
const panel = (page: Page) => page.getByTestId('needs-you-panel')
const panelItem = (page: Page, slug: string) => panel(page).locator(`[data-testid="needs-you-item"][data-slug="${slug}"]`)

function fulfillWith(status: number, body: unknown) {
  return (route: Route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openActive(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('task-card').first()).toBeVisible()
}

test.describe('Push forward pill', () => {
  test.beforeEach(async ({ page }) => {
    await openActive(page)
  })

  test('replaces the stub Babysit pill on Active, and shows on no other tab', async ({ page }) => {
    await expect(pill(page)).toBeVisible()
    await expect(page.getByTestId('babysit-pill')).toHaveCount(0)
    await expect(pill(page)).toHaveAttribute('data-state', 'idle')

    for (const tab of ['done', 'backlog'] as const) {
      await selectBoardTab(page, tab)
      await expect(pill(page)).toBeHidden()
    }
  })

  test('the needs-you list holds the decisions and not the routine steps', async ({ page }) => {
    await needsYouToggle(page).click()
    await expect(panel(page)).toBeVisible()

    await expect(panelItem(page, MERGE_READY)).toHaveAttribute('data-reason', 'merge')
    await expect(panelItem(page, CR_COMMENTS)).toHaveAttribute('data-reason', 'review-comments')
    await expect(panelItem(page, CR_READY)).toHaveCount(0)

    const listed = await panel(page).getByTestId('needs-you-item').count()
    await expect(needsYouToggle(page)).toHaveAttribute('data-count', String(listed))
  })

  test('a QA hand-off asks for consent until the recorded setting pre-approves it', async ({ page }) => {
    const atQa = (snapshot: { tasks: Array<Record<string, unknown>> }) => {
      const task = snapshot.tasks.find((t) => t.slug === CR_READY)!
      Object.assign(task, { waitingReason: 'CR approved, ready for QA', verifier: UI_VERIFY, qaSkipReason: null, findings: [] })
    }

    await openWithSnapshot(page, '/', (s) => { atQa(s); s.settings = { autoMode: true, qaStartPolicy: 'ask-every-time' } })
    await needsYouToggle(page).click()
    await expect(panelItem(page, CR_READY)).toHaveAttribute('data-reason', 'qa-consent')

    // Pre-approved, but pipelinely-qa has no intent brief yet: still the developer's, for a different reason.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await openWithSnapshot(page, '/', (s) => { atQa(s); s.settings = { autoMode: true, qaStartPolicy: 'cockpit-ai-ui-preapproved' } })
    await needsYouToggle(page).click()
    await expect(panelItem(page, CR_READY)).toHaveAttribute('data-reason', 'qa-intent-brief')
  })

  test('a needs-you item opens that task', async ({ page }) => {
    await needsYouToggle(page).click()
    await panelItem(page, MERGE_READY).click()
    await expect(page).toHaveURL(new RegExp(`/task/${MERGE_READY}$`))
  })

  test('a sweep the server started is reported with how many tasks it is pushing', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route(BABYSIT_ROUTE, async (route) => {
      bodies.push(route.request().postDataJSON())
      await fulfillWith(200, { outcome: 'sent', planned: 2 })(route)
    })

    await pill(page).click()

    await expect(pill(page)).toHaveAttribute('data-state', 'sent')
    await expect(pill(page)).toHaveAttribute('data-planned', '2')
    expect(bodies).toEqual([{}])
  })

  test('nothing to push is not reported as a success', async ({ page }) => {
    await page.route(BABYSIT_ROUTE, fulfillWith(200, { outcome: 'nothing' }))
    await pill(page).click()
    await expect(pill(page)).toHaveAttribute('data-state', 'nothing')
    await expect(pill(page)).not.toHaveAttribute('data-planned', /.*/)
  })

  test('a machine above the load ceiling defers the sweep and says so', async ({ page }) => {
    await page.route(BABYSIT_ROUTE, fulfillWith(200, { outcome: 'load-too-high', load1: 12.4 }))
    await pill(page).click()
    await expect(pill(page)).toHaveAttribute('data-state', 'deferred')
    await expect(pill(page)).toHaveAttribute('data-load', '12.4')
  })

  test('an orchestrator that is not running is a failure, with the server\'s reason', async ({ page }) => {
    const error = 'Orchestrator not running — no ORCHESTRATOR_SESSION found'
    await page.route(BABYSIT_ROUTE, fulfillWith(503, { error }))
    await pill(page).click()
    await expect(pill(page)).toHaveAttribute('data-state', 'failed')
    await expect(pill(page)).toHaveAttribute('title', error)
  })

  test('a double click sends one sweep', async ({ page }) => {
    let calls = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route(BABYSIT_ROUTE, async (route) => {
      calls += 1
      await held
      await fulfillWith(200, { outcome: 'sent', planned: 1 })(route)
    })

    await pill(page).dblclick()
    await expect(pill(page)).toHaveAttribute('data-state', 'running')
    release()
    await expect(pill(page)).toHaveAttribute('data-state', 'sent')
    expect(calls).toBe(1)
  })

  test('a real click on the non-canonical fixture server never reports a sweep as sent', async ({ page }) => {
    const response = page.waitForResponse((res) => res.url().endsWith('/babysit') && res.request().method() === 'POST')
    await pill(page).click()
    await response
    await expect(pill(page)).toHaveAttribute('data-state', /^(failed|deferred)$/)
  })
})
