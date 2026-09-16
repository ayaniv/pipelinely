import { test, expect } from '@playwright/test'

// Covers the "Open in Plannotator" button on the Plan/Plan Review tab
// (renderPlanTab in public/index.html): disabled until a task has a tracked
// tech-design.md, enabled once it does, and POSTs /annotate-plan/:slug on
// click — which server.ts dispatches to a dedicated tmux/iTerm2 session (see
// tech-design.md's "Decision 1"), never the orchestrator's own.
//
// What this suite can and can't prove: openAnnotationSession has no safe
// no-op path the way stageInSession does (a fake session id there just
// fails to match; this route unconditionally opens a real iTerm2 tab when
// it actually runs) — so the "clicking hits the correct route" and
// "failure path" cases below stub the response at the network layer
// instead of letting the real dispatch run. The 404 (no tech-design.md)
// case is the one branch safe to hit for real, since the route returns
// before ever calling openAnnotationSession — see server.test.ts for a
// faster, non-browser check of that same branch.

async function openTask(page, slug: string) {
  await page.goto('/')
  await page.locator(`.card[data-slug="${slug}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}

test.describe('Plannotator button — enabled state', () => {
  test('no tech-design.md: the button renders disabled', async ({ page }) => {
    await openTask(page, 'demo-task')
    await page.getByTestId('stage-chain-planning').click()
    const btn = page.getByTestId('plannotator-btn')
    await expect(btn).toBeVisible()
    await expect(btn).toBeDisabled()
  })

  test('tech-design.md present: the button renders enabled', async ({ page }) => {
    await openTask(page, 'dev-ready')
    await page.getByTestId('stage-chain-planning').click()
    const btn = page.getByTestId('plannotator-btn')
    await expect(btn).toBeVisible()
    await expect(btn).toBeEnabled()
  })
})

test.describe('Plannotator button — clicking dispatches the annotation session', () => {
  test('posts to /annotate-plan/:slug with the right slug', async ({ page }) => {
    await page.route('**/annotate-plan/dev-ready', (route) => route.fulfill({ status: 200, body: '' }))

    await openTask(page, 'dev-ready')
    await page.getByTestId('stage-chain-planning').click()
    const btn = page.getByTestId('plannotator-btn')
    await expect(btn).toBeEnabled()

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/annotate-plan/dev-ready') && req.method() === 'POST'),
      btn.click(),
    ])
    expect(request.url()).toContain('/annotate-plan/dev-ready')
    await expect(btn).toHaveClass(/btn-ok/)
  })

  test('failure path: a non-ok response flashes the button as failed, never a false success', async ({ page }) => {
    await page.route('**/annotate-plan/dev-ready', (route) => route.fulfill({ status: 500, body: '' }))

    await openTask(page, 'dev-ready')
    await page.getByTestId('stage-chain-planning').click()
    const btn = page.getByTestId('plannotator-btn')

    await btn.click()
    await expect(btn).toHaveClass(/btn-err/)
    await expect(btn).not.toHaveClass(/btn-ok/)
  })
})

test.describe('Plannotator button — real 404 path', () => {
  // Safe to hit for real: the route returns 404 before ever touching
  // openAnnotationSession, so no real iTerm2/tmux side effect occurs.
  test('POST /annotate-plan/:slug returns 404 for a task with no tech-design.md', async ({ page }) => {
    const res = await page.request.post('/annotate-plan/demo-task')
    expect(res.status()).toBe(404)
  })
})
