import { test, expect, type Page } from '@playwright/test'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'

// Covers the two halves of the card-merge-cta task, which share one cause:
//
//   1. computeStage pinned a merge-ready task at 'qa'. pipelinely-qa writes its
//      `qa` TIMELINE entry and QA_REPORT.md in the same breath, so by the
//      time a QA result exists the last TIMELINE entry is always 'qa' — and
//      computeStage returned last.stage unconditionally, which made its own
//      `qaResult` rule (clean → merge, failed → qa-fixes) unreachable for
//      every task that went through the real pipeline.
//   2. The board card's footer had no Merge action, so a ready-to-merge task
//      could only be merged by opening its detail view and clicking through
//      to the Merge tab.
//
// (2) is gated on (1): the footer's gate is `task.stage === 'merge'`, so the
// button cannot appear until computeStage advances past 'qa'. That's why both
// live in one spec — one fixture, one stage computation, two surfaces.
//
// These were committed red during planning, tagged @pending until
// implementation existed (VERIFY ran `--grep-invert @pending` until then —
// see handover-dispatch.spec.ts / design-v2-frame.spec.ts for the same
// precedent). The dev stage removed the tag once green.
//
// The fixture is card-merge-ready (e2e/fixtures/tasks/card-merge-ready) —
// the only fixture whose STATUS, TIMELINE and QA_REPORT.md agree the way a
// real clean QA pass leaves them. Every pre-existing "QA passed, ready to
// merge" fixture ends its TIMELINE at 'code-review' with no QA_REPORT.md, so
// none of them computes stage 'merge'; see that fixture's own TASK.md.
const MERGE_SLUG = 'card-merge-ready'

// dev-ready is the control: waitingReason "plan reviewed, ready for dev"
// resolves a real next stage, so its footer keeps the existing single-CTA
// shape. Its TIMELINE ends at 'plan-review' and it has no QA_REPORT.md, so
// computeStage's new QA refinement cannot touch it.
const EARLIER_STAGE_SLUG = 'dev-ready'

function card(page: Page, slug: string) {
  return page.locator(`.card[data-slug="${slug}"]`)
}

// The card's own mini rail, node by node. The rail renders five nodes
// (planning/dev/cr/qa/merge) with no per-node testid today — this task adds
// `data-testid="mini-stage-node"` plus `data-stage` and a `data-state` of
// done|current|todo to each one, so a test can assert rail *state* without
// reading inline styles or the node's title text (see this repo's
// no-select-by-text rule).
function railNode(page: Page, slug: string, stage: string) {
  return card(page, slug).locator(`[data-testid="mini-stage-node"][data-stage="${stage}"]`)
}

test.describe('computeStage: a clean QA pass reaches Merge', () => {
  test("the card's mini stage rail checks off every stage but Merge, which reads as current", async ({ page }) => {
    await page.goto('/')
    await expect(card(page, MERGE_SLUG)).toBeVisible()

    // The whole point of the bug report: before the fix the rail stopped one
    // node short — 'qa' was current and 'merge' was still an untouched
    // to-do, because task.stage never advanced past 'qa'.
    for (const stage of ['planning', 'dev', 'cr', 'qa']) {
      await expect(railNode(page, MERGE_SLUG, stage)).toHaveAttribute('data-state', 'done')
    }
    await expect(railNode(page, MERGE_SLUG, 'merge')).toHaveAttribute('data-state', 'current')
  })

  // Superseded: the design-v2 follow-up round removed the card's secondary
  // pill row outright (the design has no such row), so the stage pill this
  // used to read is gone. The card root carries `data-stage` instead —
  // still computeStage's own output read off the board as an attribute
  // rather than as rendered copy, which is the claim that mattered.
  test('the card\'s stage reads merge rather than qa', async ({ page }) => {
    await page.goto('/')

    await expect(card(page, MERGE_SLUG)).toHaveAttribute('data-stage', 'merge')
  })

  test('a task at an earlier stage keeps its own stage and rail position', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, EARLIER_STAGE_SLUG)).toBeVisible()

    // Regression guard for the fix's blast radius: computeStage's TIMELINE
    // branch must still win unconditionally for every stage that isn't the
    // QA refinement's own narrow case.
    await expect(card(page, EARLIER_STAGE_SLUG)).toHaveAttribute('data-stage', 'plan-review')
    await expect(railNode(page, EARLIER_STAGE_SLUG, 'merge')).toHaveAttribute('data-state', 'todo')
  })
})

