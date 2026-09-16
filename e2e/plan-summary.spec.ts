import { test, expect, type Page } from '@playwright/test'

// Covers the Plan tab's pinned overview (renderPlanOverview in
// public/index.html, fed by GET /tech-design/:slug's summaryHtml and
// testGroups): the plan's `## Summary` prose, then which e2e test titles
// will run against the task — one group for a flat task's `**QA Spec:**`
// line, one group per declared milestone's `spec:` field — both above the
// plan document itself. See tech-design-plan-summary-milestone-tests.md.

const FLAT_SLUG = 'plan-summary-flat'
const PARENT_SLUG = 'plan-summary-parent'
const NO_SUMMARY_SLUG = 'plan-summary-no-summary'

// Counts of test() calls in the fixture worktrees' spec files.
const FLAT_SPEC_CASE_COUNT = 3
const M0_SPEC_CASE_COUNT = 2

async function openFlatPlan(page: Page, slug: string): Promise<void> {
  await page.goto(`/task/${slug}`)
  await page.getByTestId('stage-chain-planning').click()
  await expect(page.getByTestId('tech-design-body')).toBeVisible()
}

async function openParentPlan(page: Page): Promise<void> {
  await page.goto(`/task/${PARENT_SLUG}`)
  await page.getByTestId('l1-tab-plan').click()
  await expect(page.getByTestId('tech-design-body')).toBeVisible()
}

function milestoneGroup(page: Page, milestoneId: string) {
  return page.locator(`[data-testid="plan-tests-group"][data-milestone-id="${milestoneId}"]`)
}

test.describe('flat task', () => {
  test.beforeEach(async ({ page }) => {
    await openFlatPlan(page, FLAT_SLUG)
  })

  test('the summary card renders the plan\'s Summary section as markdown', async ({ page }) => {
    const summaryBody = page.getByTestId('plan-summary').getByTestId('plan-summary-body')
    await expect(summaryBody).toBeVisible()
    await expect(summaryBody.locator('p')).toHaveCount(1)
    await expect(summaryBody.locator('code')).toHaveCount(1)
    await expect(page.getByTestId('plan-summary-missing')).toHaveCount(0)
  })

  test('the summary card, then the test list, sit above the plan document', async ({ page }) => {
    await expect(page.getByTestId('plan-summary-body')).toBeVisible()
    await expect(page.getByTestId('plan-tests')).toBeVisible()

    const summary = await page.getByTestId('plan-summary').boundingBox()
    const tests = await page.getByTestId('plan-tests').boundingBox()
    const doc = await page.getByTestId('tech-design-body').boundingBox()
    expect(summary && tests && doc).toBeTruthy()
    expect(summary!.y).toBeLessThan(tests!.y)
    expect(tests!.y).toBeLessThan(doc!.y)
  })

  test('the Summary section is not repeated inside the plan document', async ({ page }) => {
    await expect(page.getByTestId('plan-summary-body')).toBeVisible()
    const doc = page.getByTestId('tech-design-body')
    await expect(doc.locator('h1')).toHaveCount(1)
    await expect(doc.locator('h2')).toHaveCount(0)
  })

  test('a flat task lists its QA Spec file\'s test titles as one unlabeled group', async ({ page }) => {
    const groups = page.getByTestId('plan-tests-group')
    await expect(groups).toHaveCount(1)
    await expect(groups.getByTestId('plan-tests-group-milestone')).toHaveCount(0)
    await expect(groups.getByTestId('plan-tests-group-spec')).toBeVisible()
    await expect(groups.getByTestId('planned-qa-case-row')).toHaveCount(FLAT_SPEC_CASE_COUNT)
  })
})

test.describe('milestone parent', () => {
  test.beforeEach(async ({ page }) => {
    await openParentPlan(page)
  })

  test('one group per declared milestone, in declared order', async ({ page }) => {
    const groups = page.getByTestId('plan-tests-group')
    await expect(groups).toHaveCount(2)
    const ids = await groups.evaluateAll(els => els.map(el => el.getAttribute('data-milestone-id')))
    expect(ids).toEqual(['M0', 'M1'])
    await expect(groups.getByTestId('plan-tests-group-milestone')).toHaveCount(2)
  })

  test('a milestone group lists its own spec file\'s test titles', async ({ page }) => {
    const m0 = milestoneGroup(page, 'M0')
    await expect(m0.getByTestId('planned-qa-case-row')).toHaveCount(M0_SPEC_CASE_COUNT)
    await expect(m0.getByTestId('plan-tests-missing-spec')).toHaveCount(0)
  })

  test('failure path: a declared spec file that does not exist is flagged on its own group, not dropped', async ({ page }) => {
    const m1 = milestoneGroup(page, 'M1')
    await expect(m1).toBeVisible()
    await expect(m1.getByTestId('plan-tests-missing-spec')).toBeVisible()
    await expect(m1.getByTestId('planned-qa-case-row')).toHaveCount(0)

    // One milestone's missing file must not take the other groups down with it.
    await expect(milestoneGroup(page, 'M0').getByTestId('planned-qa-case-row')).toHaveCount(M0_SPEC_CASE_COUNT)
  })
})

test.describe('failure paths', () => {
  test('a plan with no Summary section shows a visible missing-summary note, and the document still renders', async ({ page }) => {
    await openFlatPlan(page, NO_SUMMARY_SLUG)
    await expect(page.getByTestId('plan-summary-missing')).toBeVisible()
    await expect(page.getByTestId('plan-summary-body')).toHaveCount(0)
    await expect(page.getByTestId('tech-design-body').locator('h2')).toHaveCount(1)
  })

  test('a plan with no declared spec shows an explicit no-spec note instead of an empty list', async ({ page }) => {
    await openFlatPlan(page, NO_SUMMARY_SLUG)
    await expect(page.getByTestId('plan-tests-empty')).toBeVisible()
    await expect(page.getByTestId('plan-tests-group')).toHaveCount(0)
  })
})

test.describe('GET /tech-design/:slug', () => {
  test('returns the summary and one test group per declared milestone', async ({ page }) => {
    const res = await page.request.get(`/tech-design/${PARENT_SLUG}`)
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(body.summaryHtml).toContain('<p>')
    expect(body.testGroups.map((g: { milestoneId: string }) => g.milestoneId)).toEqual(['M0', 'M1'])
    expect(body.testGroups[0].titles).toHaveLength(M0_SPEC_CASE_COUNT)
    expect(body.testGroups[0].missingSpecFiles).toEqual([])
    expect(body.testGroups[1].titles).toEqual([])
    expect(body.testGroups[1].missingSpecFiles).toEqual(['e2e/m1-missing.spec.ts'])
  })

  test('failure path: a plan with no summary and no spec reports null and no groups, not an error', async ({ page }) => {
    const res = await page.request.get(`/tech-design/${NO_SUMMARY_SLUG}`)
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(body.summaryHtml).toBeNull()
    expect(body.testGroups).toEqual([])
    expect(body.html).toContain('<h2>')
  })
})
