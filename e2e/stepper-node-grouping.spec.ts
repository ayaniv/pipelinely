import { test, expect } from '@playwright/test'

// Collapses three of the pipeline stepper's eight/six visible nodes into
// their parent, display-only (see TASK.md): Plan Review folds into Planning,
// CR fixes folds into CR, QA fixes folds into QA. The underlying Stage enum,
// TIMELINE stage values, and each tab's own routing (detailL2Tab/STATUS/CTA)
// are untouched — renderStageChain (public/index.html) just renders fewer
// nodes, each one's state/note reflecting whichever of its folded sub-stages
// is most advanced.
//
// M4 moved the rail's own per-node note line off the rail entirely (D15,
// tech-design.md) — the folding claim this file proves survives intact, but
// the evidence for it moved: "shows N nodes, not eight" is now a
// `.stage-chain-node` count rather than a `stage-node-data` count (that
// testid is retired from this rail), and each folded node's own sub-state
// text now lives on the panel header's meta line (`.l2-panel-subtitle`)
// after selecting the node, not on a third line under it.
//
// FLAT_CHAIN_STAGES' visible nodes after folding: Planning, Dev, CR, QA,
// Merge — five, not eight. MILESTONE_CHAIN_STAGES': Dev, CR, QA, Merge —
// four, not six.

const FLAT_VISIBLE_COUNT = 5
const MILESTONE_VISIBLE_COUNT = 4

async function openTask(page, slug: string) {
  await page.goto('/')
  await page.locator(`.card[data-slug="${slug}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}

test.describe('stepper node grouping — Planning folds in Plan Review', () => {
  test('a task with plan-review activity shows one Planning node whose sub-state reflects the plan-review outcome', async ({ page }) => {
    // dev-ready's TIMELINE reaches plan-review ("round 1: looks good") before
    // moving on to dev — see e2e/fixtures/tasks/dev-ready/TIMELINE.
    await openTask(page, 'dev-ready')

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.locator('.stage-chain-node')).toHaveCount(FLAT_VISIBLE_COUNT)
    await expect(page.getByTestId('stage-chain-plan-review')).toHaveCount(0)

    const planningNode = wide.getByTestId('stage-chain-planning')
    await expect(planningNode).toBeVisible()
    await planningNode.click()
    await expect(page.getByTestId('detail-panel-meta')).toContainText('round 1: looks good')
  })
})

test.describe('stepper node grouping — QA folds in QA fixes', () => {
  test('a task with QA-fixes activity shows one QA node with QA-fixes reflected as a sub-state', async ({ page }) => {
    // qa-fixes-activity's TIMELINE actually reaches 'qa-fixes' (unlike
    // qa-fixes-ready, which only has it as the next CTA) — see
    // e2e/fixtures/tasks/qa-fixes-activity/TIMELINE.
    await openTask(page, 'qa-fixes-activity')

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.locator('.stage-chain-node')).toHaveCount(FLAT_VISIBLE_COUNT)
    await expect(page.getByTestId('stage-chain-qa-fixes')).toHaveCount(0)

    const qaNode = wide.getByTestId('stage-chain-qa')
    await expect(qaNode).toBeVisible()
    await qaNode.click()
    await expect(page.getByTestId('detail-panel-meta')).toContainText('applied fixes for 2 cases')
  })
})

test.describe('stepper node grouping — CR folds in CR fixes', () => {
  test('a task with CR-fixes activity shows one Code Review node with CR-fixes reflected as a sub-state', async ({ page }) => {
    // cr-fixes-activity's TIMELINE actually reaches 'comment-fix' (unlike
    // cr-fixes-ready, which only has it as the next CTA) — see
    // e2e/fixtures/tasks/cr-fixes-activity/TIMELINE.
    await openTask(page, 'cr-fixes-activity')

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.locator('.stage-chain-node')).toHaveCount(FLAT_VISIBLE_COUNT)
    await expect(page.getByTestId('stage-chain-cr-fixes')).toHaveCount(0)

    const crNode = wide.getByTestId('stage-chain-cr')
    await expect(crNode).toBeVisible()
    await crNode.click()
    await expect(page.getByTestId('detail-panel-meta')).toContainText('applied 1 comment')
  })
})

test.describe('stepper node grouping — regression: no folded activity', () => {
  // planning-ready has no plan-review, comment-fix or qa-fixes entries in its
  // TIMELINE at all — the grouped chain must still render normally (five
  // nodes, Planning showing its own state, no crash).
  test('a task with none of the three sub-stages still renders normally', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await openTask(page, 'planning-ready')

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.locator('.stage-chain-node')).toHaveCount(FLAT_VISIBLE_COUNT)
    await expect(page.getByTestId('stage-chain-planning')).toBeVisible()
    await expect(page.getByTestId('stage-chain-cr')).toBeVisible()
    await expect(page.getByTestId('stage-chain-qa')).toBeVisible()
    await expect(page.getByTestId('stage-chain-plan-review')).toHaveCount(0)
    await expect(page.getByTestId('stage-chain-cr-fixes')).toHaveCount(0)
    await expect(page.getByTestId('stage-chain-qa-fixes')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  // Same structural check on a milestone child's own chain
  // (MILESTONE_CHAIN_STAGES), which folds CR fixes/QA fixes but has no
  // Planning/Plan Review nodes to begin with.
  test('a milestone child chain also renders the folded four-node count', async ({ page }) => {
    await page.goto('/task/fanout-parent')
    await page.getByTestId('l1-tab-dev').click()
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M0"]').click()

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.locator('.stage-chain-node')).toHaveCount(MILESTONE_VISIBLE_COUNT)
    await expect(page.getByTestId('stage-chain-cr-fixes')).toHaveCount(0)
    await expect(page.getByTestId('stage-chain-qa-fixes')).toHaveCount(0)
  })
})