test.describe('board card footer: Merge primary, Open PR secondary', () => {
  test('a ready-to-merge card offers Merge as its single primary action, Open PR beside it', async ({ page }) => {
    await page.goto('/')
    const c = card(page, MERGE_SLUG)
    await expect(c).toBeVisible()

    const mergeBtn = c.getByTestId('card-merge-pr-btn')
    await expect(mergeBtn).toBeVisible()
    await expect(mergeBtn).toBeEnabled()
    await expect(mergeBtn).toHaveAttribute('data-primary', 'true')

    const openPrBtn = c.getByTestId('card-open-pr-btn')
    await expect(openPrBtn).toBeVisible()
    await expect(openPrBtn).not.toHaveAttribute('data-primary', 'true')

    // The design's one-accent rule, asserted the same way board-redesign.spec.ts
    // already asserts it for every other footer shape — adding a second
    // button to this footer must not add a second primary.
    await expect(c.locator('button[data-primary="true"]')).toHaveCount(1)
  })

  test('Merge and Open PR render at the same width and height', async ({ page }) => {
    await page.goto('/')
    const c = card(page, MERGE_SLUG)
    await expect(c).toBeVisible()

    const mergeBox = await c.getByTestId('card-merge-pr-btn').boundingBox()
    const openPrBox = await c.getByTestId('card-open-pr-btn').boundingBox()

    // Distinct color/weight identity is fine; the developer's own feedback
    // was that the two buttons must occupy the same box.
    expect(openPrBox!.width).toBeCloseTo(mergeBox!.width, 0)
    expect(openPrBox!.height).toBeCloseTo(mergeBox!.height, 0)
  })

  test("the generic stage CTA is not also rendered — the merge footer replaces it", async ({ page }) => {
    await page.goto('/')

    // A merge-stage task has no NEXT_STAGE_BY_WAITING_REASON entry (merge is
    // never staged), so this is really asserting the merge branch wins over
    // cardFooterHtml's decision-waiting fallback, which until now rendered a
    // terminal icon and nothing else.
    await expect(card(page, MERGE_SLUG).getByTestId('card-cta-btn')).toHaveCount(0)
  })

  test('a card at an earlier stage keeps the existing footer, with no Merge action', async ({ page }) => {
    await page.goto('/')
    const c = card(page, EARLIER_STAGE_SLUG)
    await expect(c).toBeVisible()

    await expect(c.getByTestId('card-cta-btn')).toBeVisible()
    await expect(c.getByTestId('card-merge-pr-btn')).toHaveCount(0)
    await expect(c.getByTestId('card-open-pr-btn')).toHaveCount(0)
    await expect(c.locator('button[data-primary="true"]')).toHaveCount(1)
  })
})

test.describe('board card footer: the Merge button runs the real merge flow', () => {
  test('clicking it confirms, then POSTs /merge-pr/:slug — the same endpoint the Merge tab uses', async ({ page }) => {
    // /merge-pr mutates STATUS/TIMELINE on the way to marking a task done;
    // restore them so this fixture stays repeatable across runs, exactly as
    // merge-tab-actions.spec.ts does for its own merge cases.
    await withRestoredFixtureFiles(MERGE_SLUG, ['STATUS', 'TIMELINE'], async () => {
      await page.goto('/')
      const mergeBtn = card(page, MERGE_SLUG).getByTestId('card-merge-pr-btn')
      await expect(mergeBtn).toBeVisible()

      // Merge always confirms first — it merges to a shared remote and marks
      // the task done. Accept it so the request actually fires.
      page.once('dialog', (d) => d.accept())

      const [request] = await Promise.all([
        page.waitForRequest(
          (req) => req.url().includes(`/merge-pr/${MERGE_SLUG}`) && req.method() === 'POST',
        ),
        mergeBtn.click(),
      ])
      expect(request.method()).toBe('POST')
    })
  })

  test('dismissing the confirm fires no request at all', async ({ page }) => {
    await page.goto('/')
    const mergeBtn = card(page, MERGE_SLUG).getByTestId('card-merge-pr-btn')
    await expect(mergeBtn).toBeVisible()

    let posted = false
    page.on('request', (req) => {
      if (req.url().includes(`/merge-pr/${MERGE_SLUG}`)) posted = true
    })
    page.once('dialog', (d) => d.dismiss())
    await mergeBtn.click()

    // The button must also come back enabled — a dismissed confirm returns
    // before mergeInFlight is ever touched, so nothing should be left
    // disabled.
    await expect(mergeBtn).toBeEnabled()
    expect(posted).toBe(false)
  })

  test("a failed merge surfaces its blockers in the card's own footer banner", async ({ page }) => {
    // The fixture REPOS_DIR has no real checkout for "cockpit-ai" (see
    // playwright.config.ts), so the merge fails deterministically and
    // offline. That failure is the point: mergePr persists its reason in
    // mergeBannerBySlug, and a merge fired from the board must render that
    // banner on the card rather than swallowing it — the detail panel's
    // Merge tab was previously the only surface that could show it.
    await withRestoredFixtureFiles(MERGE_SLUG, ['STATUS', 'TIMELINE'], async () => {
      await page.goto('/')
      const c = card(page, MERGE_SLUG)
      const mergeBtn = c.getByTestId('card-merge-pr-btn')
      await expect(mergeBtn).toBeVisible()

      page.once('dialog', (d) => d.accept())
      await mergeBtn.click()

      const banner = c.getByTestId('merge-banner')
      await expect(banner).toBeVisible()
      await expect(banner).toHaveAttribute('data-tone', 'error')
      await expect(banner.getByTestId('merge-banner-line').first()).toBeVisible()

      // And the button is released once the request settles — mergeInFlight
      // is cleared in mergePr's own finally, and the board re-renders from
      // it.
      await expect(mergeBtn).toBeEnabled()
    })
  })
})
