import { test, expect } from '@playwright/test'

// Each stage panel on the task detail page shows a "what this stage covers"
// block — steps plus engineering-constraint labels — parsed live from that
// stage's own .claude/skills/cockpit-*/SKILL.md by GET /api/stage-scope (see
// tech-design-stage-scope-summary.md). Every UI assertion below compares the
// rendered block against that endpoint's own response rather than hardcoding
// any skill wording, so editing a skill file never breaks this spec — only
// breaking the parse→render link does.

test.use({ colorScheme: 'light', viewport: { width: 1280, height: 900 } })

// A flat task, so its chain carries all eight tabs including planning and
// plan-review. Fixture data lives in e2e/fixtures/tasks.
const SLUG = 'dev-ready'

// Chain tab id -> the Stage value /api/stage-scope keys its response by.
// Mirrors FLAT_CHAIN_STAGES in public/index.html; merge is deliberately
// absent (no skill backs it).
const SKILL_BACKED_TABS = [
  { id: 'planning', stage: 'planning' },
  { id: 'plan-review', stage: 'plan-review' },
  { id: 'dev', stage: 'dev' },
  { id: 'cr', stage: 'code-review' },
  { id: 'cr-fixes', stage: 'comment-fix' },
  { id: 'qa', stage: 'qa' },
  { id: 'qa-fixes', stage: 'qa-fixes' },
] as const

interface StageScope { steps: string[]; constraints: string[] }
type StageScopeResponse = { stages: Record<string, StageScope | null> }

const STAGE_SCOPE_ROUTE = '**/api/stage-scope'

test.describe('stage scope summary', () => {
  let scopes: StageScopeResponse

  test.beforeEach(async ({ request }) => {
    const res = await request.get('/api/stage-scope')
    expect(res.status()).toBe(200)
    scopes = await res.json()
  })

  test('the API derives a non-empty scope for every skill-backed stage and none for merge', async () => {
    for (const { stage } of SKILL_BACKED_TABS) {
      expect(scopes.stages[stage], `scope for ${stage}`).toBeTruthy()
      expect(scopes.stages[stage]!.steps.length, `steps for ${stage}`).toBeGreaterThan(0)
    }
    expect(scopes.stages).not.toHaveProperty('merge')
  })

  for (const { id, stage } of SKILL_BACKED_TABS) {
    test(`the ${id} tab renders one step row per step its skill declares`, async ({ page }) => {
      await page.goto(`/task/${SLUG}?stage=${id}`)

      const block = page.getByTestId(`stage-scope-${id}`)
      await expect(block).toBeVisible()
      await expect(block.getByTestId('stage-scope-step')).toHaveCount(scopes.stages[stage]!.steps.length)
    })
  }

  test('the dev tab renders its engineering constraints as chips', async ({ page }) => {
    const expected = scopes.stages['dev']!.constraints.length
    expect(expected).toBeGreaterThan(0)

    await page.goto(`/task/${SLUG}?stage=dev`)

    const block = page.getByTestId('stage-scope-dev')
    await expect(block.getByTestId('stage-scope-constraints')).toBeVisible()
    await expect(block.getByTestId('stage-scope-constraint')).toHaveCount(expected)
  })

  test('the merge tab has no scope block', async ({ page }) => {
    await page.goto(`/task/${SLUG}?stage=merge`)

    await expect(page.getByTestId('detail-panel-footer')).toBeVisible()
    await expect(page.getByTestId('stage-scope-merge')).toHaveCount(0)
  })

  test('a stage with no constraints omits the constraints row but still lists its steps', async ({ page }) => {
    await page.route(STAGE_SCOPE_ROUTE, route => route.fulfill({
      json: { stages: { ...scopes.stages, dev: { steps: ['First step', 'Second step'], constraints: [] } } },
    }))

    await page.goto(`/task/${SLUG}?stage=dev`)

    const block = page.getByTestId('stage-scope-dev')
    await expect(block.getByTestId('stage-scope-step')).toHaveCount(2)
    await expect(block.getByTestId('stage-scope-constraints')).toHaveCount(0)
  })

  test('when the scope endpoint fails, the panel still renders without a scope block', async ({ page }) => {
    await page.route(STAGE_SCOPE_ROUTE, route => route.fulfill({ status: 500 }))

    await page.goto(`/task/${SLUG}?stage=dev`)

    await expect(page.getByTestId('detail-panel-footer')).toBeVisible()
    await expect(page.getByTestId('milestone-dispatch')).toBeVisible()
    await expect(page.getByTestId('stage-scope-dev')).toHaveCount(0)
  })

  test('a milestone child dev tab gets the scope block too, not just root tasks', async ({ page }) => {
    await page.goto('/task/fanout-parent')
    await page.getByTestId('l1-tab-dev').click()
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M0"]').click()
    await page.getByTestId('stage-chain-dev').click()

    await expect(page.getByTestId('stage-scope-dev')).toBeVisible()
  })

  // CR finding: a failed fetch stored `null` into stageScopeCache, which the
  // pending/loaded guard couldn't tell apart from "never fetched" — so it
  // re-issued the request (and re-logged the failure) on every subsequent
  // detail-view open for as long as the endpoint kept failing, contradicting
  // the "fetched at most once per page load" comment at the openTaskDetail
  // call site. Closing and reopening the same task exercises exactly that
  // second call, without a full page reload (which would reset the cache
  // for an unrelated reason and prove nothing).
  test('a failed scope fetch is remembered and not retried on a later detail-view open', async ({ page }) => {
    let requestCount = 0
    await page.route(STAGE_SCOPE_ROUTE, (route) => {
      requestCount++
      route.fulfill({ status: 500 })
    })

    await page.goto(`/task/${SLUG}?stage=dev`)
    await expect(page.getByTestId('stage-scope-dev')).toHaveCount(0)
    expect(requestCount).toBe(1)

    await page.getByTestId('detail-close').click()
    await page.locator(`.card[data-slug="${SLUG}"] .card-title`).click()
    await page.getByTestId('stage-chain-dev').click()

    await expect(page.getByTestId('stage-scope-dev')).toHaveCount(0)
    expect(requestCount).toBe(1)
  })

  test('a stubbed stage with zero steps renders no scope block at all', async ({ page }) => {
    await page.route(STAGE_SCOPE_ROUTE, route => route.fulfill({
      json: { stages: { ...scopes.stages, dev: { steps: [], constraints: [] } } },
    }))

    await page.goto(`/task/${SLUG}?stage=dev`)

    await expect(page.getByTestId('detail-panel-footer')).toBeVisible()
    await expect(page.getByTestId('stage-scope-dev')).toHaveCount(0)
  })
})
