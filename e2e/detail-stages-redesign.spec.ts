import { test, expect } from '@playwright/test'

// M2 of the pipelinely redesign: the /task/<slug> detail page takes on the
// Cockpit Stages design language, and its stage stepper gains the one
// genuinely new behaviour in this redesign — a wide stepper on desktop that
// collapses to a compact prev/next stepper on narrow viewports.
//
// Which stepper is visible is a CSS media-query decision, not a JS
// matchMedia listener (see tech-design.md): both are always in the DOM.
// That is why the cases below assert visibility rather than presence — a
// hidden-but-present compact stepper on desktop is correct, not a bug.
//
// dev-ready is the fixture used throughout: a flat task. Its stepper folds
// Plan Review into Planning, CR fixes into CR and QA fixes into QA (see
// STAGE_CHAIN_GROUPS/renderStageChain in public/index.html), so its visible
// chain has five nodes — Planning, Dev, CR, QA, Merge — not eight, and it
// defaults to the Dev tab on a fresh open (see defaultL2Tab), which is node
// 2 of 5 — far enough from either end that prev and next are both live.
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).

test.use({ colorScheme: 'light' })

const SLUG = 'dev-ready'
const STAGE_COUNT = 5
// Visible chain order after folding: Planning(+Plan Review), Dev,
// CR(+CR fixes), QA(+QA fixes), Merge — mirrors taskParser.ts's real
// dispatch sequence (STAGE_SKILL / NEXT_STAGE_BY_WAITING_REASON both put
// code-review before qa). Dev is index 1, so a fresh open reads 2/5.
const DEFAULT_POSITION = `2/${STAGE_COUNT}`

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

test.describe('stepper — desktop', () => {
  test.use({ viewport: DESKTOP })

  test('the wide stepper is shown and the compact one is not', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    await expect(page.getByTestId('stepper-wide')).toBeVisible()
    await expect(page.getByTestId('stepper-compact')).toBeHidden()
  })

  // M4 (tech-design.md, D15) took the rail's own per-node state line off —
  // a node now carries only its circle and label; the selected stage's own
  // recorded outcome moved to the panel header's meta line instead.
  test('every node carries a label and no state line', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.getByTestId('stage-node-data')).toHaveCount(0)
    await expect(wide.locator('.stage-chain-data')).toHaveCount(0)
    await expect(wide.getByTestId('stage-chain-dev').locator('.stage-chain-name')).toHaveText('Dev')
  })

  test('clicking a node still selects that stage and syncs the URL', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    // The Planning node folds in Plan Review — dev-ready's TIMELINE reached
    // plan-review most recently within that group, so clicking Planning
    // routes into the plan-review sub-tab it represents.
    await page.getByTestId('stepper-wide').getByTestId('stage-chain-planning').click()

    await expect(page).toHaveURL(`/task/${SLUG}?stage=plan-review`)
    await expect(page.getByTestId('tech-design-body')).toBeVisible()
  })
})

test.describe('stepper — mobile', () => {
  test.use({ viewport: MOBILE })

  test('the compact stepper is shown and the wide one is not', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    await expect(page.getByTestId('stepper-compact')).toBeVisible()
    await expect(page.getByTestId('stepper-wide')).toBeHidden()
  })

  test('the compact stepper names the selected stage and its position in the chain', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    await expect(page.getByTestId('stepper-position')).toHaveText(DEFAULT_POSITION)
  })

  test('next advances one stage and updates the URL and position together', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)
    await expect(page.getByTestId('stepper-position')).toHaveText(DEFAULT_POSITION)

    await page.getByTestId('stepper-next').click()

    // dev -> cr, not dev -> qa: code-review is the stage right after dev in
    // the real pipeline (see MILESTONE_CHAIN_STAGES/STAGE_SKILL) — qa only
    // comes later, after cr and cr-fixes.
    await expect(page).toHaveURL(`/task/${SLUG}?stage=cr`)
    await expect(page.getByTestId('stepper-position')).toHaveText(`3/${STAGE_COUNT}`)
  })

  test('prev steps back one stage', async ({ page }) => {
    await page.goto(`/task/${SLUG}?stage=cr`)
    await expect(page.getByTestId('stepper-position')).toHaveText(`3/${STAGE_COUNT}`)

    await page.getByTestId('stepper-prev').click()

    await expect(page).toHaveURL(`/task/${SLUG}?stage=dev`)
    await expect(page.getByTestId('stepper-position')).toHaveText(DEFAULT_POSITION)
  })

  // Failure path: at the first stage there is nowhere to go back to. The
  // button must be disabled rather than silently wrapping around or
  // throwing on an out-of-range index.
  test('prev is disabled on the first stage and clicking it changes nothing', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(`/task/${SLUG}?stage=planning`)
    await expect(page.getByTestId('stepper-position')).toHaveText(`1/${STAGE_COUNT}`)

    const prev = page.getByTestId('stepper-prev')
    await expect(prev).toBeDisabled()
    await prev.click({ force: true })

    await expect(page.getByTestId('stepper-position')).toHaveText(`1/${STAGE_COUNT}`)
    await expect(page).toHaveURL(`/task/${SLUG}?stage=planning`)
    expect(pageErrors).toEqual([])
  })

  // Same failure path at the other end of the chain.
  test('next is disabled on the last stage and clicking it changes nothing', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(`/task/${SLUG}?stage=merge`)
    await expect(page.getByTestId('stepper-position')).toHaveText(`${STAGE_COUNT}/${STAGE_COUNT}`)

    const next = page.getByTestId('stepper-next')
    await expect(next).toBeDisabled()
    await next.click({ force: true })

    await expect(page.getByTestId('stepper-position')).toHaveText(`${STAGE_COUNT}/${STAGE_COUNT}`)
    await expect(page).toHaveURL(`/task/${SLUG}?stage=merge`)
    expect(pageErrors).toEqual([])
  })
})

test.describe('stage panel footer', () => {
  test.use({ viewport: DESKTOP })

  // M4 (tech-design.md, D7) replaced the eyebrow+hint CTA bar with the
  // design's own full-bleed footer band — buttons only, no copy.
  test('the selected stage renders a footer with its primary action', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    const footer = page.getByTestId('detail-panel-footer')
    await expect(footer).toBeVisible()
    // dev-ready's live action is the Dev tab's own "Start Dev" button,
    // which keeps its existing l2-cta testid as the footer's primary.
    await expect(footer.getByTestId('l2-cta')).toBeVisible()
    await expect(footer.getByTestId('l2-cta')).toBeEnabled()
  })

  // A stage whose action is not currently available must still show the
  // button, disabled — the design's greyed primary. Rendering nothing there
  // would leave the footer looking broken and lose the affordance's own
  // explanation of why it can't run.
  test('a stage whose action is unavailable shows its CTA disabled, not missing', async ({ page }) => {
    await page.goto(`/task/${SLUG}?stage=plan-review`)

    const footer = page.getByTestId('detail-panel-footer')
    await expect(footer).toBeVisible()
    const cta = footer.getByTestId('plan-review-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
  })

  test('the footer is present on the compact/mobile layout too', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto(`/task/${SLUG}`)

    await expect(page.getByTestId('detail-panel-footer')).toBeVisible()
  })
})

test.describe('detail head', () => {
  test.use({ viewport: DESKTOP })

  // M4 (tech-design.md, D9) replaced the meta row's pills/branch/stats with
  // the design's own four mono pairs — branch is no longer shown here.
  test('the head shows the task title, its status, and the design\'s meta row', async ({ page }) => {
    await page.goto(`/task/${SLUG}`)

    await expect(page.locator('#detail-title')).not.toBeEmpty()
    await expect(page.getByTestId('detail-status-line')).not.toBeEmpty()
    const meta = page.getByTestId('detail-meta')
    await expect(meta).toBeVisible()
    await expect(meta.getByTestId('detail-meta-label')).toHaveText(['tok', 'cost', 'sessions', 'model'])
  })
})
